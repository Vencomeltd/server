// Pure: shapes the public landing API response for one resolved page.
// Kept separate from the route so it can be tested without a database.
const PAGE_SIZE = 24;

// Child pages a landing page links to (spec: internal links point at clean
// landing URLs). country -> its cities; city -> its city+service pages;
// service hub -> the cities offering it; city+service -> other services in
// the same city.
function childPagesFor(index, page) {
  const all = [...index.pages.values()];
  let children = [];
  if (page.type === "country") {
    children = all.filter((p) => p.type === "city" && p.countrySlug === page.countrySlug)
      .map((p) => ({ path: p.path, name: p.cityName, listingCount: p.listingCount }));
  } else if (page.type === "city") {
    children = all.filter((p) => p.type === "city_service" && p.countrySlug === page.countrySlug && p.citySlug === page.citySlug)
      .map((p) => ({ path: p.path, name: p.serviceName, listingCount: p.listingCount }));
  } else if (page.type === "service") {
    children = all.filter((p) => p.type === "city_service" && p.serviceSlug === page.serviceSlug)
      .map((p) => ({ path: p.path, name: p.cityName, listingCount: p.listingCount }));
  } else if (page.type === "city_service") {
    children = all.filter((p) => p.type === "city_service" && p.countrySlug === page.countrySlug && p.citySlug === page.citySlug && p.path !== page.path)
      .map((p) => ({ path: p.path, name: p.serviceName, listingCount: p.listingCount }));
  }
  return children.sort((a, b) => b.listingCount - a.listingCount || a.name.localeCompare(b.name));
}

// Returns { status: 404 } for an out-of-range page number, otherwise
// { status: 200, listingIds, body } where listingIds are this page's ids
// (in order) for the caller to load, and body is everything else.
function buildLandingResponse(index, page, rawPageNumber) {
  const pageNumber = rawPageNumber === undefined ? 1 : Number(rawPageNumber);
  const totalPages = Math.max(1, Math.ceil(page.listingCount / PAGE_SIZE));
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > totalPages) {
    return { status: 404 };
  }
  const listingIds = page.listingIds.slice((pageNumber - 1) * PAGE_SIZE, pageNumber * PAGE_SIZE);
  const { listingIds: _all, intro, introApproved, ...rest } = page;
  return {
    status: 200,
    listingIds,
    body: {
      // Unapproved intros are drafts -- never shown publicly.
      page: { ...rest, intro: introApproved ? intro : "" },
      children: childPagesFor(index, page),
      pagination: { page: pageNumber, totalPages, pageSize: PAGE_SIZE, total: page.listingCount },
    },
  };
}

module.exports = { buildLandingResponse, childPagesFor, PAGE_SIZE };
