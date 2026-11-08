// Synthetic data only: no database, no client listings.
const test = require("node:test");
const assert = require("node:assert/strict");
const { roomSitemapEntries } = require("../utils/roomSitemap");

const baseUrl = "https://www.vencome.com";
const building = { _id: "b1", slug: "tower-house", listingType: "building" };
const room = (over = {}) => ({ _id: "r1", listingType: "unit", isActive: true, roomSlug: "room-3c", parentBuilding: "b1", updatedAt: "2026-11-08T10:00:00Z", ...over });

test("a published room of a public building is listed at its canonical nested URL", () => {
  const [entry] = roomSitemapEntries({ buildings: [building], rooms: [room()], baseUrl });
  assert.equal(entry.loc, "https://www.vencome.com/property/tower-house/room-3c");
  assert.equal(entry.lastmod, "2026-11-08");
  assert.equal(entry.changefreq, "weekly");
});

test("inactive, let, slug-less and orphaned rooms are left out", () => {
  const rooms = [
    room({ _id: "a", isActive: false, roomSlug: "inactive" }),
    room({ _id: "b", roomSlug: "let-room", unitDetails: { availability: { status: "let" } } }),
    room({ _id: "c", roomSlug: undefined }),
    room({ _id: "d", roomSlug: "orphan", parentBuilding: "not-a-public-building" }),
    room({ _id: "e", listingType: "single", roomSlug: "single" }),
  ];
  assert.deepEqual(roomSitemapEntries({ buildings: [building], rooms, baseUrl }), []);
});

test("an available_from room is listed, and duplicates collapse to one entry", () => {
  const rooms = [room({ _id: "x", roomSlug: "later", unitDetails: { availability: { status: "available_from" } } }), room({ _id: "y", roomSlug: "later" })];
  const entries = roomSitemapEntries({ buildings: [building], rooms, baseUrl });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].loc, "https://www.vencome.com/property/tower-house/later");
});

test("only buildings in the public list can parent a listed room", () => {
  assert.deepEqual(roomSitemapEntries({ buildings: [{ _id: "b2", slug: "hidden", listingType: "single" }], rooms: [room({ parentBuilding: "b2" })], baseUrl }), []);
});
