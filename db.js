// db.js — armazenamento simples em JSON (troque por Postgres/SQLite em produção)
import fs from "fs";
import path from "path";

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), "db.json");

function load() {
  try { return JSON.parse(fs.readFileSync(DB_PATH, "utf-8")); }
  catch { return { users: {}, licenses: {}, payments: {} }; }
}

function save(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf-8");
}

export function getDb() { return load(); }
export function putDb(db) { save(db); }

export function upsertUser(boundUserKey, patch) {
  const db = load();
  db.users[boundUserKey] = { ...(db.users[boundUserKey] || {}), ...patch };
  save(db);
  return db.users[boundUserKey];
}

export function getUser(boundUserKey) {
  const db = load();
  return db.users[boundUserKey] || null;
}

export function createLicense(licenseKey, data) {
  const db = load();
  db.licenses[licenseKey] = { ...(db.licenses[licenseKey] || {}), ...data };
  save(db);
  return db.licenses[licenseKey];
}

export function getLicense(licenseKey) {
  const db = load();
  return db.licenses[licenseKey] || null;
}

export function bindLicenseToUser(licenseKey, boundUserKey) {
  const db = load();
  const lic = db.licenses[licenseKey];
  if (!lic) return null;
  lic.boundUserKey = boundUserKey;
  save(db);
  return lic;
}