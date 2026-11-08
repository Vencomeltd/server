// Run with: node --test test/buildingListings.test.js
// Building listings: a "building" Property with "unit" Properties under it.
// Property, User, Conversation and Message are replaced by an in-memory fake,
// and Redis by a Map; every record is synthetic (no client listing IDs, no
// database, no email).
const test = require("node:test");
process.env.JWT_SECRET = "synthetic-test-secret";
const assert = require("node:assert/strict");
const express = require("express");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const stub = (id, exports) => {
  const resolved = require.resolve(id);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};
// Auth: the caller is named by the x-user header.
stub("../middleware/auth", (req, _res, next) => {
  req.user = { id: req.header("x-user") };
  next();
});
const emails = [];
stub("../utils/sendEmail", async (mail) => { emails.push(mail); });
stub("../utils/stripeConnect", async () => {});
stub("../utils/uploadService", Object.assign(async () => ({ location: "https://synthetic.example.test/x" }), { deleteFromR2: async () => {} }));

const cache = new Map();
const { client } = require("../utils/redisClient");
client.get = async (key) => cache.get(key) ?? null;
client.setEx = async (key, _ttl, value) => { cache.set(key, value); };
client.del = async (key) => { cache.delete(key); };

const Property = require("../models/Property");
const User = require("../models/User");
const Conversation = require("../models/Conversation");
const Message = require("../models/Message");

const id = () => String(new mongoose.Types.ObjectId());
const HOST = id(), OTHER_HOST = id(), ADMIN = id(), GUEST = id();
const users = new Map([
  [HOST, { _id: HOST, email: "host@synthetic.example.test", firstName: "Synthetic", isVerified: true }],
  [OTHER_HOST, { _id: OTHER_HOST, email: "other@synthetic.example.test", isVerified: true }],
  [ADMIN, { _id: ADMIN, email: "admin@synthetic.example.test", isAdmin: true, isVerified: true }],
  [GUEST, { _id: GUEST, email: "guest@synthetic.example.test", isVerified: true }],
]);

// ── In-memory fake of the Property model ─────────────────────────────────
const store = new Map();
const get = (doc, path) => path.split(".").reduce((v, k) => (v == null ? undefined : v[k]), doc);
const matches = (doc, filter) => Object.entries(filter).every(([key, want]) => {
  if (key === "$or") return want.some((part) => matches(doc, part));
  const have = get(doc, key);
  if (want && typeof want === "object" && !(want instanceof mongoose.Types.ObjectId)) {
    if ("$in" in want) return want.$in.map(String).includes(String(have));
    if ("$ne" in want) return String(have) !== String(want.$ne);
    assert.fail(`unsupported operator in ${JSON.stringify(want)}`);
  }
  return String(have) === String(want);
});
const query = (resolve) => {
  let lean = false;
  const q = {
    select: () => q, populate: () => q, sort: () => q, skip: () => q, limit: () => q,
    lean: () => { lean = true; return q; },
    then: (ok, fail) => Promise.resolve(resolve())
      .then((r) => (lean ? (Array.isArray(r) ? r.map((d) => d.toObject()) : r?.toObject ? r.toObject() : r) : r))
      .then(ok, fail),
  };
  return q;
};
const plainDocs = (filter) => [...store.values()].filter((doc) => matches(doc.toObject ? doc.toObject() : doc, filter));
Property.find = (filter = {}) => query(() => plainDocs(filter));
Property.findOne = (filter) => query(() => plainDocs(filter)[0] || null);
Property.findById = (docId) => query(() => store.get(String(docId)) || null);
Property.countDocuments = async (filter = {}) => plainDocs(filter).length;
Property.exists = async () => null;
let pipelines = [];
Property.aggregate = async (pipeline) => { pipelines.push(pipeline); return []; };
Property.deleteMany = async (filter) => { for (const doc of plainDocs(filter)) store.delete(String(doc._id)); };
Property.prototype.save = async function save() { await this.validate(); store.set(String(this._id), this); return this; };
Property.prototype.deleteOne = async function deleteOne() { store.delete(String(this._id)); };
User.findById = (userId) => query(() => users.get(String(userId)) || null);

