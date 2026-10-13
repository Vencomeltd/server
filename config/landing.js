// SEO landing pages (/{service}, /{country}, /{country}/{city},
// /{country}/{city}/{service}) -- see the URL-structure spec in the vault,
// item 29. Shared by the landing API, the client pages and the sitemap.
module.exports = {
  // Property.location.country is free text; only countries listed here get
  // landing pages. Key = stored value, value = URL slug.
  COUNTRY_SLUGS: {
    "United Kingdom": "uk",
  },

  // A city or city+service page is indexable once it has this many live
  // listings AND an admin-approved intro.
  MIN_LISTINGS: 3,

  // First path segments the client already uses for other routes. A service
  // slug equal to one of these would be unreachable at /{service}, so it is
  // left out of the landing pages (and should be rejected when created).
  RESERVED_SLUGS: [
    "about", "accessibility", "admin", "availability", "blog", "blogs", "bookings",
    "cancellation-options", "careers", "category", "category-coming-soon", "chat",
    "checkout", "contact", "create-space", "customer", "dashboard", "edit-space",
    "faq", "forgot-password", "help", "help-center", "help-support", "host",
    "impersonate", "login", "my-bookings", "my-listings", "notifications",
    "partners", "press", "privacy", "profile", "property", "property-availability",
    "refer", "safety", "search", "settings", "signup", "sitemap", "support",
    "support-access", "terms-and-conditions",
  ],
};
