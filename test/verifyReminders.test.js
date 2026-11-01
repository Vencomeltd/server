// Run with: node --test test/verifyReminders.test.js
// "Verify your account" reminders: who's picked, what's recorded, and that the
// email carries a working unsubscribe link. DB and email replaced by stubs.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = "test-secret";
const sent = [];
const sendEmailPath = require.resolve(path.join(__dirname, "../utils/sendEmail"));
require.cache[sendEmailPath] = { id: sendEmailPath, filename: sendEmailPath, loaded: true, exports: async (msg) => sent.push(msg) };

const User = require("../models/User");
let lastQuery;
const updates = [];
User.find = (query) => {
  lastQuery = query;
  return { select: async () => [{ _id: "64b000000000000000000009", email: "new@example.com", firstName: "Sam" }] };
};
User.updateOne = async (filter, update) => updates.push({ filter, update });

const { sendDueVerifyReminders } = require("../utils/verifyReminders");

test("picks unverified, recent, subscribed, real accounts not reminded today; records the send", async () => {
  const now = new Date("2026-11-02T10:00:00Z"); // a Monday
  const count = await sendDueVerifyReminders(now);
  assert.equal(count, 1);

  assert.deepEqual(lastQuery.isVerified, { $ne: true });
  assert.equal(lastQuery.createdAt.$gte.getTime(), now.getTime() - 14 * 24 * 3600 * 1000);
  assert.deepEqual(lastQuery["verifyReminders.optedOut"], { $ne: true });
  assert.deepEqual(lastQuery.isTestAccount, { $ne: true });
  assert.deepEqual(lastQuery.isBanned, { $ne: true });
  assert.equal(lastQuery["verifyReminders.lastSentAt"].$not.$gte.getTime(), now.getTime() - 12 * 3600 * 1000);

  assert.equal(sent[0].to, "new@example.com");
  assert.equal(sent[0].category, "reminder");
  assert.deepEqual(updates[0].update.$push, { "verifyReminders.sentAt": now });
});

test("the unsubscribe link carries a token that only unsubscribes this user", () => {
  const match = sent[0].html.match(/verify-reminders\/unsubscribe\?token=([^"]+)/);
  assert.ok(match, "unsubscribe link present");
  const decoded = jwt.verify(match[1], "test-secret");
  assert.equal(decoded.id, "64b000000000000000000009");
  assert.equal(decoded.purpose, "verify-reminders-unsubscribe");
});
