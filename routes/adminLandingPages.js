const express = require("express");
const LandingPage = require("../models/LandingPage");
const { MIN_LISTINGS } = require("../config/landing");
const { loadLandingIndex, resolveLandingPath } = require("../utils/landing");
const { adminRowsFor, adminRowFor } = require("../utils/landing/admin");

// Admin "SEO Pages" tab: write and approve intros for landing pages.
// Mounted from routes/admin.js behind adminAuth + the content role.
const router = express.Router();

const MAX_INTRO_LENGTH = 2000;

const docFilter = (page) => ({
  type: page.type,
  countrySlug: page.countrySlug,
  citySlug: page.citySlug,
  serviceSlug: page.serviceSlug,
});

// Re-reads the index so the returned row reflects the saved state exactly
// as the public pages and sitemap will see it.
async function freshRow(path) {
  const page = resolveLandingPath(await loadLandingIndex(), path);
  return page ? adminRowFor(page) : null;
}

router.get("/", async (req, res) => {
  try {
    res.json({ minListings: MIN_LISTINGS, rows: adminRowsFor(await loadLandingIndex()) });
  } catch (err) {
    console.error("Admin landing pages error:", err);
    res.status(500).json({ error: "Failed to load SEO pages" });
  }
});

// Save an intro. Any change to the text clears approval, so edited copy is
// never published without someone approving it again.
router.put("/", async (req, res) => {
  try {
    const intro = String(req.body?.intro ?? "").trim();
    if (intro.length > MAX_INTRO_LENGTH) {
      return res.status(400).json({ error: `Intro must be ${MAX_INTRO_LENGTH} characters or fewer` });
    }
    const page = resolveLandingPath(await loadLandingIndex(), String(req.body?.path || ""));
    if (!page) return res.status(404).json({ error: "SEO page not found" });

    const existing = await LandingPage.findOne(docFilter(page)).lean();
    const changed = (existing?.intro || "") !== intro;
    await LandingPage.findOneAndUpdate(
      docFilter(page),
      changed
        ? { $set: { intro, introApproved: false }, $unset: { approvedBy: 1, approvedAt: 1 } }
        : { $set: { intro } },
      { upsert: true }
    );
    res.json({ row: await freshRow(page.path) });
  } catch (err) {
    console.error("Admin save landing intro error:", err);
    res.status(500).json({ error: "Failed to save intro" });
  }
});

router.put("/approval", async (req, res) => {
  try {
    const approved = req.body?.approved === true;
    const page = resolveLandingPath(await loadLandingIndex(), String(req.body?.path || ""));
    if (!page) return res.status(404).json({ error: "SEO page not found" });

    const doc = await LandingPage.findOne(docFilter(page));
    if (approved && !doc?.intro?.trim()) {
      return res.status(400).json({ error: "Write and save an intro before approving it" });
    }
    if (doc) {
      doc.introApproved = approved;
      doc.approvedBy = approved ? req.user.id : undefined;
      doc.approvedAt = approved ? new Date() : undefined;
      await doc.save();
    }
    res.json({ row: await freshRow(page.path) });
  } catch (err) {
    console.error("Admin approve landing intro error:", err);
    res.status(500).json({ error: "Failed to update approval" });
  }
});

module.exports = router;
