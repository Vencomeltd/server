const mongoose = require("mongoose");

// Admin-written intro for a SEO landing page. A city or city+service page
// is only indexable once its intro is approved (see config/landing.js and
// utils/landing/build.js). Country and service-hub pages also get an intro,
// but their indexability depends on their child city pages.
const landingPageSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ["country", "city", "city_service", "service"], required: true },
    countrySlug: { type: String, default: "" },
    citySlug: { type: String, default: "" },
    serviceSlug: { type: String, default: "" },
    intro: { type: String, default: "" },
    introApproved: { type: Boolean, default: false },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    approvedAt: { type: Date },
  },
  { timestamps: true }
);

landingPageSchema.index({ type: 1, countrySlug: 1, citySlug: 1, serviceSlug: 1 }, { unique: true });

module.exports = mongoose.model("LandingPage", landingPageSchema);
