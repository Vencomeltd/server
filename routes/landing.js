const express = require("express");
const Property = require("../models/Property");
const { loadLandingIndex, resolveLandingPath } = require("../utils/landing");
const { buildLandingResponse } = require("../utils/landing/response");

const router = express.Router();

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
      .select("-__v")
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
