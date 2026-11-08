// How a listing is named in booking emails, notifications, invoices and admin
// tables. A room (unit) is named with its building -- "Room 3 at Tower House" --
// so a guest or host can tell which building a booking is in. Needs the
// property's listingType and parentBuildingTitle (a room's copy of its
// building's title); without them it falls back to the plain title.
function listingName(property, style = "at") {
  if (!property) return undefined;
  const { title, listingType, parentBuildingTitle } = property;
  if (listingType !== "unit" || !parentBuildingTitle || !title) return title;
  return style === "admin" ? `${title} (${parentBuildingTitle})` : `${title} at ${parentBuildingTitle}`;
}

module.exports = { listingName };
