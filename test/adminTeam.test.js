// Admin access: who can be made an admin, with which role, and what is recorded.
// All accounts are synthetic and the User model is replaced by an in-memory fake.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const authId = require.resolve('../middleware/auth');
const pass = (req, _res, next) => { req.user = { id: req.header('x-test-user') }; next(); };
require.cache[authId] = { id: authId, filename: authId, loaded: true, exports: Object.assign(pass, { adminAuth: pass, requireAdminRole: () => pass }) };
const User = require('../models/User');

const ME = 'a'.repeat(24);          // the full admin making the change
const OTHER_ADMIN = 'b'.repeat(24); // a second full admin
const HOST = 'c'.repeat(24);        // an ordinary host
let db;
const reset = () => {
  db = new Map([
    [ME, { _id: ME, email: 'me@synthetic.test', isAdmin: true, adminRole: 'full_admin' }],
    [OTHER_ADMIN, { _id: OTHER_ADMIN, email: 'other@synthetic.test', isAdmin: true, adminRole: 'full_admin' }],
    // A host: before this fix every account also carried adminRole "full_admin".
    [HOST, { _id: HOST, email: 'host@synthetic.test', isAdmin: false, adminRole: 'full_admin' }],
  ]);
};
reset();

const isFullAdmin = (doc) => doc.isAdmin && (!doc.adminRole || doc.adminRole === 'full_admin');
const chain = (value) => ({ select: () => chain(value), populate: () => chain(value), sort: () => chain(value), then: (ok, fail) => Promise.resolve(value).then(ok, fail) });
User.findOne = (filter) => {
  if (filter.email) {
    const doc = [...db.values()].find((d) => d.email === filter.email);
    return chain(doc ? { ...doc, save: async function save() { Object.assign(db.get(doc._id), this, { save: undefined }); return this; } } : null);
  }
  const doc = db.get(filter._id);
  return chain(doc && isFullAdmin(doc) ? doc : null);
};
User.countDocuments = async () => [...db.values()].filter(isFullAdmin).length;
User.findByIdAndUpdate = (id, update) => {
  const doc = db.get(id);
  if (!doc) return chain(null);
  Object.assign(doc, update.$set || {});
  for (const key of Object.keys(update.$unset || {})) delete doc[key];
  return chain({ ...doc });
};
User.findOneAndUpdate = (filter, update) => {
  const doc = db.get(filter._id);
  if (!doc || !doc.isAdmin) return chain(null);
  Object.assign(doc, update);
  return chain({ ...doc });
};

const app = express();
app.use(express.json());
app.use('/admin', require('../routes/admin'));
const server = app.listen(0, '127.0.0.1');
const ready = new Promise((resolve) => server.on('listening', resolve));
test.after(() => server.close());
test.beforeEach(reset);
const call = async (method, path, body, user = ME) => {
  await ready;
  const res = await fetch(`http://127.0.0.1:${server.address().port}/admin${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-test-user': user },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};

test('making someone an admin needs an explicit role: a bare request no longer creates a Full Admin', async () => {
  const bare = await call('PATCH', `/users/${HOST}/admin`, { isAdmin: true });
  assert.equal(bare.status, 400);
  assert.equal(db.get(HOST).isAdmin, false);
  const empty = await call('PATCH', `/users/${HOST}/admin`, {});
  assert.equal(empty.status, 400);
  const badRole = await call('PATCH', `/users/${HOST}/admin`, { isAdmin: true, adminRole: 'owner' });
  assert.equal(badRole.status, 400);
  assert.equal(db.get(HOST).isAdmin, false);
});

test('granting records the role, who granted it and when', async () => {
  const { status } = await call('PATCH', `/users/${HOST}/admin`, { isAdmin: true, adminRole: 'content' });
  assert.equal(status, 200);
  const host = db.get(HOST);
  assert.equal(host.isAdmin, true);
  assert.equal(host.adminRole, 'content');
  assert.equal(host.adminGrantedBy, ME);
  assert.ok(host.adminGrantedAt instanceof Date);
});

test('nobody can change their own admin access or role', async () => {
  assert.equal((await call('PATCH', `/users/${ME}/admin`, { isAdmin: false })).status, 400);
  assert.equal((await call('PATCH', `/team/${ME}/role`, { adminRole: 'content' })).status, 400);
  assert.equal(db.get(ME).adminRole, 'full_admin');
});

test('the last Full Admin cannot be removed or demoted', async () => {
  db.delete(OTHER_ADMIN);
  // ME is now the only Full Admin; act as a different caller to try it.
  const removed = await call('PATCH', `/users/${ME}/admin`, { isAdmin: false }, 'z'.repeat(24));
  assert.equal(removed.status, 400);
  assert.match(removed.body.error, /last Full Admin/);
  const demoted = await call('PATCH', `/team/${ME}/role`, { adminRole: 'support' }, 'z'.repeat(24));
  assert.equal(demoted.status, 400);
  assert.equal(db.get(ME).isAdmin, true);
});

test('with another Full Admin in place an admin can be removed, and their role is cleared', async () => {
  const { status } = await call('PATCH', `/users/${OTHER_ADMIN}/admin`, { isAdmin: false });
  assert.equal(status, 200);
  assert.equal(db.get(OTHER_ADMIN).isAdmin, false);
  assert.equal('adminRole' in db.get(OTHER_ADMIN), false);
});

test('team invite requires a role and records who added them', async () => {
  const noRole = await call('POST', '/team/invite', { email: 'host@synthetic.test' });
  assert.equal(noRole.status, 400);
  assert.equal(db.get(HOST).isAdmin, false);

  const ok = await call('POST', '/team/invite', { email: 'host@synthetic.test', adminRole: 'support', adminTitle: 'Support' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.adminRole, 'support');
  const host = db.get(HOST);
  assert.equal(host.isAdmin, true);
  assert.equal(host.adminRole, 'support');
  assert.equal(host.adminGrantedBy, ME);
});