const sent = [];
Conversation.findOne = () => query(() => null);
Conversation.prototype.save = async function save() { return this; };
Conversation.findByIdAndUpdate = async () => {};
Message.prototype.save = async function save() { sent.push(this); return this; };
Message.prototype.populate = async function populate() { return this; };

const seed = (fields) => {
  const doc = new Property({
    title: "Synthetic Tower", description: "Synthetic description", host: HOST,
    location: { address: "1 Synthetic Street", city: "Testville", country: "UK" },
    images: ["https://synthetic.example.test/a-w1600.webp"], coverImage: "https://synthetic.example.test/a-w1600.webp",
    listingType: "building", isActive: true, moderationStatus: "approved", ...fields,
  });
  store.set(String(doc._id), doc);
  return doc;
};
const seedUnit = (building, fields = {}) => seed({
  title: "Synthetic Unit", listingType: "unit", parentBuilding: building._id, host: building.host,
  images: [], coverImage: undefined, pricing: { pricingType: "MONTHLY", monthly: 1000 },
  unitDetails: { label: "Unit 1", availability: { status: "available" } }, ...fields,
});

const app = express();
app.use(express.json());
app.use("/properties", require("../routes/properties"));
app.use("/messages", require("../routes/messages"));
const server = app.listen(0, "127.0.0.1");
const ready = new Promise((resolve) => server.on("listening", resolve));
test.after(() => server.close());
test.beforeEach(() => { pipelines = []; store.clear(); cache.clear(); emails.length = 0; sent.length = 0; });

const call = async (method, path, { user, body, token } = {}) => {
  await ready;
  const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(user && { "x-user": user }),
      // the public GET /:id reads a JWT itself, so it never sees x-user
      ...(token && { Authorization: `Bearer ${jwt.sign({ id: token }, process.env.JWT_SECRET)}` }),
    },
    body: body && JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

const buildingForm = (extra = {}) => ({
  listingType: "building", title: "Synthetic Tower", description: "Synthetic description",
  location: JSON.stringify({ address: "1 Synthetic Street", city: "Testville", country: "UK" }),
  coordinates: JSON.stringify({ latitude: 51.5, longitude: -0.1 }),
  features: JSON.stringify({ amenities: ["Lift"] }),
  existingImages: JSON.stringify(["https://synthetic.example.test/a-w1600.webp"]),
  ...extra,
});
const unitBody = (extra = {}) => ({
  title: "Suite 2A",
  pricing: { monthly: 1000, minimumTermMonths: 6, vat: { monthly: { enteredPence: 100000, status: "excludes", ratePct: 20, utilities: { amountPence: 5000, per: "unit", vatable: true } } } },
  unitDetails: { label: "2A", sizeSqFt: 450, capacity: 6, features: ["Meeting room"], availability: { status: "available" } },
  ...extra,
});

// ── Creating a building ──────────────────────────────────────────────────
test("a building is created with photos but without pricing", async () => {
  const { status, body } = await call("POST", "/properties", { user: HOST, body: buildingForm() });
  assert.equal(status, 201);
  assert.equal(body.property.listingType, "building");
  assert.equal(body.property.images.length, 1);
  assert.equal(store.size, 1);
});

test("a building still needs a photo; a single listing still needs pricing; units cannot be made here", async () => {
  const noPhoto = await call("POST", "/properties", { user: HOST, body: buildingForm({ existingImages: "[]" }) });
  assert.equal(noPhoto.status, 400);
  assert.match(noPhoto.body.error, /photo/i);

  const single = await call("POST", "/properties", { user: HOST, body: buildingForm({ listingType: undefined }) });
  assert.equal(single.status, 400);

  const unit = await call("POST", "/properties", { user: HOST, body: buildingForm({ listingType: "unit" }) });
  assert.equal(unit.status, 400);
  assert.equal(store.size, 0);
});

