const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const authId = require.resolve('../middleware/auth');
// Stand-in for the real auth: the caller id comes from a test header.
const fakeAuth = (req, _res, next) => { req.user = { id: req.header('x-test-user') }; next(); };
require.cache[authId] = { id: authId, filename: authId, loaded: true, exports: Object.assign(fakeAuth, { adminAuth: fakeAuth, requireAdminRole: () => fakeAuth }) };
const User = require('../models/User');
const Draft = require('../models/Draft');

// Wholly synthetic accounts (valid ObjectId shapes, no database).
const ADMIN = 'a'.repeat(24);
const FINANCE_ADMIN = 'b'.repeat(24);
const HOST = 'c'.repeat(24);
const OTHER_HOST = 'd'.repeat(24);
const MISSING = 'e'.repeat(24);
const users = {
  [ADMIN]: { _id: ADMIN, isAdmin: true, adminRole: 'support' },
  [FINANCE_ADMIN]: { _id: FINANCE_ADMIN, isAdmin: true, adminRole: 'finance' },
  [HOST]: { _id: HOST, isAdmin: false },
  [OTHER_HOST]: { _id: OTHER_HOST, isAdmin: false },
};
User.findById = (id) => ({ select: async () => users[id] || null });

const drafts = [
  { _id: 'draft-host', host: HOST, title: 'Host draft', step: 2, formData: {} },
  { _id: 'draft-other', host: OTHER_HOST, title: 'Other host draft', step: 2, formData: {} },
];
Draft.find = (filter) => ({ select: () => ({ sort: async () => drafts.filter((d) => d.host === filter.host) }) });
Draft.findOne = async (filter) => drafts.find((d) => d._id === filter._id && d.host === filter.host) || null;
let created = null;
Draft.create = async (doc) => { created = { _id: 'new-draft', ...doc }; return created; };

const app = express();
app.use(express.json());
app.use('/drafts', require('../routes/drafts'));
const server = app.listen(0, '127.0.0.1');
const ready = new Promise((resolve) => server.on('listening', resolve));
test.after(() => server.close());
const call = async (method, path, { user, actAs, body } = {}) => {
  await ready;
  const headers = { 'Content-Type': 'application/json', 'x-test-user': user };
  if (actAs) headers['x-act-as-host'] = actAs;
  const res = await fetch(`http://127.0.0.1:${server.address().port}/drafts${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};

test('without the header a host only sees their own drafts', async () => {
  const { status, body } = await call('GET', '', { user: HOST });
  assert.equal(status, 200);
  assert.deepEqual(body.drafts.map((d) => d._id), ['draft-host']);
});

test('a host cannot use the header to reach another host', async () => {
  const { status } = await call('GET', '', { user: HOST, actAs: OTHER_HOST });
  assert.equal(status, 403);
  const open = await call('GET', '/draft-other', { user: HOST, actAs: OTHER_HOST });
  assert.equal(open.status, 403);
});

test('an admin with a role outside drafts is refused', async () => {
  const { status } = await call('GET', '', { user: FINANCE_ADMIN, actAs: HOST });
  assert.equal(status, 403);
});

test('bad or unknown host ids are refused', async () => {
  assert.equal((await call('GET', '', { user: ADMIN, actAs: 'not-an-id' })).status, 400);
  assert.equal((await call('GET', '', { user: ADMIN, actAs: MISSING })).status, 404);
});

test('an admin acting for a host sees and opens that host\'s drafts only', async () => {
  const list = await call('GET', '', { user: ADMIN, actAs: HOST });
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.drafts.map((d) => d._id), ['draft-host']);
  assert.equal((await call('GET', '/draft-host', { user: ADMIN, actAs: HOST })).status, 200);
  assert.equal((await call('GET', '/draft-other', { user: ADMIN, actAs: HOST })).status, 404);
});

test('a draft an admin starts for a host belongs to the host and records the admin as creator', async () => {
  const { status } = await call('POST', '', { user: ADMIN, actAs: HOST, body: { title: 'Built by admin', step: 3, formData: { title: 'Built by admin' } } });
  assert.equal(status, 201);
  assert.equal(created.host, HOST);
  assert.equal(created.createdBy, ADMIN);
});

test('a host\'s own draft records the host as creator', async () => {
  await call('POST', '', { user: HOST, body: { title: 'Mine' } });
  assert.equal(created.host, HOST);
  assert.equal(created.createdBy, HOST);
});
