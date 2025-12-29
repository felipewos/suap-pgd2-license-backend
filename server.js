// server.js
import express from "express";
import cors from "cors";
import crypto from "crypto";
import {
  getUser,
  upsertUser,
  getLicense,
  createLicense,
  bindLicenseToUser
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
    // requests sem Origin (curl/server-to-server)
    if (!origin) return cb(null, true);

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

function getTrialDays() {
  const d = Number(process.env.TRIAL_DAYS ?? "7");
  // permite 0 para expirar imediatamente
  if (Number.isFinite(d) && d >= 0) return d;
  return 7;
}

function ensureTrialForUser(boundUserKey, boundUserLabel) {
  const existing = getUser(boundUserKey);
  if (existing?.trialStartedAt && existing?.trialEndsAt != null) return existing;

  const now = serverTimeMs();
  const ends = now + getTrialDays() * 24 * 60 * 60 * 1000;
  return upsertUser(boundUserKey, {
    boundUserLabel: boundUserLabel || null,
    trialStartedAt: now,
    trialEndsAt: ends
  });
}

function computeStatus(boundUserKey, licenseKey) {
  const now = serverTimeMs();
  const u = getUser(boundUserKey) || null;

  const trialEndsAtMs = u?.trialEndsAt ?? null;
  const trialActive = !!trialEndsAtMs && trialEndsAtMs > now;

  let license = null;
  if (licenseKey) license = getLicense(licenseKey);

  const licenseActive = !!license?.endsAtMs && license.endsAtMs > now && license.status === "active";
  const plan = license?.plan || null;

  return {
    serverTimeMs: now,
    trial: { active: trialActive, endsAtMs: trialEndsAtMs },
    license: { active: licenseActive, endsAtMs: license?.endsAtMs || null, plan }
  };
}

// ---------- Stripe webhook precisa do RAW antes do JSON ----------
app.post("/api/webhook/stripe", express.raw({ type: "application/json" }), (req, res) => {
  if (!stripe) return res.status(400).send("Stripe not configured.");

  const sig = req.headers["stripe-signature"];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return res.status(400).send("Missing STRIPE_WEBHOOK_SECRET");

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const boundUserKey = session.metadata?.boundUserKey;
      const plan = session.metadata?.plan || "pro";

      // modelo simples: 30 dias a partir de agora (você pode evoluir depois para usar o período real)
      const now = serverTimeMs();
      const endsAtMs = now + 30 * 24 * 60 * 60 * 1000;
      const licenseKey = crypto.randomBytes(10).toString("hex").toUpperCase();

      createLicense(licenseKey, {
        status: "active",
        plan,
        endsAtMs,
        boundUserKey
      });

      if (boundUserKey) ensureTrialForUser(boundUserKey, null);
    }
  } catch (e) {
    console.error("WEBHOOK_PROCESSING_ERROR", e);
    // ainda retorna 200 para o Stripe não ficar retry infinito por erro interno eventual
  }

  return res.json({ received: true });
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

  // se não setar ADMIN_API_KEY no Render, admin fica DESLIGADO (seguro)
  if (!key) return res.status(403).json({ error: "admin_disabled" });

  const auth = String(req.get("authorization") || "");
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";

  // fallback para uso no navegador (menos recomendado): ?key=...
  const q = String(req.query.key || req.query.adminKey || "").trim();

  const provided = bearer || q;
  if (!provided) return res.status(401).json({ error: "missing_admin_key" });
  if (!safeEqual(provided, key)) return res.status(403).json({ error: "bad_admin_key" });

  return next();
}

// ---------- Rotas úteis ----------
app.get("/healthz", (req, res) => res.json({ ok: true, ts: serverTimeMs() }));

// -------- API --------
app.post("/api/auth/bind", (req, res) => {
  const { boundUserKey, boundUserLabel } = req.body || {};
  if (!boundUserKey) return res.status(400).json({ error: "missing boundUserKey" });

  ensureTrialForUser(boundUserKey, boundUserLabel);
  const status = computeStatus(boundUserKey, null);
  return res.json(status);
});

