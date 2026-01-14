// mercadopago_client.js
import https from "https";

const accessToken = String(process.env.MERCADOPAGO_ACCESS_TOKEN || "").trim();
const API_BASE = "https://api.mercadopago.com";

function requestMercadoPago(path, { method = "GET", body = null } = {}) {
  if (!accessToken) throw new Error("Mercado Pago access token missing.");
  return new Promise((resolve, reject) => {
    const url = new URL(path, API_BASE);
    const payload = body ? JSON.stringify(body) : null;
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    };
    if (payload) headers["Content-Length"] = Buffer.byteLength(payload);

    const req = https.request(url, { method, headers }, (res) => {
      let raw = "";
      res.on("data", chunk => { raw += chunk; });
      res.on("end", () => {
        let parsed = null;
        if (raw) {
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(parsed || {});
          return;
        }
        const err = new Error(parsed?.message || parsed?.error || `Mercado Pago error ${res.statusCode}`);
        err.statusCode = res.statusCode;
        err.response = parsed;
        reject(err);
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export const mpPreference = accessToken ? {
  async create({ body }) {
    const data = await requestMercadoPago("/checkout/preferences", { method: "POST", body });
    return { body: data };
  }
} : null;

export const mpPayment = accessToken ? {
  async get({ id }) {
    const data = await requestMercadoPago(`/v1/payments/${id}`, { method: "GET" });
    return { body: data };
  }
} : null;
