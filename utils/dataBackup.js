// Data export and restore (build spec section 9.2).
//
// Export: one zip with every collection as Extended JSON (types such as ids
// and dates survive a round trip), CSVs of the key collections, and a
// manifest. Password hashes, tokens, secrets and one-time codes are stripped
// from everything. A weekly copy goes to the Documents drive ("Backups"),
// keeping the last 8.
//
// Restore: from an uploaded export, always as a dry run first (what would be
// added or changed, per collection), then applied on confirm. It only adds
// and updates -- never deletes -- and updates set just the fields in the
// export, so stripped fields (passwords, tokens) are left as they are.
const cron = require("node-cron");
const archiver = require("archiver");
const AdmZip = require("adm-zip");
const mongoose = require("mongoose");
const Document = require("../models/Document");
const storage = require("./documentStorage");

const { EJSON } = mongoose.mongo.BSON;
const SENSITIVE_KEY = /password|token|secret|otp|apikey|api_key/i;
const BACKUP_FOLDER = "Backups";
const KEEP_BACKUPS = 8;

// Removes sensitive fields at any depth.
function strip(value) {
  if (Array.isArray(value)) return value.map(strip);
  if (value && typeof value === "object" && value.constructor === Object) {
    const out = {};
    for (const [key, v] of Object.entries(value)) if (!SENSITIVE_KEY.test(key)) out[key] = strip(v);
    return out;
  }
  return value;
}

const get = (doc, path) => path.split(".").reduce((v, k) => (v == null ? v : v[k]), doc);

// CSVs for the key collections: [file, collection, columns].
const CSV_EXPORTS = [
  ["users.csv", "users", ["_id", "email", "firstName", "lastName", "displayName", "isHost", "isVerified", "isAdmin", "isTestAccount", "accountFlag", "createdAt"]],
  ["listings.csv", "properties", ["_id", "title", "host", "location.city", "location.country", "isActive", "moderationStatus", "pricing.hourly", "pricing.daily", "pricing.weekly", "pricing.monthly", "createdAt"]],
  ["bookings.csv", "bookings", ["_id", "property", "guest", "host", "checkIn", "checkOut", "status", "totalPrice", "platformFee", "hostAmount", "isPaid", "createdAt"]],
  ["payments.csv", "payments", ["_id", "booking", "guest", "host", "amount", "platformFee", "hostAmount", "provider", "status", "createdAt"]],
  ["messages.csv", "messages", ["_id", "conversation", "sender", "text", "read", "createdAt"]],
];

