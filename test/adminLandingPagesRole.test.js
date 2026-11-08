// Run with: node --test test/adminLandingPagesRole.test.js
// The SEO Pages admin routes are only for content admins (and full admins):
// checks the mount in routes/admin.js, not just the sub-router.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const express = require("express");

// Real requireAdminRole; adminAuth replaced by one that takes the role from
// a test header instead of a JWT + database lookup.
const authPath = require.resolve(path.join(__dirname, "../middleware/auth"));
const realAuth = require(authPath);
const fakeAuth = (req, _res, next) => next();
fakeAuth.adminAuth = (req, _res, next) => {
  req.user = { id: "admin1", isAdmin: true, adminRole: req.header("x-test-role") };
  next();
};
fakeAuth.requireAdminRole = realAuth.requireAdminRole;
fakeAuth.blockDuringImpersonation = (_req, _res, next) => next();
require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: fakeAuth };

const indexPath = require.resolve(path.join(__dirname, "../utils/landing/index.js"));
require.cache[indexPath] = {
  id: indexPath, filename: indexPath, loaded: true,
  exports: { loadLandingIndex: async () => ({ pages: new Map() }), resolveLandingPath: () => null },
};
const adminLanding = require.resolve(path.join(__dirname, "../utils/landing/admin.js"));
require.cache[adminLanding] = { id: adminLanding, filename: adminLanding, loaded: true, exports: { adminRowsFor: () => [], adminRowFor: () => null } };

const app = express();
app.use(express.json());
app.use("/admin", require("../routes/admin"));
const server = app.listen(0, "127.0.0.1");
const ready = new Promise((resolve) => server.on("listening", resolve));
test.after(() => server.close());

const call = async (method, role, body) => {
  await ready;
  const res = await fetch(`http://127.0.0.1:${server.address().port}/admin/landing-pages`, {
    method,
    headers: { "content-type": "application/json", "x-test-role": role },
    body: body && JSON.stringify(body),
  });
  return res.status;
};

test("support and finance admins can't read or edit SEO pages", async () => {
  for (const role of ["support", "finance"]) {
    assert.equal(await call("GET", role), 403, `${role} GET`);
    assert.equal(await call("PUT", role, { path: "/x", intro: "y" }), 403, `${role} PUT`);
  }
});

test("content and full admins can", async () => {
  for (const role of ["content", "full_admin"]) {
    assert.equal(await call("GET", role), 200, `${role} GET`);
  }
});
