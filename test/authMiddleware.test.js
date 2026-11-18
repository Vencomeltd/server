// The real auth and adminAuth middleware (other tests replace them with stubs).
// Synthetic secret and ids; the User lookup is faked, no database.
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.JWT_SECRET = 'synthetic-test-secret';
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const auth = require('../middleware/auth');
const { adminAuth } = auth;

let lookup; // what User.findById(...).select(...) does in the current test
User.findById = () => ({ select: async () => lookup() });

const run = async (middleware, token) => {
  const req = { header: (name) => (name === 'Authorization' && token ? `Bearer ${token}` : undefined) };
  const out = { status: null, body: null, nextCalled: false };
  const res = { status(code) { out.status = code; return this; }, json(body) { out.body = body; return this; } };
  await middleware(req, res, () => { out.nextCalled = true; });
  return { ...out, user: req.user };
};
const good = jwt.sign({ id: 'synthetic-user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
const expired = jwt.sign({ id: 'synthetic-user' }, process.env.JWT_SECRET, { expiresIn: -10 });

for (const [name, middleware] of [['auth', auth], ['adminAuth', adminAuth]]) {
  test(`${name}: no token, a garbage token and an expired token are 401`, async () => {
    lookup = () => ({ _id: 'synthetic-user', isAdmin: true });
    assert.equal((await run(middleware, undefined)).status, 401);
    assert.equal((await run(middleware, 'not-a-token')).status, 401);
    assert.equal((await run(middleware, expired)).status, 401);
  });

  test(`${name}: a database error is a 503 "try again", never a 401 (it used to sign people out)`, async () => {
    lookup = () => { throw new Error('synthetic database timeout'); };
    const result = await run(middleware, good);
    assert.equal(result.status, 503);
    assert.equal(result.nextCalled, false);
  });
}

test('auth: a valid token for an existing user passes; for a deleted user it is 401', async () => {
  lookup = () => ({ _id: 'synthetic-user' });
  assert.equal((await run(auth, good)).nextCalled, true);
  lookup = () => null;
  assert.equal((await run(auth, good)).status, 401);
});

test('adminAuth: admins pass with their role, non-admins and unknown users are 403', async () => {
  lookup = () => ({ _id: 'synthetic-user', isAdmin: true, adminRole: 'support' });
  const ok = await run(adminAuth, good);
  assert.equal(ok.nextCalled, true);
  assert.equal(ok.user.adminRole, 'support');
  lookup = () => ({ _id: 'synthetic-user', isAdmin: true });
  assert.equal((await run(adminAuth, good)).user.adminRole, 'full_admin', 'older admins with no stored role stay Full Admin');
  lookup = () => ({ _id: 'synthetic-user', isAdmin: false });
  assert.equal((await run(adminAuth, good)).status, 403);
  lookup = () => null;
  assert.equal((await run(adminAuth, good)).status, 403);
});