function csvCell(value) {
  if (value == null) return "";
  let text = value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`; // stop spreadsheets running it as a formula
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const toCsv = (docs, columns) => [columns.join(","), ...docs.map((doc) => columns.map((c) => csvCell(get(doc, c))).join(","))].join("\r\n");

async function readCollections() {
  const db = mongoose.connection.db;
  const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).filter((n) => !n.startsWith("system."));
  const data = {};
  for (const name of names.sort()) data[name] = (await db.collection(name).find({}).toArray()).map(strip);
  return data;
}

// The full export as a zip Buffer.
async function buildExport() {
  const data = await readCollections();
  const zip = archiver("zip", { zlib: { level: 6 } });
  const chunks = [];
  zip.on("data", (chunk) => chunks.push(chunk));
  const done = new Promise((resolve, reject) => {
    zip.on("end", resolve);
    zip.on("error", reject);
  });
  const counts = Object.fromEntries(Object.entries(data).map(([name, docs]) => [name, docs.length]));
  zip.append(JSON.stringify({ app: "VenCome", version: 1, createdAt: new Date().toISOString(), collections: counts }, null, 2), { name: "manifest.json" });
  for (const [name, docs] of Object.entries(data)) zip.append(EJSON.stringify(docs, { relaxed: false }), { name: `collections/${name}.json` });
  for (const [file, collection, columns] of CSV_EXPORTS) zip.append(toCsv(data[collection] || [], columns), { name: `csv/${file}` });
  zip.finalize();
  await done;
  return Buffer.concat(chunks);
}

async function buildCsv(file) {
  const entry = CSV_EXPORTS.find(([name]) => name === file);
  if (!entry) return null;
  const docs = (await mongoose.connection.db.collection(entry[1]).find({}).toArray()).map(strip);
  return toCsv(docs, entry[2]);
}

// Weekly export into the Documents drive, keeping the last KEEP_BACKUPS.
async function saveWeeklyBackup() {
  const buffer = await buildExport();
  const name = `vencome-export-${new Date().toISOString().slice(0, 10)}.zip`;
  const key = storage.newKey(name);
  await storage.putFile(key, buffer, "application/zip");
  await Document.create({ name, folder: BACKUP_FOLDER, key, size: buffer.length, mimeType: "application/zip" });

  const old = await Document.find({ folder: BACKUP_FOLDER, uploadedBy: { $exists: false } }).sort({ createdAt: -1 }).skip(KEEP_BACKUPS);
  for (const doc of old) {
    await storage.deleteFile(doc.key).catch(() => {});
    await Document.deleteOne({ _id: doc._id });
  }
  console.log(`[Backups] Weekly export saved (${(buffer.length / 1024 / 1024).toFixed(1)} MB), removed ${old.length} old`);
}

// ── Restore ─────────────────────────────────────────────────────────────────
// Reads an export zip -> { manifest, collections: { name: docs } }.
function readExport(buffer) {
  let zip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    throw new Error("That file isn't a zip export.");
  }
  const manifestEntry = zip.getEntry("manifest.json");
  if (!manifestEntry) throw new Error("This zip isn't a VenCome export (no manifest.json).");
  const manifest = JSON.parse(manifestEntry.getData().toString("utf8"));
  if (manifest.app !== "VenCome") throw new Error("This zip isn't a VenCome export.");
  const collections = {};
  for (const entry of zip.getEntries()) {
    const match = entry.entryName.match(/^collections\/([\w.-]+)\.json$/);
    if (match) collections[match[1]] = EJSON.parse(entry.getData().toString("utf8"), { relaxed: false });
  }
  return { manifest, collections };
}

const same = (a, b) => EJSON.stringify(a ?? null, { relaxed: false }) === EJSON.stringify(b ?? null, { relaxed: false });
const isPlainObject = (v) => v !== null && typeof v === "object" && v.constructor === Object;

// [dotted path, value] for every field of `incoming` that differs from
// `existing`. Nested objects are compared field by field, so a sub-object
// whose secret was stripped from the export (e.g. googleCalendar without its
// refreshToken) only updates the fields it has -- the live secret is kept.
function changedPaths(incoming, existing, prefix = "") {
  const out = [];
  for (const [field, value] of Object.entries(incoming)) {
    if (!prefix && field === "_id") continue;
    const path = prefix + field;
    if (isPlainObject(value) && isPlainObject(existing?.[field])) out.push(...changedPaths(value, existing[field], `${path}.`));
    else if (!same(value, existing?.[field])) out.push([path, value]);
  }
  return out;
}

// What restoring would do, per collection -> { summary, ops }. summary[name]
// = { add, change, same, skipped, changedFields }. Never deletes anything;
// collections this database doesn't have are skipped.
async function planRestore(collections) {
  const db = mongoose.connection.db;
  const existingNames = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
  const summary = {};
  const ops = {};
  for (const [name, docs] of Object.entries(collections)) {
    if (!existingNames.has(name)) {
      summary[name] = { add: 0, change: 0, same: 0, skipped: docs.length, note: "Not a collection in this database" };
      continue;
    }
    const ids = docs.map((d) => d._id).filter((id) => id !== undefined);
    const current = new Map((await db.collection(name).find({ _id: { $in: ids } }).toArray()).map((d) => [EJSON.stringify(d._id), d]));
    const inserts = [];
    const updates = [];
    let unchanged = 0;
    for (const doc of docs) {
      if (doc._id === undefined) continue;
      const existing = current.get(EJSON.stringify(doc._id));
      if (!existing) {
        inserts.push(doc);
        continue;
      }
      const changed = changedPaths(doc, existing);
      if (changed.length) updates.push({ _id: doc._id, set: Object.fromEntries(changed), fields: changed.map(([path]) => path) });
      else unchanged += 1;
    }
    summary[name] = {
      add: inserts.length,
      change: updates.length,
      same: unchanged,
      skipped: 0,
      changedFields: [...new Set(updates.flatMap((u) => u.fields))].slice(0, 15),
    };
    ops[name] = { inserts, updates };
  }
  return { summary, ops };
}

async function applyRestore(ops) {
  const db = mongoose.connection.db;
  const result = {};
  for (const [name, { inserts, updates }] of Object.entries(ops)) {
    if (inserts.length) await db.collection(name).insertMany(inserts, { ordered: false });
    if (updates.length) {
      await db.collection(name).bulkWrite(updates.map((u) => ({ updateOne: { filter: { _id: u._id }, update: { $set: u.set } } })), { ordered: false });
    }
    result[name] = { added: inserts.length, changed: updates.length };
  }
  return result;
}

function setupWeeklyBackup() {
  // Sundays, 03:00 UK time.
  cron.schedule("0 3 * * 0", () => saveWeeklyBackup().catch((err) => console.error("[Backups] Weekly export failed:", err.message)), {
    timezone: "Europe/London",
  });
}

module.exports = { strip, toCsv, buildExport, buildCsv, saveWeeklyBackup, readExport, planRestore, applyRestore, setupWeeklyBackup, CSV_EXPORTS, BACKUP_FOLDER };
