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

for (const storageFailure of [false, true]) {
  test(`weekly backup retention ${storageFailure ? "keeps metadata when storage deletion fails" : "removes an expired backup after deleting its object"}`, async (t) => {
    const Document = require("../models/Document");
    const storage = require("../utils/documentStorage");
    useDb(fakeDb(liveData()).db);
    const old = { _id: new ObjectId(), key: "synthetic-only/old-backup.zip" };
    const created = [];
    const deleted = [];
    t.mock.method(storage, "putFile", async (_key, buffer, type) => {
      assert.equal(type, "application/zip");
      assert.equal(backup.readExport(buffer).manifest.app, "VenCome");
    });
    t.mock.method(Document, "create", async (doc) => { created.push(doc); });
    t.mock.method(Document, "find", (filter) => {
      assert.deepEqual(filter, { folder: "Backups", uploadedBy: { $exists: false } });
      return { sort: () => ({ skip: async (keep) => { assert.equal(keep, 8); return [old]; } }) };
    });
    t.mock.method(storage, "deleteFile", async (key) => {
      assert.equal(key, old.key);
      if (storageFailure) throw new Error("Synthetic storage unavailable");
    });
    t.mock.method(Document, "deleteOne", async ({ _id }) => { deleted.push(_id); });

    if (storageFailure) await assert.rejects(backup.saveWeeklyBackup(), /Synthetic storage unavailable/);
    else await backup.saveWeeklyBackup();
    assert.equal(created.length, 1);
    assert.equal(created[0].folder, "Backups");
    assert.equal(deleted.length, storageFailure ? 0 : 1);
  });
}

test("email bodies (one-time codes, action links) and iCal import URLs stay out of the export; restore keeps the live ones", async () => {
  const AdmZip = require("adm-zip");
  const code = "482913";
  const log = {
    _id: new ObjectId(),
    to: "synthetic@example.com",
    subject: "Admin Login Verification Code",
    text: `Your code is ${code}`,
    html: `<p style="font-size:28px">${code}</p><a href="https://example.com/act?k=zz9">Approve</a>`,
    status: "sent",
    category: "transactional",
    sentAt: created,
  };
  const property = { _id: new ObjectId(), title: "Synthetic studio", icalUrl: "https://example.com/ical/feed.ics?s=privatefeedkey", createdAt: created };
  const live = { emaillogs: [log], properties: [property] };
  useDb(fakeDb(live).db);
  const zip = await backup.buildExport();
  for (const entry of new AdmZip(zip).getEntries()) {
    const body = entry.getData().toString("utf8");
    assert.doesNotMatch(body, new RegExp(code), entry.entryName);
    assert.doesNotMatch(body, /zz9|privatefeedkey/, entry.entryName);
  }
  const { collections } = backup.readExport(zip);
  const [exported] = collections.emaillogs;
  assert.equal(exported.subject, "Admin Login Verification Code");
  assert.equal(exported.to, "synthetic@example.com");
  assert.equal(exported.status, "sent");
  assert.equal(exported.sentAt.getTime(), created.getTime());
  assert.equal(collections.properties[0].title, "Synthetic studio");

  const { summary } = await backup.planRestore(collections);
  assert.equal(summary.emaillogs.same, 1); // a missing body never wipes the live one
  assert.equal(summary.properties.same, 1);
});

test("card and bank account numbers stay out of the export at any depth", () => {
  const user = backup.strip({
    email: "synthetic@example.test",
    paymentMethods: [{ brand: "visa", last4: "4242", cardNumber: "4242424242424242" }],
    payoutMethods: [{ bankAccount: { accountName: "Synthetic", accountNumber: "12345678", routingNumber: "000000" } }],
  });
  assert.equal(user.paymentMethods[0].cardNumber, undefined);
  assert.equal(user.paymentMethods[0].last4, "4242");
  assert.equal(user.payoutMethods[0].bankAccount.accountNumber, undefined);
  assert.equal(user.payoutMethods[0].bankAccount.routingNumber, undefined);
  assert.equal(user.payoutMethods[0].bankAccount.accountName, "Synthetic");
});

test("iCal import URLs stay out of the export inside saved drafts too", () => {
  const draft = backup.strip({ formData: { title: "Synthetic draft", icalUrl: "https://example.test/feed.ics?k=privatekey" } });
  assert.equal(draft.formData.icalUrl, undefined);
  assert.equal(draft.formData.title, "Synthetic draft");
});