// ── Units: create, edit, delete ──────────────────────────────────────────
test("a host adds a unit under their building", async () => {
  const building = seed();
  const { status, body } = await call("POST", `/properties/${building._id}/units`, { user: HOST, body: unitBody() });
  assert.equal(status, 201);
  const unit = body.unit;
  assert.equal(unit.listingType, "unit");
  assert.equal(unit.parentBuilding, String(building._id));
  assert.equal(unit.host, String(building.host));
  assert.equal(unit.title, "Suite 2A");
  assert.deepEqual(unit.images, []);
  assert.equal(unit.pricing.monthly, 1000);
  assert.equal(unit.pricing.minimumTermMonths, 6);
  assert.equal(unit.pricing.vat.monthly.grossPence, 120000);
  assert.deepEqual({ label: unit.unitDetails.label, sizeSqFt: unit.unitDetails.sizeSqFt, capacity: unit.unitDetails.capacity, features: unit.unitDetails.features, status: unit.unitDetails.availability.status }, { label: "2A", sizeSqFt: 450, capacity: 6, features: ["Meeting room"], status: "available" });
});

test("only the building's owner or an admin can add units, and only to a building", async () => {
  const building = seed();
  assert.equal((await call("POST", `/properties/${building._id}/units`, { user: OTHER_HOST, body: unitBody() })).status, 403);
  assert.equal((await call("POST", `/properties/${building._id}/units`, { body: unitBody() })).status, 403);
  assert.equal((await call("POST", `/properties/${building._id}/units`, { user: ADMIN, body: unitBody() })).status, 201);
  const single = seed({ listingType: "single" });
  assert.equal((await call("POST", `/properties/${single._id}/units`, { user: HOST, body: unitBody() })).status, 400);
  assert.equal((await call("POST", `/properties/${id()}/units`, { user: HOST, body: unitBody() })).status, 404);
});

test("unit input is validated", async () => {
  const building = seed();
  const bad = {
    "no title": { title: "" },
    "no price": { pricing: { minimumTermMonths: 6 } },
    "bad term": { pricing: { monthly: 100, minimumTermMonths: 1 } },
    "bad size": { unitDetails: { sizeSqFt: "big" } },
    "negative size": { unitDetails: { sizeSqFt: -5 } },
    "fractional capacity": { unitDetails: { capacity: 2.5 } },
    "21 features": { unitDetails: { features: Array.from({ length: 21 }, (_, i) => `f${i}`) } },
    "long feature": { unitDetails: { features: ["x".repeat(61)] } },
    "non-string feature": { unitDetails: { features: [42] } },
    "bad status": { unitDetails: { availability: { status: "maybe" } } },
    "available_from without date": { unitDetails: { availability: { status: "available_from" } } },
    "available_from bad date": { unitDetails: { availability: { status: "available_from", availableFrom: "nonsense" } } },
  };
  for (const [name, override] of Object.entries(bad)) {
    const body = unitBody();
    for (const [key, value] of Object.entries(override)) body[key] = key === "unitDetails" ? { ...body.unitDetails, ...value } : value;
    const res = await call("POST", `/properties/${building._id}/units`, { user: HOST, body });
    assert.equal(res.status, 400, name);
  }
  assert.equal(store.size, 1);
  const ok = await call("POST", `/properties/${building._id}/units`, { user: HOST, body: unitBody({ unitDetails: { availability: { status: "available_from", availableFrom: "2027-03-01" }, features: Array.from({ length: 20 }, () => "x".repeat(60)) } }) });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.unit.unitDetails.availability.availableFrom.slice(0, 10), "2027-03-01");
});

test("a building holds at most 100 units", async () => {
  const building = seed();
  for (let i = 0; i < 100; i++) seedUnit(building);
  const res = await call("POST", `/properties/${building._id}/units`, { user: HOST, body: unitBody() });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /100/);
});

test("units are edited and deleted by their owner or an admin", async () => {
  const building = seed();
  const unit = seedUnit(building);
  assert.equal((await call("PUT", `/properties/units/${unit._id}`, { user: OTHER_HOST, body: unitBody() })).status, 403);
  const edited = await call("PUT", `/properties/units/${unit._id}`, { user: HOST, body: { title: "Renamed", unitDetails: { label: "9Z", availability: { status: "let" } } } });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.unit.title, "Renamed");
  assert.equal(edited.body.unit.unitDetails.availability.status, "let");
  assert.equal(edited.body.unit.pricing.monthly, 1000); // untouched: pricing was not sent
  assert.equal((await call("PUT", `/properties/units/${unit._id}`, { user: HOST, body: { unitDetails: { sizeSqFt: -1 } } })).status, 400);
  assert.equal((await call("PUT", `/properties/units/${building._id}`, { user: HOST, body: { title: "x" } })).status, 404); // not a unit
  assert.equal((await call("DELETE", `/properties/units/${unit._id}`, { user: OTHER_HOST })).status, 403);
  assert.equal((await call("DELETE", `/properties/units/${unit._id}`, { user: ADMIN })).status, 204);
  assert.equal(store.has(String(unit._id)), false);
  assert.equal(store.has(String(building._id)), true);
});

