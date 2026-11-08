const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const authId = require.resolve('../middleware/auth');
const pass = (_req, _res, next) => next();
require.cache[authId] = { id: authId, filename: authId, loaded: true, exports: pass };
const { client } = require('../utils/redisClient');
const User = require('../models/User');
const Property = require('../models/Property');
const { hostPublicName, publicHost } = require('../utils/hostName');

// Wholly synthetic hosts and listings, no client listing IDs or database.
const flags = { isTestAccount: true, accountFlag: 'test' };
const verifiedHost = { _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', firstName: 'Sam', displayName: 'Sam S', businessVerification: { companyName: 'Synthetic Studios Ltd', status: 'verified' }, ...flags };
const unverifiedHost = (status) => ({ _id: 'bbbbbbbbbbbbbbbbbbbbbbbb', firstName: 'Alex', businessVerification: { companyName: 'Unchecked Co', status }, ...flags });
const leaks = (body) => {
  const text = JSON.stringify(body);
  return ['isTestAccount', 'accountFlag', 'Unchecked Co'].filter((word) => text.includes(word));
};

test('the verified business name wins over the profile and first name', () => {
  assert.equal(hostPublicName(verifiedHost), 'Synthetic Studios Ltd');
});

test('an unverified business name is never used or sent', () => {
  for (const status of ['under_review', 'rejected', 'not_submitted', undefined]) {
    const host = publicHost(unverifiedHost(status));
    assert.equal(host.publicName, 'Alex');
    assert.equal(host.businessVerification, undefined);
    assert.deepEqual(leaks(host), []);
  }
});

test('falls back to the profile name, then the first name, then "Host"', () => {
  assert.equal(hostPublicName({ displayName: 'Sam S', firstName: 'Sam' }), 'Sam S');
  assert.equal(hostPublicName({ firstName: 'Sam' }), 'Sam');
  assert.equal(hostPublicName({}), 'Host');
});

test('VenCome-sounding names show only for internal accounts', () => {
  const vencomeBusiness = { firstName: 'Jo', businessVerification: { companyName: 'VenCome Spaces', status: 'verified' } };
  assert.equal(hostPublicName(vencomeBusiness), 'Jo');
  assert.equal(hostPublicName({ ...vencomeBusiness, accountFlag: 'internal' }), 'VenCome Spaces');
  // The decision survives a second pass (cached public copy has no flag).
  const cachedInternal = publicHost({ ...vencomeBusiness, accountFlag: 'internal' });
  assert.equal(cachedInternal.accountFlag, undefined);
  assert.equal(publicHost(cachedInternal).publicName, 'VenCome Spaces');
});

test('publicHost keeps the verified name and drops the flags', () => {
  const host = publicHost(verifiedHost);
  assert.equal(host.publicName, 'Synthetic Studios Ltd');
  assert.deepEqual(host.businessVerification, { companyName: 'Synthetic Studios Ltd', status: 'verified' });
  assert.equal('isTestAccount' in host, false);
  assert.equal('accountFlag' in host, false);
});

// --- Public routes ---------------------------------------------------------
// A chainable query stub that applies populate transforms the way Mongoose
// does, so the routes' populate options are exercised.
const query = (value) => {
  const transforms = [];
  const q = {
    populate: (opt) => { if (opt?.path === 'host' && opt.transform) transforms.push(opt.transform); return q; },
    sort: () => q, skip: () => q, limit: () => q, select: () => q,
    then: (resolve, reject) => {
      const apply = (doc) => doc && transforms.reduce((d, t) => ({ ...d, host: t(d.host) }), doc);
      return Promise.resolve(Array.isArray(value) ? value.map(apply) : apply(value)).then(resolve, reject);
    },
  };
  return q;
};
const listing = (host) => ({ _id: 'synthetic-listing', title: 'Synthetic room', isActive: true, host: { ...host } });
let cache = {};
client.get = async (key) => cache[key] ?? null;
client.setEx = async () => {};

const app = express();
app.use('/hosts', require('../routes/hosts'));
Property.distinct = async () => []; // buildings: none here
app.use('/properties', require('../routes/properties'));
app.use('/search', require('../routes/search'));
const server = app.listen(0, '127.0.0.1');
const ready = new Promise((resolve) => server.on('listening', resolve));
test.after(() => server.close());
const get = async (route) => {
  await ready;
  const res = await fetch(`http://127.0.0.1:${server.address().port}${route}`);
  return { status: res.status, body: await res.json() };
};

test('host profile: verified business name, no flags', async () => {
  const doc = { ...verifiedHost, slug: 'synthetic-host', toObject() { const { toObject, ...rest } = this; return rest; } };
  User.findById = () => ({ select: async () => doc });
  Property.countDocuments = async () => 0;
  Property.find = () => ({ select: async () => [] });
  const { status, body } = await get(`/hosts/${verifiedHost._id}`);
  assert.equal(status, 200);
  assert.equal(body.publicName, 'Synthetic Studios Ltd');
  assert.deepEqual(leaks(body), []);
});

test('host profile: unverified business name is not sent', async () => {
  const doc = { ...unverifiedHost('under_review'), slug: 'synthetic-host', toObject() { const { toObject, ...rest } = this; return rest; } };
  User.findById = () => ({ select: async () => doc });
  const { body } = await get(`/hosts/${doc._id}`);
  assert.equal(body.publicName, 'Alex');
  assert.deepEqual(leaks(body), []);
});

test('property detail: no flags or unverified name, fresh or from a stale cache entry', async () => {
  cache = {};
  Property.findById = () => query(listing(unverifiedHost('rejected')));
  const fresh = await get('/properties/cccccccccccccccccccccccc');
  assert.equal(fresh.status, 200);
  assert.equal(fresh.body.property.host.publicName, 'Alex');
  assert.deepEqual(leaks(fresh.body), []);

  // Cached before this change: the host still carries the flags.
  cache = { 'property:cccccccccccccccccccccccc': JSON.stringify(listing(unverifiedHost('rejected'))) };
  const cached = await get('/properties/cccccccccccccccccccccccc');
  assert.equal(cached.body.cached, true);
  assert.equal(cached.body.property.host.publicName, 'Alex');
  assert.deepEqual(leaks(cached.body), []);
});

test('listing page: verified name wins and a stale cache entry is cleaned', async () => {
  cache = {};
  Property.find = () => query([listing(verifiedHost), listing(unverifiedHost('under_review'))]);
  Property.countDocuments = async () => 2;
  const fresh = await get('/properties?page=1&limit=8');
  assert.deepEqual(fresh.body.properties.map((p) => p.host.publicName), ['Synthetic Studios Ltd', 'Alex']);
  assert.deepEqual(leaks(fresh.body), []);

  cache = { 'properties:page:1:limit:8': JSON.stringify({ properties: [listing(unverifiedHost('under_review'))] }) };
  const cached = await get('/properties?page=1&limit=8');
  assert.equal(cached.body.properties[0].host.publicName, 'Alex');
  assert.deepEqual(leaks(cached.body), []);
});

test('search: no flags or unverified name', async () => {
  Property.find = () => query([listing(verifiedHost), listing(unverifiedHost('not_submitted'))]);
  Property.countDocuments = async () => 2;
  const { status, body } = await get('/search');
  assert.equal(status, 200);
  assert.deepEqual(body.properties.map((p) => p.host.publicName), ['Synthetic Studios Ltd', 'Alex']);
  assert.deepEqual(leaks(body), []);
});
