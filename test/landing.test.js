// Run with: node --test test/
// Covers the pure SEO landing-page logic (utils/landing/build.js + slug.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const { toUrlSlug } = require("../utils/landing/slug");
const { buildLandingIndex, resolveLandingPath } = require("../utils/landing/build");

let nextId = 0;
const listing = (city, subcategory, extra = {}) => ({
  _id: `p${++nextId}`,
  location: { country: "United Kingdom", city },
  subcategory,
  subcategories: [],
  ...extra,
});
const SERVICES = [
  { name: "Treatment Rooms", slug: "treatment-rooms" },
  { name: "Nail Studio", slug: "nail-studio" },
];
const approved = (type, countrySlug, citySlug = "", serviceSlug = "") => ({
  type, countrySlug, citySlug, serviceSlug, intro: "Intro copy.", introApproved: true,
});

test("slug: lowercase ASCII, single hyphens, no stray edges", () => {
  assert.equal(toUrlSlug("Islington, London, "), "islington-london");
  assert.equal(toUrlSlug("  Thornton-Cleveleys "), "thornton-cleveleys");
  assert.equal(toUrlSlug("Lash & Brow Studio"), "lash-and-brow-studio");
  assert.equal(toUrlSlug("Café Rooms"), "cafe-rooms");
  assert.equal(toUrlSlug("--A  --  B--"), "a-b");
  assert.equal(toUrlSlug(null), "");
});

test("pages: known combinations exist, unknown ones are 404 (null)", () => {
  const idx = buildLandingIndex({ properties: [listing("London", "Treatment Rooms")], services: SERVICES });
  for (const path of ["/uk", "/uk/london", "/uk/london/treatment-rooms", "/treatment-rooms", "/nail-studio"]) {
    assert.ok(resolveLandingPath(idx, path), `${path} should exist`);
  }
  // /uk/london/nail-studio: known city + known service but 0 listings -> 404.
  for (const path of ["/fr", "/uk/paris", "/uk/london/nail-studio", "/uk/london/unknown-service", "/unknown-service", "/uk/london/treatment-rooms/x"]) {
    assert.equal(resolveLandingPath(idx, path), null, `${path} should 404`);
  }
});

test("pages: listings outside mapped countries or without a city are ignored", () => {
  const idx = buildLandingIndex({
    properties: [
      listing("Paris", "Treatment Rooms", { location: { country: "France", city: "Paris" } }),
      listing("", "Treatment Rooms"),
    ],
    services: SERVICES,
  });
  assert.equal(resolveLandingPath(idx, "/uk"), null);
  assert.equal(resolveLandingPath(idx, "/fr"), null);
});

test("indexable: city needs 3+ listings AND an approved intro", () => {
  const two = [listing("London", "Treatment Rooms"), listing("London", "Treatment Rooms")];
  const three = [...two, listing("London", "Nail Studio")];
  const doc = [approved("city", "uk", "london")];

  assert.equal(resolveLandingPath(buildLandingIndex({ properties: two, services: SERVICES, landingDocs: doc }), "/uk/london").indexable, false);
  assert.equal(resolveLandingPath(buildLandingIndex({ properties: three, services: SERVICES }), "/uk/london").indexable, false);
  const page = resolveLandingPath(buildLandingIndex({ properties: three, services: SERVICES, landingDocs: doc }), "/uk/london");
  assert.equal(page.listingCount, 3);
  assert.equal(page.indexable, true);
});

test("indexable: an approved flag with an empty intro does not count", () => {
  const props = [1, 2, 3].map(() => listing("London", "Treatment Rooms"));
  const doc = [{ ...approved("city", "uk", "london"), intro: "" }];
  assert.equal(resolveLandingPath(buildLandingIndex({ properties: props, services: SERVICES, landingDocs: doc }), "/uk/london").indexable, false);
});

