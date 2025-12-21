// tools/seed.js — gera uma licença manual (sem Stripe)
import crypto from "crypto";
import { createLicense } from "../db.js";

const plan = process.argv[2] || "pro";
const days = Number(process.argv[3] || "30");
const now = Date.now();
const endsAtMs = now + (Number.isFinite(days) ? days : 30) * 24 * 60 * 60 * 1000;
const licenseKey = crypto.randomBytes(10).toString("hex").toUpperCase();

createLicense(licenseKey, { status:"active", plan, endsAtMs, boundUserKey: null });
console.log("LICENSE_KEY:", licenseKey);
console.log("PLAN:", plan);
console.log("ENDS:", new Date(endsAtMs).toISOString());