// server.js
import express from "express";
import cors from "cors";
import crypto from "crypto";
import {
  getUser,
  upsertUser,
  getLicense,
  createLicense,
  bindLicenseToUser,
  getActiveLicenseForUser,
  markPaymentOnce,
  getStats
} from "./db.js";
import { mpPayment, mpPreference } from "./mercadopago_client.js";

const app = express();

// importante em produção atrás do Render/Cloudflare
app.set("trust proxy", 1);

// ---------- CORS (produção) ----------
function parseAllowlist() {
  const raw = String(process.env.ORIGIN_ALLOWLIST || "").trim();
  if (!raw) return { any: true, list: [], allowChromeExtAny: true }; // fallback dev
  const list = raw.split(",").map(s => s.trim()).filter(Boolean);
  const allowChromeExtAny = list.includes("chrome-extension://*");
  const any = list.includes("*");
  return { any, list, allowChromeExtAny };
}

const allow = parseAllowlist();

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // curl/server-to-server
    if (allow.any) return cb(null, true);
    if (allow.allowChromeExtAny && origin.startsWith("chrome-extension://")) return cb(null, true);

    const ok = allow.list.includes(origin);
    return cb(ok ? null : new Error("CORS blocked"), ok);
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.options("*", cors());
app.use(express.json({ limit: "512kb" }));

