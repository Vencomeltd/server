const { COUNTRY_SLUGS } = require("../../config/landing");
const { toUrlSlug } = require("./slug");

// Pure: where an old /{service}/{location} URL (the service+location pages
// replaced by the landing pages, spec rule 15) now lives. `hub` is the
// resolved /{service} page; `listings` are the active listings that matched
// the old URL (service + neighbourhood slug, same match as the old page).
// Goes to the city+service page for the city most of them are in, or the
// service hub when none of them maps to an existing city+service page.
function legacyTargetPath(index, hub, listings) {
  const counts = new Map();
  for (const p of listings) {
    const countrySlug = COUNTRY_SLUGS[(p.location?.country || "").trim()];
    const citySlug = toUrlSlug(p.location?.city);
    if (!countrySlug || !citySlug) continue;
    const path = `/${countrySlug}/${citySlug}/${hub.serviceSlug}`;
    counts.set(path, (counts.get(path) || 0) + 1);
  }
  const best = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .find(([path]) => index.pages.has(path));
  return best ? best[0] : hub.path;
}

module.exports = { legacyTargetPath };
