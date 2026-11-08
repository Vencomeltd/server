// Sitemap entries for building rooms (units): /property/<building>/<room>.
// A room is listed only when it is published (active), has a stable roomSlug,
// is not marked let (a let room can't be booked), and its building is itself
// listed in the sitemap (public: active and with at least one active room).
// Duplicates are dropped. Rooms from before roomSlug existed have no nested
// URL and are skipped.
function roomSitemapEntries({ buildings, rooms, baseUrl }) {
  const slugByBuilding = new Map();
  for (const b of buildings || []) {
    if (b.listingType === "building") slugByBuilding.set(String(b._id), b.slug || String(b._id));
  }
  const seen = new Set();
  const entries = [];
  for (const room of rooms || []) {
    if (room.listingType !== "unit" || room.isActive !== true || !room.roomSlug) continue;
    if (room.unitDetails?.availability?.status === "let") continue;
    const buildingSlug = slugByBuilding.get(String(room.parentBuilding));
    if (!buildingSlug) continue;
    const loc = `${baseUrl}/property/${buildingSlug}/${room.roomSlug}`;
    if (seen.has(loc)) continue;
    seen.add(loc);
    entries.push({
      loc,
      priority: "0.8",
      changefreq: "weekly",
      lastmod: room.updatedAt ? new Date(room.updatedAt).toISOString().split("T")[0] : undefined,
    });
  }
  return entries;
}

module.exports = { roomSitemapEntries };
