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
  for (const path of ["/uk", "/uk/london", "/uk/london/treatment-rooms", "/uk/london/nail-studio", "/treatment-rooms", "/nail-studio"]) {
    assert.ok(resolveLandingPath(idx, path), `${path} should exist`);
  }
  for (const path of ["/fr", "/uk/paris", "/uk/london/unknown-service", "/unknown-service", "/uk/london/treatment-rooms/x"]) {
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
