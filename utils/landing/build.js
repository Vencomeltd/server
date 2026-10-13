const { COUNTRY_SLUGS, MIN_LISTINGS, RESERVED_SLUGS } = require("../../config/landing");
const { toUrlSlug } = require("./slug");

// Pure: works out every SEO landing page that exists, its live listings and
// whether it is indexable, from plain data. The landing API, the client pages
// and the sitemap all go through this, so they can never disagree.
//
// Which pages exist (anything else is a 404, spec rule 4):
//   /{country}                    >= 1 live listing in that country
//   /{country}/{city}             >= 1 live listing in that city
//   /{country}/{city}/{service}   >= 1 live listing of that service in that
//                                 city (empty combinations 404 -- Jayden,
//                                 2026-10-13, to avoid hundreds of thin pages)
//   /{service}                    any known service whose slug isn't reserved
//                                 (the footer links to every service, so
//                                 empty hubs still exist, noindexed)
// Indexable when (spec "Indexable when" column):
//   city, city_service   >= MIN_LISTINGS live listings AND approved intro
//   country              at least one of its city pages is indexable
//   service              at least one city_service page for it is indexable
function buildLandingIndex({ properties = [], services = [], landingDocs = [] }) {
  const reserved = new Set([...RESERVED_SLUGS, ...Object.values(COUNTRY_SLUGS)]);

  const serviceByName = new Map();
  const serviceBySlug = new Map();
  const excludedServices = [];
  for (const s of services) {
    const slug = toUrlSlug(s.slug || s.name);
    if (!s.name || !slug || serviceBySlug.has(slug)) continue;
    if (reserved.has(slug)) {
      excludedServices.push({ name: s.name, slug });
      continue;
    }
    const service = { name: s.name, slug };
    serviceByName.set(s.name, service);
    serviceBySlug.set(slug, service);
  }

  const docKey = (type, countrySlug = "", citySlug = "", serviceSlug = "") =>
    [type, countrySlug, citySlug, serviceSlug].join("|");
  const docs = new Map(
    landingDocs.map((d) => [docKey(d.type, d.countrySlug, d.citySlug, d.serviceSlug), d])
  );

  // Group live listings by country -> city, remembering the most common
  // spelling of each city name for display.
  const countries = new Map();
  for (const p of properties) {
    const countryName = (p.location?.country || "").trim();
    const countrySlug = COUNTRY_SLUGS[countryName];
    const cityRaw = (p.location?.city || "").trim();
    const citySlug = toUrlSlug(cityRaw);
    if (!countrySlug || !citySlug) continue;

    if (!countries.has(countrySlug)) {
      countries.set(countrySlug, { name: countryName, cities: new Map() });
    }
    const cities = countries.get(countrySlug).cities;
    if (!cities.has(citySlug)) cities.set(citySlug, { spellings: new Map(), listings: [] });
    const city = cities.get(citySlug);
    city.spellings.set(cityRaw, (city.spellings.get(cityRaw) || 0) + 1);
    city.listings.push(p);
  }

  const pages = new Map();
  const pageFor = (type, path, fields, listingIds, breadcrumbs) => {
    const doc = docs.get(docKey(type, fields.countrySlug, fields.citySlug, fields.serviceSlug));
    const page = {
      type,
      path,
      countrySlug: "",
      citySlug: "",
      serviceSlug: "",
      ...fields,
      listingIds,
      listingCount: listingIds.length,
      intro: doc?.intro || "",
      introApproved: Boolean(doc?.introApproved && doc?.intro),
      indexable: false,
      breadcrumbs,
    };
    pages.set(path, page);
    return page;
  };
  const home = { name: "Home", path: "/" };
  const servicesOf = (p) => [p.subcategory, ...(p.subcategories || [])].filter(Boolean);

  for (const [countrySlug, country] of countries) {
    const countryPath = `/${countrySlug}`;
    const countryCrumb = { name: country.name, path: countryPath };
    const countryListings = [];
    let countryIndexable = false;

    for (const [citySlug, city] of country.cities) {
      const cityName = [...city.spellings.entries()].sort((a, b) => b[1] - a[1])[0][0];
      const cityPath = `${countryPath}/${citySlug}`;
      const cityCrumb = { name: cityName, path: cityPath };
      const cityPage = pageFor(
        "city",
        cityPath,
        { countrySlug, citySlug, countryName: country.name, cityName },
        city.listings.map((p) => String(p._id)),
        [home, countryCrumb, cityCrumb]
      );
      cityPage.indexable = cityPage.listingCount >= MIN_LISTINGS && cityPage.introApproved;
      countryIndexable = countryIndexable || cityPage.indexable;
      countryListings.push(...cityPage.listingIds);

      for (const service of serviceBySlug.values()) {
        const ids = city.listings
          .filter((p) => servicesOf(p).some((name) => serviceByName.get(name) === service))
          .map((p) => String(p._id));
        if (ids.length === 0) continue;
        const path = `${cityPath}/${service.slug}`;
        const page = pageFor(
          "city_service",
          path,
          {
            countrySlug,
            citySlug,
            serviceSlug: service.slug,
            countryName: country.name,
            cityName,
            serviceName: service.name,
          },
          ids,
          [home, countryCrumb, cityCrumb, { name: service.name, path }]
        );
        page.indexable = page.listingCount >= MIN_LISTINGS && page.introApproved;
      }
    }

    const countryPage = pageFor(
      "country",
      countryPath,
      { countrySlug, countryName: country.name },
      countryListings,
      [home, countryCrumb]
    );
    countryPage.indexable = countryIndexable;
  }

  for (const service of serviceBySlug.values()) {
    const cityServicePages = [...pages.values()].filter(
      (p) => p.type === "city_service" && p.serviceSlug === service.slug
    );
    const path = `/${service.slug}`;
    const page = pageFor(
      "service",
      path,
      { serviceSlug: service.slug, serviceName: service.name },
      cityServicePages.flatMap((p) => p.listingIds),
      [home, { name: service.name, path }]
    );
    page.indexable = cityServicePages.some((p) => p.indexable);
  }

  return { pages, excludedServices };
}

// Exact-path lookup; null means the page doesn't exist (404).
function resolveLandingPath(index, path) {
  return index.pages.get(path) || null;
}

module.exports = { buildLandingIndex, resolveLandingPath };
