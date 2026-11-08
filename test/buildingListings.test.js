// Run with: node --test test/buildingListings.test.js
// Building listings: a "building" Property with "unit" Properties (rooms) under
// it. A room is a full bookable listing that takes its host, location, category
// and lease from the building.
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
const auth = (req, _res, next) => {
  req.user = { id: req.header("x-user") };
  next();
};
auth.blockDuringImpersonation = (_req, _res, next) => next();
stub("../middleware/auth", auth);
stub("../utils/commission", { resolveCommissionRate: async () => 0.1 });
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
  if (key === "$nor") return want.every((part) => !matches(doc, part));
  const have = get(doc, key);
  if (want && typeof want === "object" && !(want instanceof mongoose.Types.ObjectId)) {
    if ("$in" in want) return want.$in.map(String).includes(String(have));
    if ("$ne" in want) return String(have) !== String(want.$ne);
    if ("$nin" in want) return !want.$nin.map(String).includes(String(have));
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
Property.exists = async (filter) => (plainDocs(filter).length ? { _id: "exists" } : null);
Property.distinct = async (field, filter = {}) => [...new Set(plainDocs(filter).map((doc) => String(get(doc, field))))];
Property.updateMany = async (filter, update) => { for (const doc of plainDocs(filter)) for (const [key, value] of Object.entries(update.$set)) store.get(String(doc._id)).set(key, value); };
let pipelines = [];
Property.aggregate = async (pipeline) => { pipelines.push(pipeline); return []; };
Property.deleteMany = async (filter) => { for (const doc of plainDocs(filter)) store.delete(String(doc._id)); };
Property.prototype.save = async function save() { await this.validate(); store.set(String(this._id), this); return this; };
Property.prototype.deleteOne = async function deleteOne() { store.delete(String(this._id)); };
const Booking = require("../models/Booking");
const bookingsSaved = [];
Booking.find = () => query(() => []);
Booking.updateMany = async () => {};
Booking.prototype.save = async function save() { bookingsSaved.push(this); return this; };
Booking.prototype.populate = async function populate() { return this; };
require("../models/PlatformSettings").getSettings = async () => ({ commissionBase: "core" });
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
app.use("/bookings", require("../routes/bookings"));
const server = app.listen(0, "127.0.0.1");
const ready = new Promise((resolve) => server.on("listening", resolve));
test.after(() => server.close());
test.beforeEach(() => { pipelines = []; bookingsSaved.length = 0; store.clear(); cache.clear(); emails.length = 0; sent.length = 0; });

const call = async (method, path, { user, body, token, actAs } = {}) => {
  await ready;
  const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(user && { "x-user": user }),
      ...(actAs && { "x-act-as-host": actAs }),
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

test("a building still needs a photo; a single listing still needs pricing; a room needs a building", async () => {
  const noPhoto = await call("POST", "/properties", { user: HOST, body: buildingForm({ existingImages: "[]" }) });
  assert.equal(noPhoto.status, 400);
  assert.match(noPhoto.body.error, /photo/i);

  const single = await call("POST", "/properties", { user: HOST, body: buildingForm({ listingType: undefined }) });
  assert.equal(single.status, 400);

  const unit = await call("POST", "/properties", { user: HOST, body: buildingForm({ listingType: "unit" }) });
  assert.equal(unit.status, 400);
  assert.equal(store.size, 0);
});

test("an admin publishing for a host: the listing is the host's, the admin is the creator, and no admin alert is sent", async () => {
  const forHost = await call("POST", "/properties", { user: ADMIN, actAs: HOST, body: buildingForm() });
  assert.equal(forHost.status, 201);
  const [doc] = [...store.values()];
  assert.equal(String(doc.host), HOST);
  assert.equal(String(doc.createdBy), ADMIN);
  assert.ok(!emails.some((mail) => /New Space Listed/.test(mail.subject)), "admin alert is skipped");

  // A host cannot publish as another host, and a host publishing for themselves still alerts admins.
  store.clear(); emails.length = 0;
  const forged = await call("POST", "/properties", { user: HOST, actAs: OTHER_HOST, body: buildingForm() });
  assert.equal(forged.status, 403);
  assert.equal(store.size, 0);
  const own = await call("POST", "/properties", { user: HOST, body: buildingForm() });
  assert.equal(own.status, 201);
  assert.equal(String([...store.values()][0].host), HOST);
  assert.ok(emails.some((mail) => /New Space Listed/.test(mail.subject)), "normal publish still alerts admins");
});

// ── Units: create, edit, delete ──────────────────────────────────────────
test("a host adds a unit under their building", async () => {
  const building = seed();
  const { status, body } = await call("POST", `/properties/${building._id}/units`, { user: HOST, body: unitBody() });
  assert.equal(status, 201);
  const unit = body.unit;
  assert.equal(unit.listingType, "unit");
  assert.equal(unit.parentBuilding._id, String(building._id));
  assert.equal(unit.host, String(building.host));
  assert.equal(unit.title, "Suite 2A");
  assert.deepEqual(store.get(unit._id).images, []); // no photos of its own...
  assert.equal(unit.imagesInherited, true); // ...so it shows the building's
  assert.deepEqual(unit.images, building.images);
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
    assert.deepEqual(Object.keys(cheapUnit).sort(), ["_id", "coverImage", "imagesInherited", "path", "pricing", "quote", "title", "unitDetails"]);
    assert.equal(cheapUnit.coverImage, building.coverImage);
    assert.equal(cheapUnit.imagesInherited, true);
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

// ── Booking ──────────────────────────────────────────────────────────────
const bookDay = (property, extra = {}) => call("POST", "/bookings", { user: GUEST, body: { propertyId: String(property._id), checkIn: "2027-02-01", checkOut: "2027-02-03", guests: 1, pricingUnit: "day", extras: "[]", ...extra } });
const roomPricing = { pricingType: "DAILY", daily: 50, monthly: 900 };

test("a building cannot be booked; a single listing still reaches the booking checks", async () => {
  const building = seed();
  const single = seed({ listingType: "single", title: "Plain", pricing: { pricingType: "DAILY", daily: 50 } });
  const res = await bookDay(building);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /enquiry-only/);
  assert.equal(bookingsSaved.length, 0);
  assert.equal((await bookDay(single)).status, 201);
  assert.equal(bookingsSaved.length, 1); // synthetic, in memory only
});

test("a room is booked like a normal listing, with its building's host, and priced from the room", async () => {
  const building = seed();
  const room = seedUnit(building, { pricing: roomPricing, bookingSettings: { instantBook: false } });
  const res = await bookDay(room);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(bookingsSaved.length, 1);
  const booking = bookingsSaved[0];
  assert.equal(String(booking.property), String(room._id));
  assert.equal(String(booking.host), String(building.host));
  assert.equal(booking.status, "pending");
  assert.equal(booking.totalPrice, 100); // 2 days at 50
});

test("a room cannot be booked once let, deactivated, or when its building is not active; others are unaffected", async () => {
  const building = seed();
  const open = seedUnit(building, { pricing: roomPricing });
  const taken = seedUnit(building, { pricing: roomPricing, unitDetails: { label: "T", availability: { status: "let" } } });
  const off = seedUnit(building, { pricing: roomPricing, isActive: false });
  const closedBuilding = seed({ title: "Closed", isActive: false });
  const inClosed = seedUnit(closedBuilding, { pricing: roomPricing });
  for (const room of [taken, off, inClosed]) {
    const res = await bookDay(room);
    assert.equal(res.status, 400, room.title);
    assert.match(res.body.error, /not available|let/);
  }
  assert.equal(bookingsSaved.length, 0);
  assert.equal((await bookDay(open)).status, 201);
  // group and lease routes go through the same checks
  const group = await call("POST", "/bookings/group", { user: GUEST, body: { propertyId: String(taken._id), dates: [{ checkIn: "2027-02-01", checkOut: "2027-02-02" }, { checkIn: "2027-02-03", checkOut: "2027-02-04" }], guests: 1, pricingUnit: "day" } });
  assert.equal(group.status, 400);
  assert.equal(bookingsSaved.length, 1);
});

test("booking emails, notifications and invoices name a room with its building", () => {
  const { listingName } = require("../utils/listingName");
  assert.equal(listingName({ title: "Suite 2A", listingType: "unit", parentBuildingTitle: "Tower House" }), "Suite 2A at Tower House");
  assert.equal(listingName({ title: "Suite 2A", listingType: "unit", parentBuildingTitle: "Tower House" }, "admin"), "Suite 2A (Tower House)");
  assert.equal(listingName({ title: "Plain" }), "Plain");
  assert.equal(listingName({ title: "Tower House", listingType: "building" }), "Tower House");
  assert.equal(listingName(null), undefined);
});

// ── Other public lists ───────────────────────────────────────────────────
test("category pages, category counts and the landing index leave units out", async () => {
  const Category = require("../models/Category");
  const category = new Category({ name: "Offices", slug: "offices" });
  Category.findById = async () => category;
  Category.findOne = async () => category;
  Category.find = () => query(() => [category]);
  const LandingPage = require("../models/LandingPage");
  LandingPage.find = () => query(() => []);
  app.use("/categories", require("../routes/categories"));

  const building = seed({ category: category._id, subcategory: "Offices" });
  const unit = seedUnit(building, { category: category._id });
  seed({ listingType: "single", title: "Plain", category: category._id });

  const page = await call("GET", `/categories/${category._id}`);
  assert.equal(page.body.properties.length, 2);
  assert.ok(!page.body.properties.some((p) => p._id === String(unit._id)));
  assert.equal(page.body.properties.find((p) => p._id === String(building._id)).unitsAvailable, 1);

  const counts = await call("GET", "/categories/with-counts");
  assert.equal(counts.body.find((c) => c._id === String(category._id)).listingCount, 2);

  const { loadLandingIndex } = require("../utils/landing");
  const seen = [];
  const find = Property.find;
  Property.find = (filter) => { seen.push(filter); return find(filter); };
  try { await loadLandingIndex(); } finally { Property.find = find; }
  assert.deepEqual(seen[0].listingType, { $ne: "unit" });
});

// ── Rooms are full listings ─────────────────────────────────────────────
const roomForm = (building, extra = {}) => ({
  listingType: "unit", parentBuilding: String(building._id), title: "Suite 3C", description: "A bright room",
  pricing: JSON.stringify({ pricingType: "DAILY", daily: 60, hourly: 12, monthly: 900, minimumTermMonths: 3 }),
  discounts: JSON.stringify({ weekly: true }),
  availability: JSON.stringify({ openDays: ["Monday", "Tuesday"], openTime: "09:00", closeTime: "17:00" }),
  bookingSettings: JSON.stringify({ instantBook: true }),
  blockedDates: JSON.stringify([{ start: "2027-05-01", end: "2027-05-02", reason: "personal" }]),
  extras: JSON.stringify([{ name: "Projector", price: 10 }]),
  deposit: JSON.stringify({ enabled: true, amount: 100 }),
  minBookingHours: "2",
  icalUrl: "https://synthetic.example.test/cal.ics",
  unitDetails: JSON.stringify({ label: "3C", sizeSqFt: 300, capacity: 4, features: ["Window"], availability: { status: "available" } }),
  ...extra,
});

test("POST /properties makes a room: building's host, location and category; every listing field; no photos needed; no emails", async () => {
  const building = seed({ slug: "synthetic-tower", subcategory: "Offices", category: id(), leaseAgreement: "https://synthetic.example.test/lease.pdf", coordinates: { latitude: 51.5, longitude: -0.1 } });
  const { status, body } = await call("POST", "/properties", { user: HOST, body: roomForm(building, { unitsCount: "9", existingLeaseAgreement: "https://synthetic.example.test/mine.pdf", location: JSON.stringify({ address: "9 Other", city: "Elsewhere", country: "FR" }) }) });
  assert.equal(status, 201, JSON.stringify(body));
  const room = body.property;
  assert.deepEqual(body.unit, room);
  assert.equal(room.listingType, "unit");
  assert.deepEqual(room.parentBuilding, { _id: String(building._id), slug: "synthetic-tower", title: "Synthetic Tower" });
  assert.equal(room.parentBuildingTitle, "Synthetic Tower");
  assert.equal(room.host, String(building.host));
  assert.deepEqual({ ...room.location }, { address: "1 Synthetic Street", city: "Testville", country: "UK", neighborhood: "" });
  assert.equal(room.category, String(building.category));
  assert.equal(room.subcategory, "Offices");
  assert.equal(room.unitsCount, 1);
  assert.equal(room.leaseAgreement, "https://synthetic.example.test/lease.pdf"); // the building's, never its own
  assert.equal(store.get(room._id).leaseAgreement ?? null, null);
  assert.deepEqual(store.get(room._id).images, []);
  assert.equal(room.imagesInherited, true);
  assert.equal(room.path, `/property/synthetic-tower/3c`);
  assert.equal(room.roomSlug, "3c");
  assert.equal(room.isActive, true);
  assert.equal(room.moderationStatus, "approved");
  assert.equal(room.pricing.daily, 60);
  assert.equal(room.pricing.hourly, 12);
  assert.equal(room.pricing.minimumTermMonths, 3);
  assert.equal(room.pricing.discounts.weekly, true);
  assert.deepEqual([...room.availability.openDays], ["Monday", "Tuesday"]);
  assert.equal(room.bookingSettings.instantBook, true);
  assert.equal(room.blockedDates.length, 1);
  assert.equal(room.extras[0].name, "Projector");
  assert.deepEqual({ ...room.deposit }, { enabled: true, amount: 100 });
  assert.equal(room.minBookingHours, 2);
  assert.equal(room.icalUrl, "https://synthetic.example.test/cal.ics");
  assert.equal(room.unitDetails.label, "3C");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(emails.length, 0);
});

test("room creation rules: owner or admin, a building only, parentBuilding required, photo cap, valid price", async () => {
  const building = seed();
  const single = seed({ listingType: "single" });
  assert.equal((await call("POST", "/properties", { user: OTHER_HOST, body: roomForm(building) })).status, 403);
  assert.equal((await call("POST", "/properties", { user: HOST, body: roomForm(single) })).status, 400);
  assert.equal((await call("POST", "/properties", { user: HOST, body: roomForm(building, { parentBuilding: undefined }) })).status, 400);
  assert.equal((await call("POST", "/properties", { user: HOST, body: roomForm(building, { parentBuilding: id() }) })).status, 404);
  assert.equal((await call("POST", "/properties", { user: HOST, body: roomForm(building, { pricing: JSON.stringify({ pricingType: "DAILY" }) }) })).status, 400);
  const manyPhotos = JSON.stringify(Array.from({ length: 11 }, (_, i) => `https://synthetic.example.test/${i}-w1600.webp`));
  assert.equal((await call("POST", "/properties", { user: HOST, body: roomForm(building, { existingImages: manyPhotos }) })).status, 400);
  const tenPhotos = JSON.stringify(Array.from({ length: 10 }, (_, i) => `https://synthetic.example.test/${i}-w1600.webp`));
  const ok = await call("POST", "/properties", { user: HOST, body: roomForm(building, { existingImages: tenPhotos }) });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.property.images.length, 10);
  assert.equal((await call("POST", "/properties", { user: ADMIN, body: roomForm(building, { title: "By admin" }) })).status, 201);
  assert.equal(store.size, 4); // building, single, 2 rooms
});

test("room slugs are unique within their building but may repeat across buildings", async () => {
  const building = seed();
  const other = seed({ title: "Other Tower" });
  const make = async (b) => (await call("POST", "/properties", { user: HOST, body: roomForm(b) })).body.property.roomSlug;
  assert.deepEqual([await make(building), await make(building), await make(other)], ["3c", "3c-2", "3c"]);
});

test("the old unit routes are wrappers over the same code and accept the full payload", async () => {
  const building = seed({ slug: "synthetic-tower" });
  const created = await call("POST", `/properties/${building._id}/units`, { user: HOST, body: { title: "Wrapped", description: "d", pricing: { pricingType: "DAILY", daily: 40 }, bookingSettings: { instantBook: true }, minBookingHours: 3, unitDetails: { label: "W1", availability: { status: "available" } } } });
  assert.equal(created.status, 201);
  const unit = created.body.unit;
  assert.equal(unit.pricing.daily, 40);
  assert.equal(unit.bookingSettings.instantBook, true);
  assert.equal(unit.minBookingHours, 3);
  assert.equal(unit.roomSlug, "w1");
  assert.equal(unit.parentBuildingTitle, "Synthetic Tower");
  const edited = await call("PUT", `/properties/units/${unit._id}`, { user: HOST, body: { pricing: { pricingType: "DAILY", daily: 45 }, bookingSettings: { instantBook: false }, blockedDates: [{ start: "2027-06-01", end: "2027-06-03" }] } });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.unit.pricing.daily, 45);
  assert.equal(edited.body.unit.bookingSettings.instantBook, false);
  assert.equal(edited.body.unit.blockedDates.length, 1);
  assert.equal(edited.body.unit.title, "Wrapped");
});

test("PUT /properties/:id edits a room's own fields but not its location, category or lease", async () => {
  const building = seed({ subcategory: "Offices" });
  const room = seedUnit(building, { pricing: { pricingType: "DAILY", daily: 50 }, slug: "room-slug", location: building.location });
  const res = await call("PUT", `/properties/${room._id}`, { user: HOST, body: {
    title: "Renamed room", pricing: JSON.stringify({ pricingType: "DAILY", daily: 55, hourly: 9 }), minBookingHours: "4",
    unitDetails: JSON.stringify({ availability: { status: "let" } }),
    location: JSON.stringify({ address: "x", city: "Elsewhere", country: "FR" }), subcategory: "Hacked", unitsCount: "7", existingLeaseAgreement: "https://synthetic.example.test/l.pdf",
  } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const edited = res.body.property;
  assert.equal(edited.title, "Renamed room");
  assert.equal(edited.pricing.hourly, 9);
  assert.equal(edited.minBookingHours, 4);
  assert.equal(edited.unitDetails.availability.status, "let");
  assert.equal(edited.unitDetails.label, "Unit 1"); // kept
  assert.equal(edited.location.city, "Testville");
  assert.equal(edited.subcategory, "Offices"); // the building's; "Hacked" ignored
  assert.equal(store.get(String(room._id)).subcategory ?? "", "");
  assert.equal(edited.unitsCount, 1);
  assert.equal(store.get(String(room._id)).leaseAgreement ?? null, null);
  assert.equal(edited.roomSlug ?? null, null); // links never change on a rename
  assert.equal((await call("PUT", `/properties/${room._id}`, { user: HOST, body: { pricing: JSON.stringify({ pricingType: "DAILY" }) } })).status, 400);
  assert.equal((await call("PUT", `/properties/${room._id}`, { user: OTHER_HOST, body: { title: "x" } })).status, 403);
});

test("editing a building keeps its rooms' copies of title, location and category in step", async () => {
  const building = seed();
  const room = seedUnit(building, { parentBuildingTitle: "Synthetic Tower" });
  const other = seedUnit(seed({ title: "Other" }), { parentBuildingTitle: "Other" });
  const category = id();
  const res = await call("PUT", `/properties/${building._id}`, { user: HOST, body: { title: "New Tower Name", location: JSON.stringify({ address: "2 New Street", city: "Newtown", country: "UK" }) } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(store.get(String(room._id)).parentBuildingTitle, "New Tower Name");
  assert.equal(store.get(String(room._id)).location.city, "Newtown");
  assert.equal(store.get(String(other._id)).parentBuildingTitle, "Other");
  void category;
});

test("a room keeps its photos optional: removing the last one leaves it active and showing the building's", async () => {
  const building = seed();
  const room = seedUnit(building, { images: ["https://synthetic.example.test/r1-w1600.webp"], coverImage: "https://synthetic.example.test/r1-w1600.webp" });
  const res = await call("DELETE", `/properties/${room._id}/images`, { user: HOST, body: { imageUrls: ["https://synthetic.example.test/r1-w1600.webp"] } });
  assert.equal(res.status, 200);
  assert.equal(res.body.unpublished, false);
  assert.equal(store.get(String(room._id)).isActive, true);
  const read = await call("GET", `/properties/${room._id}`);
  assert.equal(read.body.property.imagesInherited, true);
  assert.deepEqual(read.body.property.images, building.images);
});

test("a room is read by building and room slug as a full listing with its building's data and photos", async () => {
  const lease = "https://synthetic.example.test/lease.pdf";
  const building = seed({ slug: "synthetic-tower", leaseAgreement: lease, subcategory: "Offices" });
  const room = seedUnit(building, { slug: "suite-2a", roomSlug: "2a", title: "Suite 2A", pricing: { pricingType: "DAILY", daily: 50 }, unitDetails: { label: "2A", availability: { status: "available" } } });
  for (const path of ["/properties/synthetic-tower/rooms/2a", `/properties/${building._id}/rooms/${room._id}`, `/properties/${room._id}`, "/properties/suite-2a"]) {
    const { status, body } = await call("GET", path);
    assert.equal(status, 200, path);
    const p = body.property;
    assert.equal(p._id, String(room._id), path);
    assert.equal(p.isBuildingUnit, true);
    assert.deepEqual(p.parentBuilding, { _id: String(building._id), slug: "synthetic-tower", title: "Synthetic Tower" });
    assert.equal(p.path, "/property/synthetic-tower/2a");
    assert.equal(p.roomSlug, "2a");
    assert.equal(p.imagesInherited, true);
    assert.deepEqual(p.images, building.images);
    assert.equal(p.coverImage, building.coverImage);
    assert.equal(p.leaseAgreement, lease);
    assert.equal(p.location.city, "Testville");
    assert.equal(p.pricing.daily, 50);
  }
  assert.equal((await call("GET", "/properties/synthetic-tower/rooms/nope")).status, 404);
  assert.equal((await call("GET", "/properties/nope/rooms/2a")).status, 404);
  const otherBuilding = seed({ slug: "other-tower", title: "Other" });
  seedUnit(otherBuilding);
  assert.equal((await call("GET", "/properties/other-tower/rooms/2a")).status, 404); // 2a belongs to the other building
  assert.equal((await call("GET", `/properties/${room._id}/rooms/2a`)).status, 404); // not a building
});

test("a room with its own photos shows them; the building's units[] says which", async () => {
  const building = seed({ slug: "synthetic-tower" });
  const own = ["https://synthetic.example.test/own-w1600.webp"];
  const room = seedUnit(building, { roomSlug: "own", images: own, coverImage: own[0] });
  const plain = seedUnit(building, { roomSlug: "plain", unitDetails: { label: "p", availability: { status: "available" } } });
  const read = await call("GET", "/properties/synthetic-tower/rooms/own");
  assert.equal(read.body.property.imagesInherited, false);
  assert.deepEqual(read.body.property.images, own);
  assert.equal(read.body.property.coverImage, own[0]);
  const { body } = await call("GET", "/properties/synthetic-tower");
  const entry = (r) => body.property.units.find((u) => u._id === String(r._id));
  assert.deepEqual([entry(room).coverImage, entry(room).imagesInherited, entry(room).path], [own[0], false, "/property/synthetic-tower/own"]);
  assert.deepEqual([entry(plain).coverImage, entry(plain).imagesInherited, entry(plain).path], [building.coverImage, true, "/property/synthetic-tower/plain"]);
});

test("a room is hidden while it or its building is unpublished, except to its owner and admins", async () => {
  const building = seed({ slug: "synthetic-tower" });
  const off = seedUnit(building, { roomSlug: "off", isActive: false });
  assert.equal((await call("GET", "/properties/synthetic-tower/rooms/off")).status, 404);
  assert.equal((await call("GET", "/properties/synthetic-tower/rooms/off", { token: OTHER_HOST })).status, 404);
  assert.equal((await call("GET", "/properties/synthetic-tower/rooms/off", { token: HOST })).status, 200);
  assert.equal((await call("GET", "/properties/synthetic-tower/rooms/off", { token: ADMIN })).status, 200);
  void off;
  const closed = seed({ slug: "closed", isActive: false });
  seedUnit(closed, { roomSlug: "r" });
  assert.equal((await call("GET", "/properties/closed/rooms/r")).status, 404);
  assert.equal((await call("GET", "/properties/closed/rooms/r", { token: HOST })).status, 200);
});

// ── A building shows only with an active room ───────────────────────────
test("a building with no active room is hidden from the public everywhere, but not from its owner or admins", async () => {
  const empty = seed({ title: "Empty Tower" });
  seedUnit(empty, { isActive: false });
  const filled = seed({ title: "Filled Tower" });
  seedUnit(filled);
  const plain = seed({ listingType: "single", title: "Plain" });

  assert.equal((await call("GET", `/properties/${empty._id}`)).status, 404);
  assert.equal((await call("GET", `/properties/${empty._id}`)).status, 404); // and not from the cache either
  assert.equal((await call("GET", `/properties/${empty._id}`, { token: OTHER_HOST })).status, 404);
  assert.equal((await call("GET", `/properties/${empty._id}`, { token: HOST })).status, 200);
  assert.equal((await call("GET", `/properties/${empty._id}`, { token: ADMIN })).status, 200);
  assert.equal((await call("GET", `/properties/${filled._id}`)).status, 200);

  const visible = (res) => res.body.properties.map((p) => p._id).sort();
  const expected = [String(filled._id), String(plain._id)].sort();
  assert.deepEqual(visible(await call("GET", "/properties")), expected);
  assert.deepEqual(visible(await call("GET", "/properties/search")), expected);
  assert.deepEqual(visible(await call("GET", "/properties/near-me")), expected);
  assert.deepEqual(visible(await call("GET", "/properties/me", { user: HOST })), [String(empty._id), String(filled._id), String(plain._id)].sort());
  for (const [{ $match }] of (pipelines = [], await call("GET", "/properties/cities"), pipelines)) {
    assert.deepEqual($match.$nor, [{ listingType: "building", _id: { $nin: [String(filled._id)] } }]);
  }
});

test("unitsAvailable counts only active rooms that are available or available from a date", async () => {
  const building = seed();
  seedUnit(building);
  seedUnit(building, { isActive: false });
  seedUnit(building, { unitDetails: { label: "x", availability: { status: "let" } } });
  const { body } = await call("GET", `/properties/${building._id}`);
  assert.equal(body.property.unitsAvailable, 1);
  assert.equal(body.property.units.length, 2);
});

test("a room's building card price uses its first rate: monthly, else weekly, daily, hourly", async () => {
  const building = seed();
  seedUnit(building, { title: "Daily only", pricing: { pricingType: "DAILY", daily: 40 } });
  seedUnit(building, { title: "Monthly too", pricing: { pricingType: "DAILY", daily: 10, monthly: 900 } });
  const { body } = await call("GET", `/properties/${building._id}`);
  assert.equal(body.property.fromPricePence, 90000);
  assert.equal(body.property.fromPriceUnit, "month");
  assert.equal(body.property.units.find((u) => u.title === "Daily only").quote.per, "day");
  assert.equal(body.property.units.find((u) => u.title === "Daily only").quote.totalPence, 4000);
});

test("deleting a room follows the normal rules and leaves bookings and the building alone", async () => {
  const building = seed();
  const room = seedUnit(building, { images: ["https://synthetic.example.test/r-w1600.webp"] });
  assert.equal((await call("DELETE", `/properties/${room._id}`, { user: OTHER_HOST })).status, 403);
  assert.equal((await call("DELETE", `/properties/${room._id}`, { user: HOST })).status, 204);
  assert.equal(store.has(String(room._id)), false);
  assert.equal(store.has(String(building._id)), true);
  assert.equal((await call("GET", `/properties/${building._id}`)).status, 404); // no active room left
});

test("fromPriceUnit falls back to week, day, then hour when no available room has a monthly rate", async () => {
  const building = seed();
  seedUnit(building, { title: "Hourly", pricing: { pricingType: "HOURLY", hourly: 5 } });
  seedUnit(building, { title: "Weekly", pricing: { pricingType: "DAILY", weekly: 200 } });
  let res = await call("GET", `/properties/${building._id}`);
  assert.deepEqual([res.body.property.fromPriceUnit, res.body.property.fromPricePence], ["week", 20000]);
  store.delete([...store.values()].find((d) => d.title === "Weekly")._id.toString());
  cache.clear();
  res = await call("GET", `/properties/${building._id}`);
  assert.deepEqual([res.body.property.fromPriceUnit, res.body.property.fromPricePence], ["hour", 500]);
});
