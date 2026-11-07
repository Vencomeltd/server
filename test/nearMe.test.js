// Run with: node --test test/nearMe.test.js
// GET /properties/near-me sorts every active listing by distance in the
// database instead of sorting only the first 100 it loaded. Property.aggregate
// is stubbed with a tiny evaluator for the operators the pipeline uses, so
// the distance maths really runs against synthetic listings.
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

const geoId = require.resolve("geoip-lite");
let visitor = null;
require.cache[geoId] = { id: geoId, filename: geoId, loaded: true, exports: { lookup: () => visitor } };
const authId = require.resolve("../middleware/auth");
require.cache[authId] = { id: authId, filename: authId, loaded: true, exports: (_req, _res, next) => next() };
const { client } = require("../utils/redisClient");
client.get = async () => null;
client.setEx = async () => {};
const Property = require("../models/Property");

// Synthetic listings: 150 far-away ones first (so a "first 100" read never
// reaches the nearby ones), then two near central London, one without
// coordinates and one inactive.
const far = Array.from({ length: 150 }, (_, i) => ({ _id: `far${String(i).padStart(3, "0")}`, isActive: true, coordinates: { latitude: 55.95, longitude: -3.19 } }));
const listings = [
  ...far,
  { _id: "london-near", isActive: true, coordinates: { latitude: 51.51, longitude: -0.13 } },
  { _id: "croydon", isActive: true, coordinates: { latitude: 51.37, longitude: -0.1 } },
  { _id: "no-coords", isActive: true, coordinates: {} },
  { _id: "inactive-closest", isActive: false, coordinates: { latitude: 51.5074, longitude: -0.1278 } },
];

const get = (doc, path) => path.split(".").reduce((v, k) => (v == null ? undefined : v[k]), doc);
const evaluate = (expr, doc) => {
  if (typeof expr === "string" && expr.startsWith("$")) return get(doc, expr.slice(1));
  if (expr === null || typeof expr !== "object") return expr;
  const [op, arg] = Object.entries(expr)[0];
  const args = Array.isArray(arg) ? arg.map((a) => evaluate(a, doc)) : [evaluate(arg, doc)];
  const ops = {
    $add: () => args.reduce((a, b) => a + b, 0),
    $subtract: () => args[0] - args[1],
    $multiply: () => args.reduce((a, b) => a * b, 1),
    $divide: () => args[0] / args[1],
    $pow: () => args[0] ** args[1],
    $min: () => Math.min(...args),
    $sin: () => Math.sin(args[0]),
    $cos: () => Math.cos(args[0]),
    $asin: () => Math.asin(args[0]),
    $sqrt: () => Math.sqrt(args[0]),
    $degreesToRadians: () => (args[0] * Math.PI) / 180,
    $isNumber: () => typeof args[0] === "number",
    $and: () => args.every(Boolean),
    $eq: () => args[0] === args[1],
    $cond: () => (args[0] ? args[1] : args[2]),
  };
  assert.ok(ops[op], `unsupported operator ${op}`);
  return ops[op]();
};
let pipelines = [];
Property.aggregate = async (pipeline) => {
  pipelines.push(pipeline);
  let docs = listings;
  for (const stage of pipeline) {
    const [name, spec] = Object.entries(stage)[0];
    if (name === "$match") docs = docs.filter((d) => Object.entries(spec).every(([k, v]) => get(d, k) === v));
    else if (name === "$project") docs = docs.map((d) => ({ _id: d._id, ...Object.fromEntries(Object.entries(spec).map(([k, e]) => [k, evaluate(e, d)])) }));
    else if (name === "$addFields") docs = docs.map((d) => ({ ...d, ...Object.fromEntries(Object.entries(spec).map(([k, e]) => [k, evaluate(e, d)])) }));
    else if (name === "$sort") docs = [...docs].sort((a, b) => {
      for (const [k, dir] of Object.entries(spec)) {
        if (a[k] < b[k]) return -dir;
        if (a[k] > b[k]) return dir;
      }
      return 0;
    });
    else if (name === "$limit") docs = docs.slice(0, spec);
    else assert.fail(`unsupported stage ${name}`);
  }
  return docs;
};
// Property.find returns the requested listings in database order (not the
// distance order), with the list-view chain the route uses.
let findFilters = [];
Property.find = (filter) => {
  findFilters.push(filter);
  let result = filter._id ? listings.filter((l) => filter._id.$in.includes(l._id)) : listings.filter((l) => l.isActive);
  const q = {
    select: () => q, populate: () => q,
    limit: (n) => { result = result.slice(0, n); return q; },
    then: (resolve, reject) => Promise.resolve(result.map((l) => ({ ...l, title: `Listing ${l._id}` }))).then(resolve, reject),
  };
  return q;
};

const app = express();
app.use("/properties", require("../routes/properties"));
const server = app.listen(0, "127.0.0.1");
const ready = new Promise((resolve) => server.on("listening", resolve));
test.after(() => server.close());
test.beforeEach(() => {
  pipelines = [];
  findFilters = [];
});
const nearMe = async () => {
  await ready;
  const res = await fetch(`http://127.0.0.1:${server.address().port}/properties/near-me`);
  return { status: res.status, body: await res.json() };
};

test("nearby listings beyond the first 100 come first, sorted by distance", async () => {
  visitor = { ll: [51.5074, -0.1278], city: "London" };
  const { status, body } = await nearMe();
  assert.equal(status, 200);
  assert.equal(body.sorted, true);
  assert.equal(body.visitorCity, "London");
  assert.equal(body.properties.length, 100);
  assert.deepEqual(body.properties.slice(0, 2).map((p) => p._id), ["london-near", "croydon"]);
  assert.ok(!body.properties.some((p) => p._id === "inactive-closest"));
  assert.equal(body.properties[0].title, "Listing london-near"); // full list-view listing, same shape as before
});

test("listings without coordinates sink to the end rather than being dropped", async () => {
  visitor = { ll: [55.95, -3.19], city: "Edinburgh" };
  listings.splice(50); // fewer than 100 listings so the end is visible
  listings.push({ _id: "no-coords", isActive: true, coordinates: {} }, { _id: "london-near", isActive: true, coordinates: { latitude: 51.51, longitude: -0.13 } });
  const { body } = await nearMe();
  assert.equal(body.properties.at(-1)._id, "no-coords");
  assert.equal(body.properties.at(-2)._id, "london-near");
});

test("the database does the sorting and limiting", async () => {
  visitor = { ll: [51.5074, -0.1278], city: "London" };
  await nearMe();
  const stages = pipelines[0].map((s) => Object.keys(s)[0]);
  assert.deepEqual(stages.slice(-2), ["$sort", "$limit"]);
  assert.deepEqual(pipelines[0][0], { $match: { isActive: true } });
});

test("falls back to an unsorted list when the visitor can't be located", async () => {
  visitor = null;
  const { body } = await nearMe();
  assert.equal(body.sorted, false);
  assert.equal(pipelines.length, 0);
  assert.ok(body.properties.length <= 100);
});

test("the distance expression matches the known London-Edinburgh distance", async () => {
  visitor = { ll: [51.5074, -0.1278], city: "London" };
  await nearMe();
  const expr = pipelines[0].find((s) => s.$project).$project.distance;
  const km = evaluate(expr, { coordinates: { latitude: 55.9533, longitude: -3.1883 } });
  assert.ok(Math.abs(km - 534) < 3, `got ${km}`);
  assert.equal(evaluate(expr, { coordinates: {} }), null);
});