// ── Reading ──────────────────────────────────────────────────────────────
test("GET a building returns its units with quotes, unitsAvailable and fromPricePence", async () => {
  const building = seed();
  const dear = seedUnit(building, { title: "Dear", pricing: { pricingType: "MONTHLY", monthly: 2000 } });
  const cheap = seedUnit(building, { title: "Cheap", pricing: { pricingType: "MONTHLY", monthly: 1000, vat: { monthly: { status: "excludes", ratePct: 20, enteredPence: 100000, netPence: 100000, vatPence: 20000, grossPence: 120000, utilities: { amountPence: 5000, per: "unit", vatable: true } } } } });
  const taken = seedUnit(building, { title: "Taken", pricing: { pricingType: "MONTHLY", monthly: 500 }, unitDetails: { label: "T", availability: { status: "let" } } });
  const later = seedUnit(building, { title: "Later", pricing: { pricingType: "MONTHLY", monthly: 1500 }, unitDetails: { label: "L", availability: { status: "available_from", availableFrom: new Date("2027-01-01") } } });

  for (const path of [String(building._id), String(building._id)]) { // second read comes from the cache
    const { status, body } = await call("GET", `/properties/${path}`);
    assert.equal(status, 200);
    const property = body.property;
    assert.equal(property.listingType, "building");
    assert.equal(property.unitsAvailable, 3);
    assert.equal(property.fromPricePence, 126000); // Cheap: 1000 + 50 utilities + 20% VAT
    assert.deepEqual(property.units.map((u) => u.title), ["Dear", "Cheap", "Taken", "Later"]);
    const cheapUnit = property.units.find((u) => u.title === "Cheap");
    assert.deepEqual(Object.keys(cheapUnit).sort(), ["_id", "pricing", "quote", "title", "unitDetails"]);
    assert.equal(cheapUnit.quote.totalPence, 126000);
    assert.equal(cheapUnit.quote.vatPence, 21000);
    assert.equal(cheapUnit.quote.commissionPence, undefined);
    assert.equal(property.units.find((u) => u.title === "Dear").quote.totalPence, 200000);
  }
  // a unit added later shows up despite the cached building
  seedUnit(building, { title: "New", pricing: { pricingType: "MONTHLY", monthly: 100 } });
  const { body } = await call("GET", `/properties/${building._id}`);
  assert.equal(body.property.unitsAvailable, 4);
  assert.equal(body.property.fromPricePence, 10000);
  void dear; void cheap; void taken; void later;
});

test("a building with no available units has fromPricePence null", async () => {
  const building = seed();
  seedUnit(building, { unitDetails: { label: "x", availability: { status: "let" } } });
  const { body } = await call("GET", `/properties/${building._id}`);
  assert.equal(body.property.unitsAvailable, 0);
  assert.equal(body.property.fromPricePence, null);
});

test("GET a unit returns it with parentBuilding and the building's photos", async () => {
  const building = seed({ slug: "synthetic-tower" });
  const unit = seedUnit(building);
  for (let i = 0; i < 2; i++) { // never cached, so the second read is the same
    const { status, body } = await call("GET", `/properties/${unit._id}`);
    assert.equal(status, 200);
    assert.deepEqual(body.property.parentBuilding, { _id: String(building._id), slug: "synthetic-tower", title: "Synthetic Tower" });
    assert.deepEqual(body.property.images, building.images);
    assert.equal(body.property.coverImage, building.coverImage);
    assert.equal(body.property.listingType, "unit");
  }
});

test("a unit is hidden while its building is unpublished, except to the owner", async () => {
  const building = seed({ isActive: false });
  const unit = seedUnit(building);
  assert.equal((await call("GET", `/properties/${unit._id}`)).status, 404);
  assert.equal((await call("GET", `/properties/${unit._id}`, { token: OTHER_HOST })).status, 404);
  assert.equal((await call("GET", `/properties/${building._id}`)).status, 404);
  assert.equal((await call("GET", `/properties/${unit._id}`, { token: HOST })).status, 200);
});