// ---------- Helpers ----------
function serverTimeMs() { return Date.now(); }
function daysMs(d) { return d * 24 * 60 * 60 * 1000; }
function periodToDays(period) {
  return String(period || "").toLowerCase() === "yearly" ? 365 : 30;
}
function normalizePlan(plan) {
  const p = String(plan || "").toLowerCase();
  return p === "basic" || p === "pro" ? p : "pro";
}
function normalizePeriod(period) {
  return String(period || "").toLowerCase() === "yearly" ? "yearly" : "monthly";
}
function readMoneyEnv(key, fallback) {
  const raw = String(process.env[key] || "").trim();
  if (!raw) return fallback;
  const n = Number(raw.replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
const PRICE_DEFAULTS = {
  basic_monthly: 14.99,
  basic_yearly: 119.88,
  pro_monthly: 19.99,
  pro_yearly: 179.88
};
function getPrice(plan, period) {
  const p = normalizePlan(plan);
  const per = normalizePeriod(period);
  const envKey = `MP_PRICE_${p.toUpperCase()}_${per.toUpperCase()}`;
  const fallback = PRICE_DEFAULTS[`${p}_${per}`];
  return readMoneyEnv(envKey, fallback);
}
function getPublicBaseUrl(req) {
  const base = String(process.env.PUBLIC_BASE_URL || "").trim();
  if (base) return base.replace(/\/+$/, "");
  return `https://${req.get("host")}`;
}
function buildExternalReference(meta) {
  return JSON.stringify(meta);
}
function parseExternalReference(ref) {
  if (!ref) return {};
  const raw = String(ref);
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    const parts = raw.split("|");
    if (parts.length >= 3) {
      return { boundUserKey: parts[0], plan: parts[1], period: parts[2] };
    }
  }
  return {};
}

function getTrialDays() {
  const d = Number(process.env.TRIAL_DAYS ?? "7");
  if (Number.isFinite(d) && d >= 0) return d;
  return 7;
}

async function ensureTrialForUser(boundUserKey, boundUserLabel) {
  const existing = await getUser(boundUserKey);
  if (existing?.trialStartedAt && existing?.trialEndsAt != null) return existing;

  const now = serverTimeMs();
  const ends = now + daysMs(getTrialDays());
  return await upsertUser(boundUserKey, {
    boundUserLabel: boundUserLabel || null,
    trialStartedAt: now,
    trialEndsAt: ends
  });
}

async function computeStatus(boundUserKey, licenseKey) {
  const now = serverTimeMs();
  const u = await getUser(boundUserKey) || null;

  const trialEndsAtMs = u?.trialEndsAt ?? null;
  const trialActive = !!trialEndsAtMs && trialEndsAtMs > now;

  let lic = null;

  // se veio uma chave explícita, usa ela; senão tenta por usuário (compra automática via webhook)
  if (licenseKey) lic = await getLicense(licenseKey);
  else lic = await getActiveLicenseForUser(boundUserKey, now);

  const licenseActive = !!lic?.endsAtMs && lic.endsAtMs > now && lic.status === "active";
  const plan = lic?.plan || null;

  return {
    serverTimeMs: now,
    trial: { active: trialActive, endsAtMs: trialEndsAtMs },
    license: { active: licenseActive, endsAtMs: lic?.endsAtMs || null, plan }
  };
}

async function processPayment(payment, { force = false } = {}) {
  const paymentId = payment?.id || null;
  if (!paymentId) return { ok: false, reason: "missing_payment_id" };

  const status = String(payment?.status || "").toLowerCase();
  if (status !== "approved") return { ok: true, ignored: "not_approved", status };

  const meta = payment?.metadata || {};
  const ref = parseExternalReference(payment?.external_reference);
  const boundUserKey = meta.boundUserKey || meta.bound_user_key || ref.boundUserKey || ref.bound_user_key || null;
  if (!boundUserKey) return { ok: false, reason: "missing_boundUserKey" };

  const plan = normalizePlan(meta.plan || ref.plan || "pro");
  const period = normalizePeriod(meta.period || ref.period || "monthly");

  if (!force) {
    const marked = await markPaymentOnce(`mp:${paymentId}`, {
      type: "mercadopago.payment.approved",
      ts: serverTimeMs(),
      boundUserKey,
      plan,
      period,
      sessionId: String(paymentId)
    });
    if (!marked) return { ok: true, duplicate: true };
  }

  const endsAtMs = serverTimeMs() + daysMs(periodToDays(period));
  const licenseKey = crypto.randomBytes(10).toString("hex").toUpperCase();
  await createLicense(licenseKey, {
    status: "active",
    plan,
    endsAtMs,
    boundUserKey,
    stripe: { sessionId: `mp:${paymentId}`, period }
  });

  await ensureTrialForUser(boundUserKey, null);
  return { ok: true, licenseKey };
}

// ---------- Mercado Pago webhook ----------
app.post("/api/webhook/mercadopago", async (req, res) => {
  if (!mpPayment) return res.status(400).send("Mercado Pago not configured.");

  const body = req.body || {};
  const query = req.query || {};
  const eventType = String(body.type || body.topic || query.type || query.topic || "").toLowerCase();
  const paymentId =
    body?.data?.id ||
    body?.id ||
    query?.id ||
    query?.["data.id"] ||
    query?.["data[id]"];

  if (eventType && eventType !== "payment") {
    return res.json({ received: true, ignored: "not_payment" });
  }
  if (!paymentId) return res.json({ received: true, ignored: "missing_payment_id" });

  try {
    const resp = await mpPayment.get({ id: paymentId });
    const payment = resp?.body || resp;
    const result = await processPayment(payment);
    return res.json({ received: true, ...result });
  } catch (err) {
    return res.status(500).send(`Webhook handler error: ${err?.message || err}`);
  }
});

// ---------- Admin auth ----------
function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function requireAdmin(req, res, next) {
  const key = String(process.env.ADMIN_API_KEY || "").trim();
  if (!key) return res.status(403).json({ error: "admin_disabled" });

  const auth = String(req.get("authorization") || "");
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const q = String(req.query.key || req.query.adminKey || "").trim();

  const provided = bearer || q;
  if (!provided) return res.status(401).json({ error: "missing_admin_key" });
  if (!safeEqual(provided, key)) return res.status(403).json({ error: "bad_admin_key" });

  return next();
}

// ---------- Rotas úteis ----------
app.get("/healthz", (req, res) => res.json({ ok: true, ts: serverTimeMs() }));

// -------- API --------
app.post("/api/auth/bind", async (req, res) => {
  const { boundUserKey, boundUserLabel } = req.body || {};
  if (!boundUserKey) return res.status(400).json({ error: "missing boundUserKey" });

  await ensureTrialForUser(boundUserKey, boundUserLabel);
  return res.json(await computeStatus(boundUserKey, null));
});

app.post("/api/trial/status", async (req, res) => {
  const { boundUserKey } = req.body || {};
  if (!boundUserKey) return res.status(400).json({ error: "missing boundUserKey" });

  const u = await getUser(boundUserKey);
  if (!u) return res.status(404).json({ error: "not_found" });

  return res.json(await computeStatus(boundUserKey, null));
});

app.post("/api/license/verify", async (req, res) => {
  const { boundUserKey, licenseKey } = req.body || {};
  if (!boundUserKey) return res.status(400).json({ error: "missing boundUserKey" });
  if (!licenseKey) return res.status(400).json({ error: "missing licenseKey" });

  await ensureTrialForUser(boundUserKey, null);

  const lic = await getLicense(licenseKey);
  if (!lic) return res.status(404).json({ error: "license_not_found" });

  if (lic.boundUserKey && lic.boundUserKey !== boundUserKey) {
    return res.status(403).json({ error: "license_bound_to_other_user" });
  }

  if (!lic.boundUserKey) await bindLicenseToUser(licenseKey, boundUserKey);

  return res.json(await computeStatus(boundUserKey, licenseKey));
});

// -------- Checkout --------
app.get("/buy", async (req, res) => {
  try {
    const { boundUserKey } = req.query || {};
    if (!boundUserKey) return res.status(400).send("Missing boundUserKey");

    if (!mpPreference) {
      return res.status(200).send(`
        <h2>Checkout desativado (Mercado Pago não configurado)</h2>
        <p>Configure MERCADOPAGO_ACCESS_TOKEN no .env.</p>
      `);
    }

    const plan = normalizePlan(req.query?.plan || "pro");
    const period = normalizePeriod(req.query?.period || "monthly");
    const amount = getPrice(plan, period);
    const baseUrl = getPublicBaseUrl(req);
    const labelPlan = plan === "basic" ? "Básico" : "Pro";
    const labelPeriod = period === "yearly" ? "1 ano" : "30 dias";

    const externalReference = buildExternalReference({
      boundUserKey: String(boundUserKey),
      plan,
      period
    });

    const preference = await mpPreference.create({
      body: {
        items: [
          {
            id: `suap-pgd2-${plan}-${period}`,
            title: `SUAP PGD2 PIT/RIT ${labelPlan} - ${labelPeriod}`,
            quantity: 1,
            currency_id: "BRL",
            unit_price: amount
          }
        ],
        auto_return: "approved",
        back_urls: {
          success: `${baseUrl}/success`,
          pending: `${baseUrl}/pending`,
          failure: `${baseUrl}/cancel`
        },
        notification_url: `${baseUrl}/api/webhook/mercadopago`,
        external_reference: externalReference,
        metadata: { boundUserKey: String(boundUserKey), plan, period }
      }
    });

    const initPoint =
      preference?.body?.init_point ||
      preference?.init_point ||
      preference?.body?.sandbox_init_point ||
      preference?.sandbox_init_point;

    if (!initPoint) return res.status(500).send("Buy error: missing Mercado Pago init_point.");
    return res.redirect(303, initPoint);
  } catch (err) {
    console.error("BUY_ERROR", err);
    return res.status(500).send("Buy error: " + (err?.message || err));
  }
});

app.get("/success", (req, res) => {
  res.status(200).send(`
    <h2>Pagamento iniciado</h2>
    <p>Assim que o Mercado Pago confirmar, sua licença será ativada automaticamente no backend.</p>
    <p>Volte ao Chrome e clique em "Verificar status".</p>
  `);
});

app.get("/pending", (req, res) => {
  res.status(200).send(`
    <h2>Pagamento pendente</h2>
    <p>Assim que o Mercado Pago confirmar, sua licença será ativada automaticamente no backend.</p>
    <p>Volte ao Chrome e clique em "Verificar status".</p>
  `);
});

app.get("/cancel", (req, res) => res.status(200).send("<h2>Cancelado</h2>"));

// -------- Admin: reprocessar pagamento --------
app.get("/admin/replay-payment", requireAdmin, async (req, res) => {
  const paymentId = String(req.query.paymentId || "").trim();
  const force = String(req.query.force || "").trim() === "1";
  if (!paymentId) return res.status(400).json({ error: "missing_paymentId" });
  if (!mpPayment) return res.status(400).json({ error: "mercadopago_not_configured" });

  try {
    const resp = await mpPayment.get({ id: paymentId });
    const payment = resp?.body || resp;
    const result = await processPayment(payment, { force });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err?.message || String(err) });
  }
});

// -------- Seed (manual) - PROTEGIDO --------
app.get("/admin/create-license", requireAdmin, async (req, res) => {
  const { plan = "pro", days = "30" } = req.query || {};
  const d = Number(days);
  const now = serverTimeMs();
  const endsAtMs = now + daysMs(Number.isFinite(d) ? d : 30);
  const licenseKey = crypto.randomBytes(10).toString("hex").toUpperCase();

  await createLicense(licenseKey, { status: "active", plan, endsAtMs, boundUserKey: null });
  return res.json({ licenseKey, plan, endsAtMs });
});

app.get("/admin/stats", requireAdmin, async (req, res) => {
  const now = serverTimeMs();
  const stats = await getStats(now);
  return res.json({ nowMs: now, ...stats });
});

const port = Number(process.env.PORT || "8787");
app.listen(port, () => console.log("License backend listening on", port));

