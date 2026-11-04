// Run with: node --test test/adminUsers.test.js
// GET /admin/users/counts and the Users tab filter, over HTTP with the User
// model replaced by an in-memory list (no MongoDB needed).
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const express = require("express");

const pass = () => (req, _res, next) => { req.user = { id: "synthetic-admin" }; next(); };
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
  { email: "internal@x.test", isHost: true, isTestAccount: true, accountFlag: "internal" },
];
// Enough of Mongo's matching for the filters these routes build.
const matches = (user, filter) =>
  Object.entries(filter).every(([key, want]) => {
    if (key === "$and") return want.every((f) => matches(user, f));
    if (key === "$or") return want.some((f) => matches(user, f));
    const have = key.split(".").reduce((v, k) => v?.[k], user);
    if (want && typeof want === "object" && "$ne" in want) return have !== want.$ne;
    if (want && typeof want === "object" && "$regex" in want) return new RegExp(want.$regex, want.$options).test(have || "");
    return have === want;
  });
User.countDocuments = async (filter) => people.filter((u) => matches(u, filter)).length;
User.find = (filter) => {
  const found = people.filter((u) => matches(u, filter));
  let offset = 0;
  const query = { select: () => query, sort: () => query, skip: (value) => { offset = value; return query; }, limit: async (value) => found.slice(offset, offset + value) };
  return query;
};

const app = express();
app.use(express.json());
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
  assert.equal(body.includingTest.all, 6);
  assert.equal(body.testAccounts, 2);
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


test("every tab list total agrees with its count with and without flagged accounts", async () => {
  const { body: counts } = await get("/admin/users/counts");
  for (const exclude of [true, false]) {
    for (const tab of Object.keys(counts.excludingTest)) {
      const { body } = await get(`/admin/users?tab=${tab}&excludeTest=${exclude}`);
      assert.equal(body.total, counts[exclude ? "excludingTest" : "includingTest"][tab]);
      if (exclude) assert.ok(body.users.every((user) => !user.isTestAccount));
    }
  }
});

test("test/internal flags and unflagging change totals without removing the account", async (t) => {
  const user = people.find((person) => person.email === "new@x.test");
  t.mock.method(User, "findByIdAndUpdate", (_id, update) => {
    Object.assign(user, update.$set);
    for (const key of Object.keys(update.$unset || {})) delete user[key];
    return { select: async () => user };
  });
  try {
    for (const flag of ["test", "internal", null]) {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/admin/users/synthetic-user/flag`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ flag }),
      });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).accountFlag, flag);
      const { body } = await get("/admin/users/counts");
      assert.equal(body.excludingTest.all, flag ? 3 : 4);
      assert.equal(body.includingTest.all, 6);
      assert.equal(people.length, 6);
    }
    const res = await fetch(`http://127.0.0.1:${server.address().port}/admin/users/synthetic-user/flag`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ flag: "admin" }),
    });
    assert.equal(res.status, 400);
    assert.equal(user.isTestAccount, false);
  } finally {
    delete user.isTestAccount;
    delete user.accountFlag;
  }
});


test("status filtering covers all accounts before pagination", async () => {
  const { body } = await get("/admin/users?status=unverified&excludeTest=true");
  assert.deepEqual(body.users.map((user) => user.email), ["new@x.test"]);
  assert.equal(body.total, 1);
});

test("role dropdown and tab filters intersect", async () => {
  const { body } = await get("/admin/users?tab=hosts&role=customer&excludeTest=true");
  assert.equal(body.total, 0);
});


test("a matching account beyond the first page is found and counted", async () => {
  const extra = Array.from({ length: 25 }, (_, i) => ({ email: `synthetic-${i}@x.test`, isVerified: true }));
  extra.push({ email: "synthetic-admin@x.test", isAdmin: true, isVerified: true });
  people.push(...extra);
  try {
    const { body } = await get("/admin/users?role=admin&status=active&excludeTest=true&limit=20");
    assert.equal(body.total, 1);
    assert.equal(body.pages, 1);
    assert.deepEqual(body.users.map((user) => user.email), ["synthetic-admin@x.test"]);
  } finally { people.splice(people.length - extra.length); }
});

test("status filters follow the displayed status priority", async () => {
  people.push({ email: "pending@x.test", isHost: true, isVerified: true, businessVerification: { status: "under_review" } });
  try {
    for (const [status, expected] of [["active", ["host@x.test", "renter@x.test"]], ["suspended", ["banned@x.test"]], ["pending verification", ["pending@x.test"]]]) {
      const { body } = await get(`/admin/users?status=${encodeURIComponent(status)}&excludeTest=true`);
      assert.deepEqual(body.users.map((user) => user.email).sort(), expected.sort());
    }
  } finally { people.pop(); }
});
