// Admin Data and backups (build spec section 9.2), mounted at
// /api/admin/data, full admins only. Full export (zip), CSVs of the key
// collections, the weekly backups in the Documents drive, restore from an
// export (dry run first, then confirm), and when each mirror last got data.
const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const mongoose = require("mongoose");
const { body, param, validationResult } = require("express-validator");
const { adminAuth, requireAdminRole } = require("../middleware/auth");
const Document = require("../models/Document");
const backup = require("../utils/dataBackup");

const router = express.Router();
router.use(adminAuth, requireAdminRole());

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024, files: 1 } });
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
  next();
};
const audit = (req, what) => console.log(`[Audit] Admin ${req.user.id} ${what}`);
const today = () => new Date().toISOString().slice(0, 10);

// GET /export -- everything, as a zip (secrets stripped).
router.get("/export", async (req, res) => {
  try {
    const zip = await backup.buildExport();
    audit(req, "downloaded a full data export");
    res.attachment(`vencome-export-${today()}.zip`).type("application/zip").send(zip);
  } catch (err) {
    console.error("Data export error:", err);
    res.status(500).json({ error: "Export failed" });
  }
});

// GET /csv/:file -- users.csv, listings.csv, bookings.csv, payments.csv, messages.csv
router.get("/csv/:file", [param("file").isIn(backup.CSV_EXPORTS.map(([f]) => f))], validate, async (req, res) => {
  try {
    const csv = await backup.buildCsv(req.params.file);
    audit(req, `downloaded ${req.params.file}`);
    res.attachment(`${req.params.file.replace(".csv", "")}-${today()}.csv`).type("text/csv").send(csv);
  } catch (err) {
    console.error("CSV export error:", err);
    res.status(500).json({ error: "Export failed" });
  }
});

// GET /backups -- the automatic weekly exports kept in Documents/Backups.
router.get("/backups", async (req, res) => {
  const backups = await Document.find({ folder: backup.BACKUP_FOLDER, uploadedBy: { $exists: false } }).sort({ createdAt: -1 });
  res.json({ backups });
});

// POST /backups/run -- make this week's export now.
router.post("/backups/run", async (req, res) => {
  try {
    await backup.saveWeeklyBackup();
    audit(req, "ran the weekly backup by hand");
    res.json({ success: true });
  } catch (err) {
    console.error("Manual backup error:", err);
    res.status(500).json({ error: "Backup failed" });
  }
});

// GET /mirrors -- for each backup database in BACKUP_MIRROR_URIS
// (comma-separated, read-only users), the newest record it holds.
router.get("/mirrors", async (req, res) => {
  const uris = String(process.env.BACKUP_MIRROR_URIS || "").split(",").map((u) => u.trim()).filter(Boolean);
  const mirrors = await Promise.all(
    uris.map(async (uri, i) => {
      const name = `Mirror ${i + 1}`;
      let conn;
      try {
        conn = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 5000 }).asPromise();
        const newest = await Promise.all(
          ["bookings", "users", "properties"].map((c) => conn.db.collection(c).find({}, { projection: { updatedAt: 1 } }).sort({ updatedAt: -1 }).limit(1).next())
        );
        const latest = newest.map((d) => d?.updatedAt).filter(Boolean).sort((a, b) => b - a)[0] || null;
        return { name, ok: true, latestData: latest };
      } catch (err) {
        return { name, ok: false, error: err.message };
      } finally {
        await conn?.close().catch(() => {});
      }
    })
  );
  res.json({ configured: uris.length > 0, mirrors });
});

// ── Restore: dry run, then confirm ──────────────────────────────────────────
// The uploaded export's plan is held for 30 minutes between the dry run and
// the confirm, for the admin who ran it.
const pending = new Map();
const PENDING_MS = 30 * 60 * 1000;

router.post(
  "/restore/dry-run",
  (req, res, next) =>
    upload.single("file")(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.code === "LIMIT_FILE_SIZE" ? "The export can be up to 200 MB" : err.message });
      next();
    }),
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "Choose an export zip" });
      const { manifest, collections } = backup.readExport(req.file.buffer);
      const { summary, ops } = await backup.planRestore(collections);
      for (const [token, item] of pending) if (Date.now() - item.at > PENDING_MS) pending.delete(token);
      const token = crypto.randomBytes(24).toString("hex");
      pending.set(token, { ops, at: Date.now(), by: req.user.id });
      audit(req, `ran a restore dry run (export from ${manifest.createdAt})`);
      res.json({ token, exportCreatedAt: manifest.createdAt, summary, expiresInMinutes: 30 });
    } catch (err) {
      console.error("Restore dry run error:", err);
      res.status(400).json({ error: err.message || "Couldn't read the export" });
    }
  }
);

router.post("/restore/apply", [body("token").isString(), body("confirm").equals("true").withMessage("Confirm the restore")], validate, async (req, res) => {
  const item = pending.get(req.body.token);
  if (!item || Date.now() - item.at > PENDING_MS || item.by !== req.user.id) {
    return res.status(400).json({ error: "Run the dry run again -- this one has expired." });
  }
  pending.delete(req.body.token);
  try {
    const result = await backup.applyRestore(item.ops);
    audit(req, `restored data from an export: ${JSON.stringify(result)}`);
    res.json({ result });
  } catch (err) {
    console.error("Restore apply error:", err);
    res.status(500).json({ error: `Restore stopped partway: ${err.message}` });
  }
});

module.exports = router;
