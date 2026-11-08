// Run with: node --test test/migrateBuildingListings.test.js
// scripts/migrateBuildingListings.js against an in-memory stand-in for the
// Property collection (synthetic records only; never a database).
const test = require("node:test");
const assert = require("node:assert/strict");
const Property = require("../models/Property");
const { migrate } = require("../scripts/migrateBuildingListings");

let docs;
const matches = (doc, filter) => Object.entries(filter).every(([key, want]) =>
  want && typeof want === "object" ? (key in doc) === want.$exists : doc[key] === want);
Property.countDocuments = async (filter) => docs.filter((d) => matches(d, filter)).length;
Property.updateMany = async (filter, update) => {
  const hit = docs.filter((d) => matches(d, filter));
  for (const d of hit) {
    Object.assign(d, update.$set);
    for (const key of Object.keys(update.$unset || {})) delete d[key];
  }
  return { modifiedCount: hit.length };
};
const quiet = () => {};
test.beforeEach(() => {
  docs = [
    { _id: "legacy-1" },
    { _id: "legacy-2", title: "Synthetic" },
    { _id: "single", listingType: "single", unitDetails: { label: "stray" } },
    { _id: "building", listingType: "building" },
    { _id: "unit", listingType: "unit", parentBuilding: "building", unitDetails: { label: "A" } },
  ];
});

test("dry run changes nothing, in either direction", async () => {
  const before = JSON.stringify(docs);
  assert.deepEqual(await migrate({ log: quiet }), { matched: 2, modified: 0 });
  assert.deepEqual(await migrate({ rollback: true, log: quiet }), { matched: 1, modified: 0 });
  assert.equal(JSON.stringify(docs), before);
});

test("--apply sets listingType single where it is missing and nothing else", async () => {
  assert.deepEqual(await migrate({ apply: true, log: quiet }), { matched: 2, modified: 2 });
  assert.deepEqual(docs.map((d) => d.listingType), ["single", "single", "single", "building", "unit"]);
  assert.deepEqual(docs[4], { _id: "unit", listingType: "unit", parentBuilding: "building", unitDetails: { label: "A" } });
  assert.deepEqual(await migrate({ apply: true, log: quiet }), { matched: 0, modified: 0 }); // idempotent
});

test("--rollback --apply unsets the fields only on single listings", async () => {
  await migrate({ apply: true, log: quiet });
  assert.deepEqual(await migrate({ rollback: true, apply: true, log: quiet }), { matched: 3, modified: 3 });
  assert.deepEqual(docs.slice(0, 3).map((d) => Object.keys(d)), [["_id"], ["_id", "title"], ["_id"]]);
  assert.deepEqual(docs[3], { _id: "building", listingType: "building" });
  assert.deepEqual(docs[4], { _id: "unit", listingType: "unit", parentBuilding: "building", unitDetails: { label: "A" } });
});