test("indexable: city+service counts only listings with that service (subcategory or subcategories)", () => {
  const props = [
    listing("London", "Treatment Rooms"),
    listing("London", "Nail Studio", { subcategories: ["Treatment Rooms"] }),
    listing("London", "Treatment Rooms"),
    listing("London", "Nail Studio"),
  ];
  const docs = [approved("city_service", "uk", "london", "treatment-rooms"), approved("city_service", "uk", "london", "nail-studio")];
  const idx = buildLandingIndex({ properties: props, services: SERVICES, landingDocs: docs });
  const rooms = resolveLandingPath(idx, "/uk/london/treatment-rooms");
  const nails = resolveLandingPath(idx, "/uk/london/nail-studio");
  assert.equal(rooms.listingCount, 3);
  assert.equal(rooms.indexable, true);
  assert.equal(nails.listingCount, 2);
  assert.equal(nails.indexable, false);
});

test("indexable: country and service hub follow their child pages", () => {
  const props = [1, 2, 3].map(() => listing("London", "Treatment Rooms")).concat(listing("Leeds", "Treatment Rooms"));
  const none = buildLandingIndex({ properties: props, services: SERVICES });
  assert.equal(resolveLandingPath(none, "/uk").indexable, false);
  assert.equal(resolveLandingPath(none, "/treatment-rooms").indexable, false);

  const idx = buildLandingIndex({
    properties: props,
    services: SERVICES,
    landingDocs: [approved("city", "uk", "london"), approved("city_service", "uk", "london", "treatment-rooms")],
  });
  assert.equal(resolveLandingPath(idx, "/uk").indexable, true);
  assert.equal(resolveLandingPath(idx, "/treatment-rooms").indexable, true);
  assert.equal(resolveLandingPath(idx, "/nail-studio").indexable, false);
  assert.equal(resolveLandingPath(idx, "/nail-studio").listingCount, 0);
  assert.equal(resolveLandingPath(idx, "/uk").listingCount, 4);
});

test("city: messy spellings merge into one slug, most common spelling is displayed", () => {
  const idx = buildLandingIndex({
    properties: [listing("London", "Treatment Rooms"), listing(" london ", "Treatment Rooms"), listing("London", "Nail Studio")],
    services: SERVICES,
  });
  const page = resolveLandingPath(idx, "/uk/london");
  assert.equal(page.listingCount, 3);
  assert.equal(page.cityName, "London");
});

test("services: slugs that collide with existing routes or country codes are excluded", () => {
  const idx = buildLandingIndex({
    properties: [listing("London", "Blog")],
    services: [...SERVICES, { name: "Blog", slug: "blog" }, { name: "UK", slug: "uk" }],
  });
  assert.equal(resolveLandingPath(idx, "/blog"), null);
  assert.equal(resolveLandingPath(idx, "/uk/london/blog"), null);
  assert.deepEqual(idx.excludedServices.map((s) => s.slug).sort(), ["blog", "uk"]);
  assert.equal(resolveLandingPath(idx, "/uk").type, "country");
});

test("breadcrumbs mirror the URL path", () => {
  const idx = buildLandingIndex({ properties: [listing("London", "Treatment Rooms")], services: SERVICES });
  assert.deepEqual(resolveLandingPath(idx, "/uk/london/treatment-rooms").breadcrumbs, [
    { name: "Home", path: "/" },
    { name: "United Kingdom", path: "/uk" },
    { name: "London", path: "/uk/london" },
    { name: "Treatment Rooms", path: "/uk/london/treatment-rooms" },
  ]);
  assert.deepEqual(resolveLandingPath(idx, "/treatment-rooms").breadcrumbs, [
    { name: "Home", path: "/" },
    { name: "Treatment Rooms", path: "/treatment-rooms" },
  ]);
});

// --- utils/landing/response.js -------------------------------------------
const { buildLandingResponse, PAGE_SIZE } = require("../utils/landing/response");

const bigIndex = () => {
  const props = [];
  for (let i = 0; i < PAGE_SIZE + 5; i++) props.push(listing("London", "Treatment Rooms"));
  props.push(listing("London", "Nail Studio"), listing("Leeds", "Treatment Rooms"));
  return buildLandingIndex({
    properties: props,
    services: SERVICES,
    landingDocs: [
      approved("city", "uk", "london"),
      { type: "city", countrySlug: "uk", citySlug: "leeds", serviceSlug: "", intro: "Draft copy", introApproved: false },
    ],
  });
};

