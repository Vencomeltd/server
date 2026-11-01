// Run with: node --test test/dataBackup.test.js
// Data export and restore: secrets stripped, CSV safety, an export that reads
// back with its types intact, and a restore plan that only adds and updates.
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const { ObjectId } = mongoose.Types;
const backup = require("../utils/dataBackup");

// A tiny in-memory stand-in for mongoose.connection.db.
function fakeDb(collections) {
  const calls = [];
  const db = {
    listCollections: () => ({ toArray: async () => Object.keys(collections).map((name) => ({ name })) }),
    collection: (name) => ({
      find: (filter = {}) => {
        const ids = filter._id?.$in?.map(String);
        const docs = (collections[name] || []).filter((d) => !ids || ids.includes(String(d._id)));
        return { toArray: async () => docs.map((d) => ({ ...d })) };
      },
      insertMany: async (docs) => calls.push({ name, insertMany: docs }),
      bulkWrite: async (ops) => calls.push({ name, bulkWrite: ops }),
    }),
  };
  return { db, calls };
}
const useDb = (db) => Object.defineProperty(mongoose.connection, "db", { value: db, configurable: true, writable: true });

const userId = new ObjectId();
const created = new Date("2026-10-01T09:00:00Z");
const liveData = () => ({
  users: [
    {
      _id: userId,
      email: "sam@example.com",
      firstName: "Sam",
      password: "$2b$12$hash",
      otp: "123456",
      googleCalendar: { connected: true, refreshToken: "rt" },
      createdAt: created,
    },
  ],
  bookings: [{ _id: new ObjectId(), guest: userId, totalPrice: 120, status: "confirmed", hostActionToken: "abc", createdAt: created }],
});

test("strip removes passwords, tokens and codes at any depth, keeping ids and dates", () => {
  const [user] = liveData().users.map(backup.strip);
  assert.equal(user.password, undefined);
  assert.equal(user.otp, undefined);
  assert.equal(user.googleCalendar.refreshToken, undefined);
  assert.equal(user.googleCalendar.connected, true);
  assert.ok(user._id instanceof ObjectId);
  assert.ok(user.createdAt instanceof Date);
});

test("CSV quotes commas and quotes, and stops formulas", () => {
  const csv = backup.toCsv([{ a: 'Say "hi", ok', b: "=HYPERLINK(1)", c: null }], ["a", "b", "c"]);
  assert.equal(csv, 'a,b,c\r\n"Say ""hi"", ok",\'=HYPERLINK(1),');
});

test("an export reads back with its types, minus secrets, plus CSVs", async () => {
  useDb(fakeDb(liveData()).db);
  const zip = await backup.buildExport();
  const { manifest, collections } = backup.readExport(zip);
  assert.equal(manifest.app, "VenCome");
  assert.deepEqual(manifest.collections, { bookings: 1, users: 1 });
  const [user] = collections.users;
  assert.ok(user._id.equals(userId));
  assert.equal(user.createdAt.getTime(), created.getTime());
  assert.equal(user.password, undefined);
  assert.equal(collections.bookings[0].hostActionToken, undefined);

  const AdmZip = require("adm-zip");
  const users = new AdmZip(zip).getEntry("csv/users.csv").getData().toString("utf8");
  assert.match(users, /sam@example.com,Sam/);
  assert.doesNotMatch(users, /\$2b\$/);
});

test("restore plan: new docs added, changed fields set, never deletes or touches stripped fields", async () => {
  const live = liveData();
  const { db, calls } = fakeDb(live);
  useDb(db);
  const exported = {
    users: [
      // changed name and calendar flag; no password or refresh token in the export
      { ...backup.strip(live.users[0]), firstName: "Samuel", googleCalendar: { connected: false } },
      { _id: new ObjectId(), email: "new@example.com", createdAt: created }, // not in the database
    ],
    bookings: live.bookings.map(backup.strip), // unchanged apart from the stripped token
    widgets: [{ _id: new ObjectId() }], // not a collection here
  };
  const { summary, ops } = await backup.planRestore(exported);
  assert.deepEqual({ add: summary.users.add, change: summary.users.change, same: summary.users.same }, { add: 1, change: 1, same: 0 });
  assert.deepEqual(summary.users.changedFields, ["firstName", "googleCalendar.connected"]);
  assert.equal(summary.bookings.same, 1);
  assert.equal(summary.widgets.skipped, 1);

  await backup.applyRestore(ops);
  const update = calls.find((c) => c.name === "users" && c.bulkWrite).bulkWrite[0].updateOne;
  // Only the changed paths: the password and calendar refresh token are left as they are.
  assert.deepEqual(update.update, { $set: { firstName: "Samuel", "googleCalendar.connected": false } });
  assert.equal(calls.find((c) => c.name === "users" && c.insertMany).insertMany[0].email, "new@example.com");
  assert.ok(!calls.some((c) => c.name === "bookings"));
});

test("a zip that isn't a VenCome export is refused", () => {
  const AdmZip = require("adm-zip");
  const zip = new AdmZip();
  zip.addFile("hello.txt", Buffer.from("hi"));
  assert.throws(() => backup.readExport(zip.toBuffer()), /isn't a VenCome export/);
  assert.throws(() => backup.readExport(Buffer.from("not a zip")), /isn't a zip export/);
});
