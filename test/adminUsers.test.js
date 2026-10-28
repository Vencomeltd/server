// Run with: node --test test/adminUsers.test.js
// GET /admin/users/counts and the Users tab filter, over HTTP with the User
// model replaced by an in-memory list (no MongoDB needed).
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const express = require("express");

const pass = () => (_req, _res, next) => next();
const authPath = require.resolve(path.join(__dirname, "../middleware/auth"));
require.cache[authPath] = {
  id: authPath,
  filename: authPath,
  loaded: true,
  exports: Object.assign(pass(), { adminAuth: pass(), requireAdminRole: pass, blockDuringImpersonation: pass() }),
};

const User = require("../models/User");
const people = [
  { email: "host@x.test", isHost: true, isVerified: true },
  { email: "renter@x.test", isVerified: true },
  { email: "new@x.test" },
  { email: "banned@x.test", isHost: true, isBanned: true, isVerified: true },
  { email: "qa@x.test", isTestAccount: true, isVerified: true },
];
// Enough of Mongo's matching for the filters these routes build.
const matches = (user, filter) =>
  Object.entries(filter).every(([key, want]) => {
    if (key === "$or") return want.some((f) => matches(user, f));
    const have = key.split(".").reduce((v, k) => v?.[k], user);
    if (want && typeof want === "object" && "$ne" in want) return have !== want.$ne;
    if (want && typeof want === "object" && "$regex" in want) return new RegExp(want.$regex, want.$options).test(have || "");
    return have === want;
  });
User.countDocuments = async (filter) => people.filter((u) => matches(u, filter)).length;
User.find = (filter) => {
  const found = people.filter((u) => matches(u, filter));
  const query = { select: () => query, sort: () => query, skip: () => query, limit: async () => found };
  return query;
};

const app = express();
app.use("/admin", require("../routes/admin"));
const server = app.listen(0);
const ready = new Promise((resolve) => server.on("listening", resolve));
test.after(() => server.close());
const get = async (url) => {
  await ready;
  const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`);
  return { status: res.status, body: await res.json() };
};

test("tab counts cover every user, not one page; 'all' without test accounts matches the Overview total", async () => {
  const { status, body } = await get("/admin/users/counts");
  assert.equal(status, 200);
  assert.deepEqual(body.excludingTest, { all: 4, customers: 2, hosts: 2, unverified: 1, suspended: 1, pending: 0 });
  assert.equal(body.includingTest.all, 5);
  assert.equal(body.testAccounts, 1);
});

test("the Hosts tab is filtered on the server", async () => {
  const { body } = await get("/admin/users?tab=hosts&excludeTest=true");
  assert.deepEqual(body.users.map((u) => u.email).sort(), ["banned@x.test", "host@x.test"]);
  assert.equal(body.total, 2);
});

test("search treats regex characters literally", async () => {
  const { status, body } = await get("/admin/users?q=" + encodeURIComponent("x.test("));
  assert.equal(status, 200);
  assert.equal(body.total, 0);
});
