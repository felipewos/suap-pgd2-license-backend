import express from "express";
import cors from "cors";
import crypto from "crypto";
import { getUser, upsertUser, getLicense, createLicense, bindLicenseToUser } from "./db.js";
import { stripe } from "./stripe_client.js";

const app = express();

// CORS: permite chamadas do extension origin + seu domínio do painel/admin
app.use(cors({
  origin: true,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.options("*", cors());

app.use(express.json({ limit: "512kb" }));

function serverTimeMs() { return Date.now(); }

function getTrialDays() {
  const d = Number(process.env.TRIAL_DAYS || "7");
  return Number.isFinite(d) && d > 0 ? d : 7;
}

function ensureTrialForUser(boundUserKey, boundUserLabel) {
  const existing = getUser(boundUserKey);
  if (existing?.trialStartedAt && existing?.trialEndsAt) return existing;

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

  const trialEndsAtMs = u?.trialEndsAt || null;
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

// -------- API --------

app.post("/api/auth/bind", (req, res) => {
  const { boundUserKey, boundUserLabel } = req.body || {};
  if (!boundUserKey) return res.status(400).json({ error: "missing boundUserKey" });

  const u = ensureTrialForUser(boundUserKey, boundUserLabel);
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

  // (1) se a licença já está vinculada, só libera para o mesmo usuário
  if (lic.boundUserKey && lic.boundUserKey !== boundUserKey) {
    return res.status(403).json({ error: "license_bound_to_other_user" });
  }

  // (2) se não está vinculada ainda, vincula ao primeiro userKey que verificar
  if (!lic.boundUserKey) bindLicenseToUser(licenseKey, boundUserKey);

  const status = computeStatus(boundUserKey, licenseKey);
  return res.json(status);
});

// Rebind controlado (suporte ou licença + confirmar)
app.post("/api/auth/rebind", (req, res) => {
  const { newBoundUserKey, newBoundUserLabel, supportCode, licenseKey, confirmOk } = req.body || {};
  if (!newBoundUserKey) return res.status(400).json({ ok:false, error: "missing newBoundUserKey" });

  const supportOk = supportCode && supportCode === (process.env.SUPPORT_REBIND_CODE || "");
  let paidOk = false;

  if (!supportOk && licenseKey) {
    const lic = getLicense(licenseKey);
    const now = serverTimeMs();
    paidOk = !!lic && lic.status === "active" && lic.endsAtMs && lic.endsAtMs > now;
  }

  if (!(supportOk || (paidOk && confirmOk))) {
    return res.status(403).json({ ok:false, error: "not_allowed" });
  }

  ensureTrialForUser(newBoundUserKey, newBoundUserLabel || null);
  return res.json({ ok:true });
});

// -------- Checkout (opcional) --------
// Página simples para iniciar compra. Você pode substituir por front-end próprio.
app.get("/buy", async (req, res) => {
  const { boundUserKey, extensionId, plan = "pro", period = "monthly" } = req.query || {};
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

  // O "licenseKey" é gerado no webhook (para simplificar). Aqui gravamos boundUserKey em metadata.
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${req.protocol}://${req.get("host")}/success`,
    cancel_url: `${req.protocol}://${req.get("host")}/cancel`,
    metadata: { boundUserKey: String(boundUserKey), plan: String(plan) }
  });

  res.redirect(303, session.url);
});

app.get("/success", (req, res) => {
  res.status(200).send(`
    <h2>Pagamento iniciado</h2>
    <p>Assim que o Stripe confirmar, sua licença será ativada automaticamente no backend.</p>
    <p>Volte ao Chrome e clique em “Verificar status”.</p>
  `);
});
app.get("/cancel", (req, res) => res.status(200).send("<h2>Cancelado</h2>"));

// Webhook Stripe: ao confirmar, cria/atualiza licença e vincula ao boundUserKey da metadata
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

  // Mínimo: checkout.session.completed
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const boundUserKey = session.metadata?.boundUserKey;
    const plan = session.metadata?.plan || "pro";

    // licença: 30 dias a partir de agora (ajuste conforme seu modelo)
    const now = serverTimeMs();
    const endsAtMs = now + 30 * 24 * 60 * 60 * 1000;
    const licenseKey = crypto.randomBytes(10).toString("hex").toUpperCase(); // exemplo

    createLicense(licenseKey, {
      status: "active",
      plan,
      endsAtMs,
      boundUserKey
    });

    ensureTrialForUser(boundUserKey, null);
  }

  res.json({ received: true });
});

// -------- Seed (manual) --------
app.get("/admin/create-license", (req, res) => {
  const { plan = "pro", days = "30" } = req.query || {};
  const d = Number(days);
  const now = serverTimeMs();
  const endsAtMs = now + (Number.isFinite(d) ? d : 30) * 24 * 60 * 60 * 1000;
  const licenseKey = crypto.randomBytes(10).toString("hex").toUpperCase();

  createLicense(licenseKey, { status:"active", plan, endsAtMs, boundUserKey: null });
  res.json({ licenseKey, plan, endsAtMs });
});

const port = Number(process.env.PORT || "8787");
app.listen(port, () => console.log("License backend listening on", port));