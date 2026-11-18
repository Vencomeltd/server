const jwt = require("jsonwebtoken");
const User = require("../models/User");

const auth = async (req, res, next) => {
  const token = req.header("Authorization")?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "No token provided" });

  // A bad or expired token is a 401. A database hiccup while checking the user
  // is NOT: it used to be reported as "Invalid or expired token", which made
  // the apps sign people out over a momentary server problem. It is now a 503
  // ("try again") and nobody is logged out.
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
  let user;
  try {
    // Verify user still exists and is active
    user = await User.findById(decoded.id).select("_id isVerified");
  } catch (err) {
    console.error("auth lookup failed:", err.message);
    return res.status(503).json({ error: "Temporary problem, please try again" });
  }
  if (!user) return res.status(401).json({ error: "User no longer exists" });
  req.user = decoded;
  next();
};

// Admin-only middleware
const adminAuth = async (req, res, next) => {
  const token = req.header("Authorization")?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "No token provided" });

  // 401 only when the token itself is bad or expired. A database error while
  // looking the admin up is a 503 (try again), not a 401: the admin panel
  // treats a 401 as "your session ended" and signs you out, so a momentary
  // server hiccup on any one of the dozen requests the dashboard fires on load
  // used to bounce admins straight back to the sign-in page.
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
  let user;
  try {
    user = await User.findById(decoded.id).select("_id isAdmin adminRole");
  } catch (err) {
    console.error("adminAuth lookup failed:", err.message);
    return res.status(503).json({ error: "Temporary problem, please try again" });
  }
  if (!user || !user.isAdmin) return res.status(403).json({ error: "Admin access required" });
  req.user = { ...decoded, isAdmin: true, adminRole: user.adminRole || "full_admin" };
  next();
};

// Scopes an admin route to specific tiers (e.g. requireAdminRole("finance")).
// Must run after adminAuth, which attaches req.user.adminRole. full_admin
// always passes regardless of which tiers are listed.
const requireAdminRole = (...allowedRoles) => (req, res, next) => {
  if (req.user?.adminRole === "full_admin" || allowedRoles.includes(req.user?.adminRole)) {
    return next();
  }
  res.status(403).json({ error: "Your admin role doesn't have access to this" });
};

// Blocks a specific action while the current session is an active admin
// "Account Access" impersonation (see routes/admin.js impersonate). Per the
// support-access spec, viewing/diagnosing is fine during a session, but
// changes to security-sensitive settings (password, payout method) need a
// separate explicit confirmation step, not silent access via impersonation.
const blockDuringImpersonation = (req, res, next) => {
  if (req.user?.impersonatedBy) {
    return res.status(403).json({
      error: "This action isn't available during a support access session.",
    });
  }
  next();
};

module.exports = auth;
module.exports.adminAuth = adminAuth;
module.exports.requireAdminRole = requireAdminRole;
module.exports.blockDuringImpersonation = blockDuringImpersonation;