app.post("/api/trial/status", (req, res) => {
  const { boundUserKey } = req.body || {};
  if (!boundUserKey) return res.status(400).json({ error: "missing boundUserKey" });

  const u = getUser(boundUserKey);
  if (!u) return res.status(404).json({ error: "not_found" });

  const status = computeStatus(boundUserKey, null);
  return res.json(status);
});

app.post("/api/license/verify", (req, res) => {
  const { boundUserKey, licenseKey } = req.body || {};
  if (!boundUserKey) return res.status(400).json({ error: "missing boundUserKey" });
  if (!licenseKey) return res.status(400).json({ error: "missing licenseKey" });

  ensureTrialForUser(boundUserKey, null);

  const lic = getLicense(licenseKey);
  if (!lic) return res.status(404).json({ error: "license_not_found" });

  if (lic.boundUserKey && lic.boundUserKey !== boundUserKey) {
    return res.status(403).json({ error: "license_bound_to_other_user" });
  }

  if (!lic.boundUserKey) bindLicenseToUser(licenseKey, boundUserKey);

  const status = computeStatus(boundUserKey, licenseKey);
  return res.json(status);
});

// Rebind (se você ainda usar; se não usar, pode remover depois)
app.post("/api/auth/rebind", (req, res) => {
  const { newBoundUserKey, newBoundUserLabel, supportCode, licenseKey, confirmOk } = req.body || {};
  if (!newBoundUserKey) return res.status(400).json({ ok: false, error: "missing newBoundUserKey" });

  const supportOk = supportCode && supportCode === (process.env.SUPPORT_REBIND_CODE || "");
  let paidOk = false;

  if (!supportOk && licenseKey) {
    const lic = getLicense(licenseKey);
    const now = serverTimeMs();
    paidOk = !!lic && lic.status === "active" && lic.endsAtMs && lic.endsAtMs > now;
  }

  if (!(supportOk || (paidOk && confirmOk))) {
    return res.status(403).json({ ok: false, error: "not_allowed" });
  }

  ensureTrialForUser(newBoundUserKey, newBoundUserLabel || null);
  return res.json({ ok: true });
});

// -------- Checkout --------
app.get("/buy", async (req, res) => {
  try {
    const { boundUserKey, plan = "pro", period = "monthly" } = req.query || {};
    if (!boundUserKey) return res.status(400).send("Missing boundUserKey");

    if (!stripe) {
      return res.status(200).send(`
        <h2>Checkout desativado (Stripe não configurado)</h2>
        <p>Configure STRIPE_SECRET_KEY e os PRICE IDs no .env, ou gere licenças manualmente.</p>
        <p>Para gerar licença manual: rode <code>npm run seed</code> e use a chave gerada no popup.</p>
      `);
    }

    const priceId =
      plan === "basic" && period === "monthly" ? process.env.STRIPE_PRICE_BASIC_MONTHLY :
      plan === "basic" && period === "yearly"  ? process.env.STRIPE_PRICE_BASIC_YEARLY  :
      plan === "pro"   && period === "yearly"  ? process.env.STRIPE_PRICE_PRO_YEARLY    :
      process.env.STRIPE_PRICE_PRO_MONTHLY;

    if (!priceId) return res.status(400).send("Missing Stripe price id for selected plan/period.");

    // atrás de proxy/CDN, força https (evita session.create falhar por success_url/cancel_url inválidos)
    const baseUrl = `https://${req.get("host")}`;

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${baseUrl}/success`,
      cancel_url: `${baseUrl}/cancel`,
      metadata: { boundUserKey: String(boundUserKey), plan: String(plan) }
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
app.get("/admin/create-license", requireAdmin, (req, res) => {
  const { plan = "pro", days = "30" } = req.query || {};
  const d = Number(days);
  const now = serverTimeMs();
  const endsAtMs = now + (Number.isFinite(d) ? d : 30) * 24 * 60 * 60 * 1000;
  const licenseKey = crypto.randomBytes(10).toString("hex").toUpperCase();

  createLicense(licenseKey, { status: "active", plan, endsAtMs, boundUserKey: null });
  return res.json({ licenseKey, plan, endsAtMs });
});

const port = Number(process.env.PORT || "8787");
app.listen(port, () => console.log("License backend listening on", port));