// ── Lists never show units ───────────────────────────────────────────────
test("home, list, search, near-me, cities and /me leave units out; building cards carry the summary", async () => {
  const building = seed();
  seedUnit(building, { pricing: { pricingType: "MONTHLY", monthly: 800 } });
  seedUnit(building, { pricing: { pricingType: "MONTHLY", monthly: 600 }, unitDetails: { label: "y", availability: { status: "let" } } });
  const single = seed({ listingType: "single", title: "Plain" });
  const legacy = seed({ title: "Legacy" });
  legacy.listingType = undefined; // a listing made before listingType existed
  const ids = [building, single, legacy].map((d) => String(d._id)).sort();

  const home = await call("GET", "/properties");
  const search = await call("GET", "/properties/search");
  const nearMe = await call("GET", "/properties/near-me");
  const mine = await call("GET", "/properties/me", { user: HOST });
  for (const [name, res] of Object.entries({ home, search, nearMe, mine })) {
    assert.equal(res.status, 200, name);
    assert.deepEqual(res.body.properties.map((p) => p._id).sort(), ids, name);
    const card = res.body.properties.find((p) => p._id === String(building._id));
    assert.equal(card.unitsAvailable, 1, name);
    assert.equal(card.fromPricePence, 80000, name);
    assert.equal(card.units, undefined, name);
    assert.equal(res.body.properties.find((p) => p._id === String(single._id)).unitsAvailable, undefined, name);
  }
  assert.equal(home.body.total, 3);

  pipelines = [];
  await call("GET", "/properties/cities");
  await call("GET", "/properties/neighborhoods");
  assert.equal(pipelines.length, 2);
  for (const [{ $match }] of pipelines) assert.deepEqual($match.listingType, { $ne: "unit" });
});

// ── Deleting / unpublishing ──────────────────────────────────────────────
test("deleting a building deletes its units and leaves other listings alone", async () => {
  const building = seed();
  const unit = seedUnit(building);
  const otherBuilding = seed({ title: "Other" });
  const otherUnit = seedUnit(otherBuilding);
  assert.equal((await call("DELETE", `/properties/${building._id}`, { user: OTHER_HOST })).status, 403);
  assert.equal(store.has(String(unit._id)), true);
  assert.equal((await call("DELETE", `/properties/${building._id}`, { user: HOST })).status, 204);
  assert.equal(store.has(String(building._id)), false);
  assert.equal(store.has(String(unit._id)), false);
  assert.equal(store.has(String(otherUnit._id)), true);
});

// ── Enquiries ────────────────────────────────────────────────────────────
test("an enquiry about a unit is prefixed with the unit label and still emails the host", async () => {
  const building = seed();
  const unit = seedUnit(building, { unitDetails: { label: "Suite 2A", availability: { status: "available" } } });
  const res = await call("POST", "/messages/enquiry", { user: GUEST, body: { propertyId: String(building._id), unitId: String(unit._id), guests: 3, message: "Is it still free?" } });
  assert.equal(res.status, 200);
  assert.ok(sent[0].text.startsWith("Enquiry about Suite 2A:"), sent[0].text);
  assert.match(sent[0].text, /Is it still free\?/);
  assert.doesNotMatch(sent[0].text, /Invalid Date/);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(emails.length, 1);
  assert.equal(emails[0].to, "host@synthetic.example.test");
});

test("an enquiry about a unit of a different building is refused; ordinary enquiries are unchanged", async () => {
  const building = seed();
  const otherUnit = seedUnit(seed({ title: "Other" }));
  const bad = await call("POST", "/messages/enquiry", { user: GUEST, body: { propertyId: String(building._id), unitId: String(otherUnit._id), message: "hi" } });
  assert.equal(bad.status, 400);
  assert.equal(sent.length, 0);

  const plain = await call("POST", "/messages/enquiry", { user: GUEST, body: { propertyId: String(building._id), checkIn: "2027-01-01", checkOut: "2027-01-05", guests: 2, durationType: "daily", totalPrice: 100, message: "hello" } });
  assert.equal(plain.status, 200);
  assert.ok(sent[0].text.startsWith("📅 Booking Enquiry"));
});
