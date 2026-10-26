const express = require("express");
const Property = require("../models/Property");
const { loadLandingIndex, resolveLandingPath } = require("../utils/landing");
const { buildLandingResponse } = require("../utils/landing/response");
const { legacyTargetPath } = require("../utils/landing/legacy");
const { toUrlSlug } = require("../utils/landing/slug");
const { generateSlug } = require("../utils/slugify");

const router = express.Router();

// GET /api/landing/links -- city and service-hub links for the site footer.
// Only pages that exist, so internal links never point at a 404.
router.get("/links", async (req, res) => {
  try {
    const pages = [...(await loadLandingIndex()).pages.values()];
    res.json({
      cities: pages
        .filter((p) => p.type === "city")
        .sort((a, b) => b.listingCount - a.listingCount)
        .map((p) => ({ name: p.cityName, path: p.path, listingCount: p.listingCount })),
      services: pages
        .filter((p) => p.type === "service")
        .map((p) => ({ name: p.serviceName, path: p.path })),
    });
  } catch (err) {
    console.error("Landing links error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET /api/landing/legacy?service=nail-studio&location=islington-london-
// Where an old /{service}/{location} URL now lives, for its 301. The
// location is the old neighbourhood slug from utils/slugify generateSlug.
router.get("/legacy", async (req, res) => {
  try {
    const index = await loadLandingIndex();
    const hub = resolveLandingPath(index, `/${toUrlSlug(req.query.service)}`);
    if (!hub || hub.type !== "service") return res.status(404).json({ error: "Page not found" });

    const location = String(req.query.location || "");
    const candidates = await Property.find({
      isActive: true,
      $or: [{ subcategory: hub.serviceName }, { subcategories: hub.serviceName }],
    })
      .select("location")
      .lean();
    const matched = candidates.filter(
      (p) => p.location?.neighborhood && generateSlug(p.location.neighborhood) === location
    );
    res.json({ path: legacyTargetPath(index, hub, matched) });
  } catch (err) {
    console.error("Landing legacy redirect error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET /api/landing?path=/uk/london&page=2 -- public SEO landing page data.
// 404 for paths that aren't a landing page or out-of-range page numbers.
router.get("/", async (req, res) => {
  try {
    const index = await loadLandingIndex();
    const page = resolveLandingPath(index, String(req.query.path || ""));
    if (!page) return res.status(404).json({ error: "Page not found" });

    const result = buildLandingResponse(index, page, req.query.page);
    if (result.status === 404) return res.status(404).json({ error: "Page not found" });

    const docs = await Property.find({ _id: { $in: result.listingIds }, isActive: true })
      .populate("host", "firstName lastName displayName profileImage")
      .populate("category", "name slug")
      // Listing cards never show a calendar; blockedDates can be huge.
      .select("-__v -blockedDates")
      .lean();
    const byId = new Map(docs.map((d) => [String(d._id), d]));
    const listings = result.listingIds.map((id) => byId.get(id)).filter(Boolean);

    res.json({ ...result.body, listings });
  } catch (err) {
    console.error("Landing page error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
