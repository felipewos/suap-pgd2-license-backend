// db.js - JSON fallback or Postgres (DATABASE_URL)
import fs from "fs";
import path from "path";
import { Pool } from "pg";

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), "db.json");
const DATABASE_URL = process.env.DATABASE_URL || "";
const usePostgres = Boolean(DATABASE_URL);

let pool = null;
let initPromise = null;

function load() {
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
  } catch {
    return { users: {}, licenses: {}, payments: {} };
  }
}

function save(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf-8");
}

function pgSslConfig() {
  const mode = String(process.env.PGSSLMODE || "").toLowerCase();
  if (mode === "disable") return false;
  return { rejectUnauthorized: false };
}

async function ensurePg() {
  if (!usePostgres) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    pool = new Pool({ connectionString: DATABASE_URL, ssl: pgSslConfig() });

    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        bound_user_key TEXT PRIMARY KEY,
        bound_user_label TEXT,
        trial_started_at BIGINT,
        trial_ends_at BIGINT
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS licenses (
        license_key TEXT PRIMARY KEY,
        status TEXT,
        plan TEXT,
        ends_at_ms BIGINT,
        bound_user_key TEXT,
        stripe_session_id TEXT,
        stripe_subscription_id TEXT,
        stripe_customer_id TEXT,
        stripe_period TEXT
      );
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS licenses_bound_user_key_idx
      ON licenses (bound_user_key);
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS payments (
        payment_key TEXT PRIMARY KEY,
        type TEXT,
        ts BIGINT,
        bound_user_key TEXT,
        plan TEXT,
        period TEXT,
        session_id TEXT,
        subscription_id TEXT,
        customer_id TEXT,
        invoice_id TEXT,
        payload JSONB
      );
    `);
  })();

  return initPromise;
}

function mapUserRow(row) {
  if (!row) return null;
  return {
    boundUserLabel: row.bound_user_label ?? null,
    trialStartedAt: row.trial_started_at != null ? Number(row.trial_started_at) : null,
    trialEndsAt: row.trial_ends_at != null ? Number(row.trial_ends_at) : null
  };
}

function mapLicenseRow(row) {
  if (!row) return null;
  return {
    status: row.status ?? null,
    plan: row.plan ?? null,
    endsAtMs: row.ends_at_ms != null ? Number(row.ends_at_ms) : null,
    boundUserKey: row.bound_user_key ?? null,
    stripe: {
      sessionId: row.stripe_session_id ?? null,
      subscriptionId: row.stripe_subscription_id ?? null,
      customerId: row.stripe_customer_id ?? null,
      period: row.stripe_period ?? null
    }
  };
}

export async function upsertUser(boundUserKey, patch) {
  if (!usePostgres) {
    const db = load();
    db.users[boundUserKey] = { ...(db.users[boundUserKey] || {}), ...patch };
    save(db);
    return db.users[boundUserKey];
  }

  await ensurePg();
  const label = patch.boundUserLabel ?? null;
  const trialStartedAt = patch.trialStartedAt ?? null;
  const trialEndsAt = patch.trialEndsAt ?? null;

  const res = await pool.query(
    `
      INSERT INTO users (bound_user_key, bound_user_label, trial_started_at, trial_ends_at)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (bound_user_key) DO UPDATE SET
        bound_user_label = EXCLUDED.bound_user_label,
        trial_started_at = EXCLUDED.trial_started_at,
        trial_ends_at = EXCLUDED.trial_ends_at
      RETURNING *;
    `,
    [boundUserKey, label, trialStartedAt, trialEndsAt]
  );

  return mapUserRow(res.rows[0]);
}

export async function getUser(boundUserKey) {
  if (!usePostgres) {
    const db = load();
    return db.users[boundUserKey] || null;
  }

  await ensurePg();
  const res = await pool.query(
    "SELECT bound_user_label, trial_started_at, trial_ends_at FROM users WHERE bound_user_key = $1",
    [boundUserKey]
  );
  return mapUserRow(res.rows[0]);
}

export async function createLicense(licenseKey, data) {
  if (!usePostgres) {
    const db = load();
    db.licenses[licenseKey] = { ...(db.licenses[licenseKey] || {}), ...data };
    save(db);
    return db.licenses[licenseKey];
  }

  await ensurePg();
  const stripe = data?.stripe || {};

  const res = await pool.query(
    `
      INSERT INTO licenses (
        license_key, status, plan, ends_at_ms, bound_user_key,
        stripe_session_id, stripe_subscription_id, stripe_customer_id, stripe_period
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (license_key) DO UPDATE SET
        status = EXCLUDED.status,
        plan = EXCLUDED.plan,
        ends_at_ms = EXCLUDED.ends_at_ms,
        bound_user_key = EXCLUDED.bound_user_key,
        stripe_session_id = EXCLUDED.stripe_session_id,
        stripe_subscription_id = EXCLUDED.stripe_subscription_id,
        stripe_customer_id = EXCLUDED.stripe_customer_id,
        stripe_period = EXCLUDED.stripe_period
      RETURNING *;
    `,
    [
      licenseKey,
      data?.status ?? null,
      data?.plan ?? null,
      data?.endsAtMs ?? null,
      data?.boundUserKey ?? null,
      stripe.sessionId ?? null,
      stripe.subscriptionId ?? null,
      stripe.customerId ?? null,
      stripe.period ?? null
    ]
  );

  return mapLicenseRow(res.rows[0]);
}

export async function getLicense(licenseKey) {
  if (!usePostgres) {
    const db = load();
    return db.licenses[licenseKey] || null;
  }

  await ensurePg();
  const res = await pool.query("SELECT * FROM licenses WHERE license_key = $1", [licenseKey]);
  return mapLicenseRow(res.rows[0]);
}

export async function bindLicenseToUser(licenseKey, boundUserKey) {
  if (!usePostgres) {
    const db = load();
    const lic = db.licenses[licenseKey];
    if (!lic) return null;
    lic.boundUserKey = boundUserKey;
    save(db);
    return lic;
  }

  await ensurePg();
  const res = await pool.query(
    "UPDATE licenses SET bound_user_key = $1 WHERE license_key = $2 RETURNING *",
    [boundUserKey, licenseKey]
  );
  return mapLicenseRow(res.rows[0]);
}

export async function getActiveLicenseForUser(boundUserKey, nowMs = Date.now()) {
  if (!boundUserKey) return null;

  if (!usePostgres) {
    const db = load();
    let best = null;

    const scorePlan = (plan) => (String(plan || "").toLowerCase() === "pro" ? 1 : 0);

    for (const [licenseKey, lic] of Object.entries(db.licenses || {})) {
      if (!lic) continue;
      if (lic.boundUserKey !== boundUserKey) continue;
      if (lic.status !== "active") continue;
      if (!lic.endsAtMs || lic.endsAtMs <= nowMs) continue;

      if (
        !best ||
        scorePlan(lic.plan) > scorePlan(best.plan) ||
        (scorePlan(lic.plan) === scorePlan(best.plan) && lic.endsAtMs > best.endsAtMs)
      ) {
        best = { licenseKey, ...lic };
      }
    }

    return best;
  }

  await ensurePg();
  const res = await pool.query(
    `
      SELECT * FROM licenses
      WHERE bound_user_key = $1
        AND status = 'active'
        AND ends_at_ms > $2
      ORDER BY
        CASE WHEN lower(plan) = 'pro' THEN 1 ELSE 0 END DESC,
        ends_at_ms DESC
      LIMIT 1;
    `,
    [boundUserKey, nowMs]
  );

  if (!res.rows[0]) return null;
  return { licenseKey: res.rows[0].license_key, ...mapLicenseRow(res.rows[0]) };
}

export async function markPaymentOnce(paymentKey, payload) {
  if (!usePostgres) {
    const db = load();
    db.payments = db.payments || {};
    if (db.payments[paymentKey]) return false;
    db.payments[paymentKey] = payload;
    save(db);
    return true;
  }

  await ensurePg();
  const p = payload || {};
  const res = await pool.query(
    `
      INSERT INTO payments (
        payment_key, type, ts, bound_user_key, plan, period,
        session_id, subscription_id, customer_id, invoice_id, payload
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (payment_key) DO NOTHING;
    `,
    [
      paymentKey,
      p.type ?? null,
      p.ts ?? null,
      p.boundUserKey ?? null,
      p.plan ?? null,
      p.period ?? null,
      p.sessionId ?? null,
      p.subscriptionId ?? null,
      p.customerId ?? null,
      p.invoiceId ?? null,
      p
    ]
  );

  return res.rowCount === 1;
}

export async function getStats(nowMs = Date.now()) {
  if (!usePostgres) {
    const db = load();
    const users = db.users || {};
    const licenses = db.licenses || {};

    const usersTotal = Object.keys(users).length;
    let trialActiveUsers = 0;
    for (const u of Object.values(users)) {
      if (u?.trialEndsAt && u.trialEndsAt > nowMs) trialActiveUsers++;
    }

    const activeLicenses = Object.entries(licenses).filter(([, lic]) =>
      lic?.status === "active" && lic?.endsAtMs && lic.endsAtMs > nowMs
    );
    const licensesTotal = Object.keys(licenses).length;
    const licensesActive = activeLicenses.length;
    const paidActiveUsers = new Set(activeLicenses.map(([, lic]) => lic.boundUserKey).filter(Boolean)).size;

    const byPlan = activeLicenses.reduce((acc, [, lic]) => {
      const p = String(lic?.plan || "unknown").toLowerCase();
      acc[p] = (acc[p] || 0) + 1;
      return acc;
    }, {});

    return {
      usersTotal,
      trialActiveUsers,
      paidActiveUsers,
      licensesTotal,
      licensesActive,
      licensesActiveByPlan: byPlan
    };
  }

  await ensurePg();

  const usersTotalRes = await pool.query("SELECT COUNT(*) AS c FROM users");
  const trialActiveRes = await pool.query(
    "SELECT COUNT(*) AS c FROM users WHERE trial_ends_at > $1",
    [nowMs]
  );
  const licensesTotalRes = await pool.query("SELECT COUNT(*) AS c FROM licenses");
  const licensesActiveRes = await pool.query(
    "SELECT COUNT(*) AS c FROM licenses WHERE status = 'active' AND ends_at_ms > $1",
    [nowMs]
  );
  const paidUsersRes = await pool.query(
    "SELECT COUNT(DISTINCT bound_user_key) AS c FROM licenses WHERE status = 'active' AND ends_at_ms > $1 AND bound_user_key IS NOT NULL",
    [nowMs]
  );
  const byPlanRes = await pool.query(
    "SELECT lower(coalesce(plan, 'unknown')) AS plan, COUNT(*) AS c FROM licenses WHERE status = 'active' AND ends_at_ms > $1 GROUP BY 1",
    [nowMs]
  );

  const byPlan = {};
  for (const row of byPlanRes.rows) {
    byPlan[row.plan] = Number(row.c);
  }

  return {
    usersTotal: Number(usersTotalRes.rows[0]?.c || 0),
    trialActiveUsers: Number(trialActiveRes.rows[0]?.c || 0),
    paidActiveUsers: Number(paidUsersRes.rows[0]?.c || 0),
    licensesTotal: Number(licensesTotalRes.rows[0]?.c || 0),
    licensesActive: Number(licensesActiveRes.rows[0]?.c || 0),
    licensesActiveByPlan: byPlan
  };
}
