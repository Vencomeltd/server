const { MIN_LISTINGS } = require("../../config/landing");

const TYPE_ORDER = { country: 0, city: 1, city_service: 2, service: 3 };

// What's stopping a page from being indexed, in the order an admin would
// fix it. City and city+service pages need listings, then an intro, then
// approval; country and service pages follow their child city pages (their
// intro is optional).
function statusFor(page) {
  if (page.indexable) return "indexable";
  if (page.type === "country" || page.type === "service") return "waiting_on_cities";
  if (page.listingCount < MIN_LISTINGS) return "needs_listings";
  if (!page.intro) return "needs_intro";
  return "needs_approval";
}

function labelFor(page) {
  if (page.type === "country") return page.countryName;
  if (page.type === "city") return page.cityName;
  if (page.type === "city_service") return `${page.serviceName} in ${page.cityName}`;
  return page.serviceName;
}

// Pure: one row per landing page for the admin "SEO Pages" tab. Includes the
// draft intro (admins see drafts; the public API never does).
function adminRowFor(page) {
  return {
    path: page.path,
    type: page.type,
    label: labelFor(page),
    listingCount: page.listingCount,
    intro: page.intro,
    introApproved: page.introApproved,
    indexable: page.indexable,
    status: statusFor(page),
  };
}

function adminRowsFor(index) {
  return [...index.pages.values()]
    .map(adminRowFor)
    .sort(
      (a, b) =>
        TYPE_ORDER[a.type] - TYPE_ORDER[b.type] ||
        b.listingCount - a.listingCount ||
        a.label.localeCompare(b.label)
    );
}

module.exports = { adminRowsFor, adminRowFor, statusFor };
