// One row per unique visitor session (deduped client-side by a
// localStorage-persisted sessionId, see routes/visitorTracking.js) --
// powers the admin "where visitors come from" panel: country (via
// geoip-lite on the request IP) and how they found the site (referrer,
// classified into a source).
const mongoose = require("mongoose");

const visitorSessionSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, unique: true },
    country: { type: String, default: "Unknown" },
    referrer: { type: String, default: "" },
    // Coarse classification of referrer -- "direct" (no referrer),
    // "google"/"bing" etc. (search engines), "social" (known social
    // platforms), or "referral" (any other external site).
    source: { type: String, default: "direct" },
    landingPage: { type: String, default: "" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("VisitorSession", visitorSessionSchema);