test("response: pages through listings and 404s out-of-range or junk page numbers", () => {
  const idx = bigIndex();
  const page = resolveLandingPath(idx, "/uk/london/treatment-rooms");
  const p1 = buildLandingResponse(idx, page, undefined);
  assert.equal(p1.status, 200);
  assert.equal(p1.listingIds.length, PAGE_SIZE);
  assert.deepEqual(p1.body.pagination, { page: 1, totalPages: 2, pageSize: PAGE_SIZE, total: PAGE_SIZE + 5 });
  const p2 = buildLandingResponse(idx, page, "2");
  assert.equal(p2.listingIds.length, 5);
  assert.equal(p2.listingIds[0], page.listingIds[PAGE_SIZE]);
  for (const bad of ["3", "0", "-1", "1.5", "abc"]) {
    assert.equal(buildLandingResponse(idx, page, bad).status, 404, `page=${bad}`);
  }
  // An empty service hub still has page 1.
  assert.equal(buildLandingResponse(idx, resolveLandingPath(idx, "/nail-studio"), undefined).status, 200);
});

test("response: approved intros are public, drafts are hidden, listingIds aren't leaked", () => {
  const idx = bigIndex();
  const london = buildLandingResponse(idx, resolveLandingPath(idx, "/uk/london"), undefined).body.page;
  const leeds = buildLandingResponse(idx, resolveLandingPath(idx, "/uk/leeds"), undefined).body.page;
  assert.equal(london.intro, "Intro copy.");
  assert.equal(leeds.intro, "");
  assert.equal("introApproved" in leeds, false);
  assert.equal("listingIds" in london, false);
});

test("response: child links per page type", () => {
  const idx = bigIndex();
  const kids = (path) => buildLandingResponse(idx, resolveLandingPath(idx, path), undefined).body.children.map((c) => c.path);
  assert.deepEqual(kids("/uk"), ["/uk/london", "/uk/leeds"]);
  assert.deepEqual(kids("/uk/london"), ["/uk/london/treatment-rooms", "/uk/london/nail-studio"]);
  assert.deepEqual(kids("/treatment-rooms"), ["/uk/london/treatment-rooms", "/uk/leeds/treatment-rooms"]);
  assert.deepEqual(kids("/uk/london/treatment-rooms"), ["/uk/london/nail-studio"]);
});

// --- utils/landing/admin.js -----------------------------------------------
const { adminRowsFor } = require("../utils/landing/admin");

test("admin rows: status says what's blocking each page, in fix order", () => {
  const props = [1, 2, 3].map(() => listing("London", "Treatment Rooms"))
    .concat([listing("Leeds", "Treatment Rooms"), listing("York", "Nail Studio"), listing("York", "Nail Studio"), listing("York", "Nail Studio")]);
  const idx = buildLandingIndex({
    properties: props,
    services: SERVICES,
    landingDocs: [
      approved("city", "uk", "london"),
      { type: "city", countrySlug: "uk", citySlug: "york", serviceSlug: "", intro: "Draft", introApproved: false },
      approved("city", "uk", "leeds"),
    ],
  });
  const row = (path) => adminRowsFor(idx).find((r) => r.path === path);
  assert.equal(row("/uk/london").status, "indexable");
  assert.equal(row("/uk/leeds").status, "needs_listings"); // approved intro but 1 listing
  assert.equal(row("/uk/york").status, "needs_approval"); // 3 listings, draft intro
  assert.equal(row("/uk/london/treatment-rooms").status, "needs_intro"); // 3 listings, no intro
  assert.equal(row("/uk").status, "indexable");
  assert.equal(row("/nail-studio").status, "waiting_on_cities");
  assert.equal(row("/uk/york").intro, "Draft", "admins see drafts");
  assert.equal(row("/uk/london/treatment-rooms").label, "Treatment Rooms in London");
});

test("admin rows: ordered country, cities, city+services, services; busiest first", () => {
  const idx = buildLandingIndex({
    properties: [listing("Leeds", "Treatment Rooms"), listing("London", "Treatment Rooms"), listing("London", "Nail Studio")],
    services: SERVICES,
  });
  const rows = adminRowsFor(idx);
  assert.deepEqual([...new Set(rows.map((r) => r.type))], ["country", "city", "city_service", "service"]);
  assert.deepEqual(rows.filter((r) => r.type === "city").map((r) => r.path), ["/uk/london", "/uk/leeds"]);
});
