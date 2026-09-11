const express = require("express");
const router = express.Router();
const geoip = require("geoip-lite");
const VisitorSession = require("../models/VisitorSession");

const SEARCH_ENGINES = ["google", "bing", "yahoo", "duckduckgo", "baidu", "yandex"];
const SOCIAL_PLATFORMS = ["facebook", "instagram", "twitter", "x.com", "tiktok", "linkedin", "pinterest", "reddit"];

function classifySource(referrer) {
  if (!referrer) return "direct";
  const host = referrer.toLowerCase();
  if (SEARCH_ENGINES.some((s) => host.includes(s))) return host.match(/google|bing|yahoo|duckduckgo|baidu|yandex/)[0];
  if (SOCIAL_PLATFORMS.some((s) => host.includes(s))) return "social";
  return "referral";
}

// POST /api/track-visit -- public, no auth. Fired once per browser session
// (client dedupes via a localStorage sessionId, see App.jsx) so this is
// cheap even on a busy site; upsert makes repeat calls with the same
// sessionId a no-op rather than an error.
router.post("/", async (req, res) => {
  try {
    const { sessionId, referrer, landingPage } = req.body;
    if (!sessionId) return res.status(400).json({ error: "sessionId is required" });

    const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip;
    const geo = geoip.lookup(ip);

    await VisitorSession.updateOne(
      { sessionId },
      {
        $setOnInsert: {
          sessionId,
          country: geo?.country || "Unknown",
          referrer: referrer || "",
          source: classifySource(referrer),
          landingPage: landingPage || "",
        },
      },
      { upsert: true }
    );

    res.status(204).end();
  } catch (err) {
    // Never let tracking failures surface to the visitor.
    res.status(204).end();
  }
});

module.exports = router;
