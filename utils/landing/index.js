const Property = require("../../models/Property");
const Category = require("../../models/Category");
const LandingPage = require("../../models/LandingPage");
const { buildLandingIndex, resolveLandingPath } = require("./build");

// Loads live data and builds the landing-page index (see ./build.js).
async function loadLandingIndex() {
  const [properties, categories, landingDocs] = await Promise.all([
    Property.find({ isActive: true })
      .select("_id location.city location.country subcategory subcategories")
      .lean(),
    Category.find({}).select("subcategories.name subcategories.slug").lean(),
    LandingPage.find({}).lean(),
  ]);
  const services = categories.flatMap((c) => c.subcategories || []);
  return buildLandingIndex({ properties, services, landingDocs });
}

module.exports = { loadLandingIndex, buildLandingIndex, resolveLandingPath };
