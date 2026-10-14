// Run with: node --test test/adminLandingPages.test.js
// Exercises routes/adminLandingPages.js over HTTP with the DB calls replaced
// by an in-memory store (no MongoDB needed).
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const express = require("express");
const { buildLandingIndex } = require("../utils/landing/build");

// In-memory LandingPage collection.
let store = [];
const matches = (doc, filter) => Object.entries(filter).every(([k, v]) => doc[k] === v);
const LandingPage = require("../models/LandingPage");
LandingPage.findOne = (filter) => {
  const doc = store.find((d) => matches(d, filter));
  const withSave = doc && { ...doc, save: async function () { Object.assign(doc, this); } };
  return { lean: async () => (doc ? { ...doc } : null), then: (r, j) => Promise.resolve(withSave || null).then(r, j) };
};
LandingPage.findOneAndUpdate = async (filter, update) => {
  let doc = store.find((d) => matches(d, filter));
  if (!doc) store.push((doc = { ...filter, intro: "", introApproved: false }));
  Object.assign(doc, update.$set || {});
  for (const k of Object.keys(update.$unset || {})) delete doc[k];
  return doc;
};

// Index built from fixed listings plus whatever is in the store.
const props = [1, 2, 3].map((i) => ({ _id: `p${i}`, location: { country: "United Kingdom", city: "London" }, subcategory: "Chairs", subcategories: [] }));
const indexPath = require.resolve(path.join(__dirname, "../utils/landing/index.js"));
require.cache[indexPath] = {
  id: indexPath, filename: indexPath, loaded: true,
  exports: {
    loadLandingIndex: async () => buildLandingIndex({ properties: props, services: [{ name: "Chairs", slug: "chairs" }], landingDocs: store }),
    resolveLandingPath: (index, p) => index.pages.get(p) || null,
  },
};

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.user = { id: "admin1" }; next(); });
app.use("/landing-pages", require("../routes/adminLandingPages"));

const server = app.listen(0);
const ready = new Promise((resolve) => server.on("listening", resolve));
test.after(() => server.close());
test.beforeEach(() => { store = []; });

const call = async (method, url, body) => {
  await ready;
  const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, { method, headers: { "content-type": "application/json" }, body: body && JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

test("admin API: lists rows with the threshold", async () => {
  const { status, body } = await call("GET", "/landing-pages");
  assert.equal(status, 200);
  assert.equal(body.minListings, 3);
  assert.equal(body.rows.find((r) => r.path === "/uk/london").status, "needs_intro");
});

test("admin API: save intro -> approve -> page becomes indexable", async () => {
  let r = await call("PUT", "/landing-pages", { path: "/uk/london", intro: "  London intro.  " });
  assert.equal(r.status, 200);
  assert.equal(r.body.row.intro, "London intro.");
  assert.equal(r.body.row.status, "needs_approval");

  r = await call("PUT", "/landing-pages/approval", { path: "/uk/london", approved: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.row.indexable, true);
  assert.equal(store[0].approvedBy, "admin1");
  assert.ok(store[0].approvedAt instanceof Date);
});

test("admin API: editing an approved intro clears approval; re-saving the same text doesn't", async () => {
  await call("PUT", "/landing-pages", { path: "/uk/london", intro: "Original." });
  await call("PUT", "/landing-pages/approval", { path: "/uk/london", approved: true });

  let r = await call("PUT", "/landing-pages", { path: "/uk/london", intro: "Original." });
  assert.equal(r.body.row.indexable, true, "unchanged text keeps approval");

  r = await call("PUT", "/landing-pages", { path: "/uk/london", intro: "Edited." });
  assert.equal(r.body.row.status, "needs_approval");
  assert.equal(r.body.row.indexable, false);
  assert.equal(store[0].approvedBy, undefined);
});

test("admin API: refuses to approve an empty intro, unknown pages and oversized intros", async () => {
  assert.equal((await call("PUT", "/landing-pages/approval", { path: "/uk/london", approved: true })).status, 400);
  await call("PUT", "/landing-pages", { path: "/uk/london", intro: "" });
  assert.equal((await call("PUT", "/landing-pages/approval", { path: "/uk/london", approved: true })).status, 400);
  assert.equal((await call("PUT", "/landing-pages", { path: "/uk/nowhere", intro: "x" })).status, 404);
  assert.equal((await call("PUT", "/landing-pages/approval", { path: "/uk/nowhere", approved: true })).status, 404);
  assert.equal((await call("PUT", "/landing-pages", { path: "/uk/london", intro: "x".repeat(2001) })).status, 400);
});

test("admin API: unapproving takes the page out of the index", async () => {
  await call("PUT", "/landing-pages", { path: "/uk/london", intro: "Intro." });
  await call("PUT", "/landing-pages/approval", { path: "/uk/london", approved: true });
  const r = await call("PUT", "/landing-pages/approval", { path: "/uk/london", approved: false });
  assert.equal(r.body.row.indexable, false);
  assert.equal(r.body.row.status, "needs_approval");
});
