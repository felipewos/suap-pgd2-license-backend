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
  markPaymentOnce
} from "./db.js";
import { stripe } from "./stripe_client.js";

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

// ---------- Helpers ----------
function serverTimeMs() { return Date.now(); }
function daysMs(d) { return d * 24 * 60 * 60 * 1000; }

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

// ---------- Stripe webhook (RAW antes do JSON) ----------
app.post("/api/webhook/stripe", express.raw({ type: "application/json" }), async (req, res) => {
  if (!stripe) return res.status(400).send("Stripe not configured.");

  const sig = req.headers["stripe-signature"];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return res.status(400).send("Missing STRIPE_WEBHOOK_SECRET");
  if (!sig) return res.status(400).send("Missing stripe-signature header");

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    // idempotência simples no db.json (evita duplicar licenças em retries)

    // 1) checkout concluído (primeira compra)
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      const sessionId = session.id;
      const boundUserKey = session.metadata?.boundUserKey;
      const plan = session.metadata?.plan || "pro";
      const period = session.metadata?.period || null;
      const subscriptionId = session.subscription || null;
      const customerId = session.customer || null;

      if (!boundUserKey) return res.json({ received: true, ignored: "missing boundUserKey" });

      if (!await markPaymentOnce(`cs:${sessionId}`, {
        type: "checkout.session.completed",
        ts: serverTimeMs(),
        boundUserKey,
        plan,
        period,
        sessionId,
        subscriptionId,
        customerId
      })) {
        return res.json({ received: true, duplicate: true });
      }

      let endsAtMs = serverTimeMs() + daysMs(30);
      if (subscriptionId) {
        try {
          const sub = await stripe.subscriptions.retrieve(subscriptionId);
          if (sub?.current_period_end) endsAtMs = sub.current_period_end * 1000;
        } catch { /* ignore */ }
      }

      const licenseKey = crypto.randomBytes(10).toString("hex").toUpperCase();
      await createLicense(licenseKey, {
        status: "active",
        plan,
        endsAtMs,
        boundUserKey,
        stripe: { sessionId, subscriptionId, customerId, period }
      });

      await ensureTrialForUser(boundUserKey, null);
      return res.json({ received: true });
    }

    // 2) pagamento recorrente ok (renovação)
    if (event.type === "invoice.payment_succeeded") {
      const invoice = event.data.object;
      const invoiceId = invoice.id;
      const subscriptionId = invoice.subscription || null;

      if (!await markPaymentOnce(`in:${invoiceId}`, {
        type: "invoice.payment_succeeded",
        ts: serverTimeMs(),
        invoiceId,
        subscriptionId
      })) {
        return res.json({ received: true, duplicate: true });
      }

      if (!subscriptionId) return res.json({ received: true, ignored: "no subscription" });

      let sub;
      try {
        sub = await stripe.subscriptions.retrieve(subscriptionId);
      } catch {
        return res.json({ received: true, ignored: "sub retrieve failed" });
      }

      const boundUserKey = sub?.metadata?.boundUserKey || null;
      const plan = sub?.metadata?.plan || "pro";
      const period = sub?.metadata?.period || null;
      const endsAtMs = sub?.current_period_end ? sub.current_period_end * 1000 : null;

      if (!boundUserKey || !endsAtMs) return res.json({ received: true, ignored: "missing metadata/endsAt" });

      const now = serverTimeMs();
      const best = await getActiveLicenseForUser(boundUserKey, now);

      if (best?.licenseKey) {
        await createLicense(best.licenseKey, {
          status: "active",
          plan,
          endsAtMs,
          boundUserKey,
          stripe: { subscriptionId, customerId: sub.customer || null, period }
        });
      } else {
        const licenseKey = crypto.randomBytes(10).toString("hex").toUpperCase();
        await createLicense(licenseKey, {
          status: "active",
          plan,
          endsAtMs,
          boundUserKey,
          stripe: { subscriptionId, customerId: sub.customer || null, period }
        });
      }
      await ensureTrialForUser(boundUserKey, null);
      return res.json({ received: true });
    }

    return res.json({ received: true });
  } catch (e) {
    return res.status(500).send(`Webhook handler error: ${e?.message || e}`);
  }
});

// depois do webhook, pode JSON normal
app.use(express.json({ limit: "512kb" }));

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
    const { boundUserKey, plan = "pro", period = "monthly" } = req.query || {};
    if (!boundUserKey) return res.status(400).send("Missing boundUserKey");

    if (!stripe) {
      return res.status(200).send(`
        <h2>Checkout desativado (Stripe não configurado)</h2>
        <p>Configure STRIPE_SECRET_KEY e os PRICE IDs no .env.</p>
      `);
    }

    const priceId =
      plan === "basic" && period === "monthly" ? process.env.STRIPE_PRICE_BASIC_MONTHLY :
      plan === "basic" && period === "yearly"  ? process.env.STRIPE_PRICE_BASIC_YEARLY  :
      plan === "pro"   && period === "yearly"  ? process.env.STRIPE_PRICE_PRO_YEARLY    :
      process.env.STRIPE_PRICE_PRO_MONTHLY;

    if (!priceId) return res.status(400).send("Missing Stripe price id for selected plan/period.");

    const baseUrl = `https://${req.get("host")}`;

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${baseUrl}/success`,
      cancel_url: `${baseUrl}/cancel`,
      subscription_data: {
        metadata: {
          boundUserKey: String(boundUserKey),
          plan: String(plan),
          period: String(period)
        }
      },
      metadata: {
        boundUserKey: String(boundUserKey),
        plan: String(plan),
        period: String(period)
      }
    });

    return res.redirect(303, session.url);
  } catch (err) {
    console.error("BUY_ERROR", err);
    return res.status(500).send("Buy error: " + (err?.message || err));
  }
});

app.get("/success", (req, res) => {
  res.status(200).send(`
    <h2>Pagamento iniciado</h2>
    <p>Assim que o Stripe confirmar, sua licença será ativada automaticamente no backend.</p>
    <p>Volte ao Chrome e clique em “Verificar status”.</p>
  `);
});

app.get("/cancel", (req, res) => res.status(200).send("<h2>Cancelado</h2>"));

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

const port = Number(process.env.PORT || "8787");
app.listen(port, () => console.log("License backend listening on", port));