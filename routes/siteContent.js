// Editable site text (build spec section 8). Public GET /api/site-content
// returns every published override as { key: value } -- cached in Redis and
// busted on publish, so changes go live without a redeploy. The admin routes
// (mounted at /api/admin/site-content) publish, restore and reset blocks,
// keeping a version history per block. Defaults live in the client bundle.
const express = require("express");
const { body, param, validationResult } = require("express-validator");
const { adminAuth, requireAdminRole } = require("../middleware/auth");
const SiteContent = require("../models/SiteContent");
const { client: redis } = require("../utils/redisClient");

const CACHE_KEY = "site-content:v1";
const HISTORY_LIMIT = 20;
const MAX_LENGTH = 5000; // per-block limits are tighter, enforced in the admin editor

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
  next();
};

// { key: value } of every block that has a published override.
async function publishedOverrides() {
  if (redis.isOpen) {
    try {
      const cached = await redis.get(CACHE_KEY);
      if (cached) return JSON.parse(cached);
    } catch (err) {
      console.warn("[Site content] Redis read failed:", err.message);
    }
  }
  const docs = await SiteContent.find({ value: { $ne: null } }).select("key value").lean();
  const overrides = Object.fromEntries(docs.map((d) => [d.key, d.value]));
  if (redis.isOpen) redis.set(CACHE_KEY, JSON.stringify(overrides), { EX: 3600 }).catch(() => {});
  return overrides;
}

async function bustCache() {
  if (redis.isOpen) await redis.del(CACHE_KEY).catch(() => {});
}

// ── Public ──────────────────────────────────────────────────────────────────
const publicRouter = express.Router();
publicRouter.get("/", async (req, res) => {
  try {
    res.set("Cache-Control", "public, max-age=60");
    res.json(await publishedOverrides());
  } catch (err) {
    console.error("Site content error:", err);
    res.json({}); // the site falls back to its defaults
  }
});

// ── Admin ───────────────────────────────────────────────────────────────────
const adminRouter = express.Router();
adminRouter.use(adminAuth, requireAdminRole("content"));

const keyParam = param("key").matches(/^[a-z0-9._-]{1,80}$/).withMessage("Invalid key");

// GET / -- every block that has ever been published, with its history.
adminRouter.get("/", async (req, res) => {
  try {
    const blocks = await SiteContent.find()
      .populate("updatedBy", "firstName lastName displayName email")
      .populate("history.by", "firstName lastName displayName email")
      .lean();
    res.json({ blocks });
  } catch (err) {
    console.error("Admin site content error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Sets a block's published value (null = back to the default), keeping the
// previous one in history.
async function publish(key, value, adminId) {
  const doc = (await SiteContent.findOne({ key })) || new SiteContent({ key });
  if (!doc.isNew && doc.value === value) return doc;
  if (!doc.isNew) doc.history.unshift({ value: doc.value, at: doc.updatedAt, by: doc.updatedBy });
  doc.history = doc.history.slice(0, HISTORY_LIMIT);
  doc.value = value;
  doc.updatedBy = adminId;
  await doc.save();
  await bustCache();
  return doc;
}

// PUT /:key -- { value } publish.
adminRouter.put(
  "/:key",
  [keyParam, body("value").isString().isLength({ min: 1, max: MAX_LENGTH }).withMessage(`Text must be 1-${MAX_LENGTH} characters`)],
  validate,
  async (req, res) => {
    try {
      const doc = await publish(req.params.key, req.body.value, req.user.id);
      console.log(`[Audit] Admin ${req.user.id} published site content ${req.params.key}`);
      res.json({ block: doc });
    } catch (err) {
      console.error("Publish site content error:", err);
      res.status(500).json({ error: "Server error" });
    }
  }
);

// POST /:key/restore -- { historyId } puts an earlier version back live.
adminRouter.post("/:key/restore", [keyParam, body("historyId").isMongoId()], validate, async (req, res) => {
  try {
    const doc = await SiteContent.findOne({ key: req.params.key });
    const version = doc?.history.id(req.body.historyId);
    if (!version) return res.status(404).json({ error: "Version not found" });
    const restored = await publish(req.params.key, version.value ?? null, req.user.id);
    console.log(`[Audit] Admin ${req.user.id} restored site content ${req.params.key} to a version from ${version.at?.toISOString()}`);
    res.json({ block: restored });
  } catch (err) {
    console.error("Restore site content error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// DELETE /:key -- back to the default wording (kept in history).
adminRouter.delete("/:key", [keyParam], validate, async (req, res) => {
  try {
    const doc = await publish(req.params.key, null, req.user.id);
    console.log(`[Audit] Admin ${req.user.id} reset site content ${req.params.key} to default`);
    res.json({ block: doc });
  } catch (err) {
    console.error("Reset site content error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = { publicRouter, adminRouter, publishedOverrides };
