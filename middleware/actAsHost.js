const mongoose = require("mongoose");
const User = require("../models/User");

// Lets a VenCome admin build a listing for a customer with the host's own
// wizard: the client sends "X-Act-As-Host: <host user id>" on the draft and
// create-listing requests. Run it AFTER the normal auth middleware.
//
// - Without the header nothing changes (the request stays the caller's own).
// - With it, the caller must be an admin whose role covers drafts (the same
//   tiers as the admin drafts routes: full_admin or support). Anyone else
//   gets 403, so a host can never use it to reach another host's drafts.
// - The request then runs as the host, with impersonatedBy set to the admin.
//   Drafts and listings are created with createdBy = the admin (existing
//   `req.user.impersonatedBy || req.user.id` logic), and actions that are
//   blocked during support access (payout methods, passwords) stay blocked.
const ALLOWED_ADMIN_ROLES = ["full_admin", "support"];

module.exports = async function actAsHost(req, res, next) {
  const hostId = req.header("x-act-as-host");
  if (!hostId) return next();
  try {
    if (!mongoose.isValidObjectId(hostId)) return res.status(400).json({ error: "Invalid host" });
    const admin = await User.findById(req.user.id).select("_id isAdmin adminRole");
    if (!admin || !admin.isAdmin) return res.status(403).json({ error: "Admin access required to act for a host" });
    if (!ALLOWED_ADMIN_ROLES.includes(admin.adminRole || "full_admin")) {
      return res.status(403).json({ error: "Your admin role doesn't have access to this" });
    }
    const host = await User.findById(hostId).select("_id");
    if (!host) return res.status(404).json({ error: "Host not found" });
    req.user = { ...req.user, id: String(host._id), impersonatedBy: String(admin._id), actingForHost: true };
    console.log(`[Audit] Admin ${admin._id} acting for host ${host._id}: ${req.method} ${req.originalUrl}`);
    next();
  } catch (err) {
    console.error("Act-as-host error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
};
