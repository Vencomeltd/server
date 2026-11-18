// Broadcast audiences by what a host has listed. Synthetic ids, mocked models,
// no database and no email (sendEmail is stubbed out).
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const authId = require.resolve('../middleware/auth');
const pass = (_req, _res, next) => next();
require.cache[authId] = { id: authId, filename: authId, loaded: true, exports: Object.assign(pass, { adminAuth: pass, requireAdminRole: () => pass }) };
const sendEmailId = require.resolve('../utils/sendEmail');
const sent = [];
require.cache[sendEmailId] = { id: sendEmailId, filename: sendEmailId, loaded: true, exports: async (mail) => { sent.push(mail.to); } };
const User = require('../models/User');
const Property = require('../models/Property');
const Draft = require('../models/Draft');

// Four hosts: one with a draft, one with a live listing, one with both, one with neither.
const users = [
  { _id: 'host-draft', email: 'draft@synthetic.test', isHost: true },
  { _id: 'host-live', email: 'live@synthetic.test', isHost: true },
  { _id: 'host-both', email: 'both@synthetic.test', isHost: true },
  { _id: 'host-none', email: 'none@synthetic.test', isHost: true },
  { _id: 'customer', email: 'customer@synthetic.test', isHost: false },
  { _id: 'host-test', email: 'test@synthetic.test', isHost: true, isTestAccount: true },
];
const draftHosts = ['host-draft', 'host-both', 'host-test'];
const liveHosts = ['host-live', 'host-both'];
const anyListingHosts = ['host-live', 'host-both', 'host-draft-only-closed'];
Draft.distinct = async () => draftHosts;
Property.distinct = async (_field, filter) => (filter.isActive ? liveHosts : anyListingHosts);

const matches = (doc, filter) => Object.entries(filter).every(([key, want]) => {
  if (key === '_id' && want && typeof want === 'object') {
    if ('$in' in want) return want.$in.includes(doc._id);
    if ('$nin' in want) return !want.$nin.includes(doc._id);
  }
  const have = doc[key];
  if (want && typeof want === 'object') {
    if ('$ne' in want) return have !== want.$ne;
  }
  return have === want;
});
User.countDocuments = async (filter) => users.filter((u) => matches(u, filter)).length;
User.find = (filter) => ({ select: () => ({ lean: async () => users.filter((u) => matches(u, filter)) }) });

const router = require('../routes/admin');
const app = express();
app.use(express.json());
app.use('/admin', router);
const server = app.listen(0, '127.0.0.1');
const ready = new Promise((resolve) => server.on('listening', resolve));
test.after(() => server.close());

test('audience counts: drafts, live listings and no listings, without test accounts', async () => {
  await ready;
  const res = await fetch(`http://127.0.0.1:${server.address().port}/admin/broadcast/audiences`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { hostsWithDrafts: 2, hostsWithListings: 2, hostsNoListings: 1 });
});

test('a broadcast to hosts with drafts reaches exactly those hosts', async () => {
  sent.length = 0;
  const broadcast = { target: 'hostsWithDrafts', subject: 'Finish your listing', message: 'Hello', save: async () => {} };
  const count = await router.sendBroadcastNow(broadcast);
  assert.equal(count, 2);
  assert.deepEqual(sent.sort(), ['both@synthetic.test', 'draft@synthetic.test']);
  assert.equal(broadcast.status, 'sent');
});

test('hosts with no listings excludes anyone who has a draft or a listing', async () => {
  sent.length = 0;
  const count = await router.sendBroadcastNow({ target: 'hostsNoListings', subject: 'Hi', message: 'Hello', save: async () => {} });
  assert.equal(count, 1);
  assert.deepEqual(sent, ['none@synthetic.test']);
});
