const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const authId = require.resolve('../middleware/auth');
const pass = (_req, _res, next) => next();
require.cache[authId] = { id: authId, filename: authId, loaded: true, exports: Object.assign(pass, { adminAuth: pass, requireAdminRole: () => pass }) };
const User = require('../models/User');
const Property = require('../models/Property');
const Draft = require('../models/Draft');
// Wholly synthetic records, no client listing IDs or database connection.
const listings = [
  { _id: 'synthetic-active', host: 'synthetic-host', isActive: true },
  { _id: 'synthetic-inactive', host: 'synthetic-host', isActive: false, moderationStatus: 'approved' },
  { _id: 'synthetic-pending', host: 'synthetic-host', isActive: false, moderationStatus: 'pending_review' },
  { _id: 'synthetic-test', host: 'synthetic-test-host', isActive: true },
];
const drafts = [{ _id: 'synthetic-draft', host: 'synthetic-host', createdBy: { email: 'creator@example.test' }, formData: { title: 'Synthetic draft', images: ['synthetic-photo'], pricing: { monthly: 100 } } }];
const matches = (doc, filter) => Object.entries(filter).every(([key, want]) => {
  if (key === "$and") return want.every(part => matches(doc, part));
  if (key === "$or") return want.some(part => matches(doc, part));
  const have = key.split(".").reduce((value, field) => value?.[field], doc);
  if (want && typeof want === "object") {
    if ("$nin" in want) return !want.$nin.includes(have);
    if ("$in" in want) return want.$in.includes(have);
    if ("$ne" in want) return have !== want.$ne;
    if ("$gt" in want) return have > want.$gt;
    if ("$exists" in want) return (have !== undefined) === want.$exists;
    if ("$regex" in want) return new RegExp(want.$regex, want.$options).test(have || "");
  }
  return want === null ? have == null : have === want;
});
const query = (values, single = false) => {
  let offset = 0, size = Infinity, excludeForm = false;
  const q = { populate: () => q, sort: () => q, select: (fields) => { excludeForm = fields === '-formData'; return q; }, skip: (n) => { offset = n; return q; }, limit: (n) => { size = n; return q; }, then: (resolve, reject) => Promise.resolve(single ? values : values.slice(offset, offset + size).map(({ formData, ...rest }) => excludeForm ? rest : { ...rest, formData })).then(resolve, reject) };
  return q;
};
User.find = (filter) => ({ distinct: async () => filter.isTestAccount ? ['synthetic-test-host'] : [] });
Property.distinct = async (_field, filter) => [...new Set(listings.filter(doc => matches(doc, filter)).map(doc => doc.location?.city))];
Property.countDocuments = async (filter) => listings.filter(doc => matches(doc, filter)).length;
Property.find = (filter) => query(listings.filter(doc => matches(doc, filter)));
Draft.countDocuments = async (filter) => drafts.filter(doc => matches(doc, filter)).length;
Draft.find = (filter) => query(drafts.filter(doc => matches(doc, filter)));
Draft.findById = (id) => query(drafts.find(doc => doc._id === id) || null, true);
const app = express();
app.use('/admin', require('../routes/admin'));
const server = app.listen(0, '127.0.0.1');
const ready = new Promise(resolve => server.on('listening', resolve));
test.after(() => server.close());
const get = async route => { await ready; const res = await fetch(`http://127.0.0.1:${server.address().port}/admin${route}`); return { status: res.status, body: await res.json() }; };
test('listing status counts and lists agree, excluding test hosts when requested', async () => {
  for (const excludeTest of [true, false]) {
    const { body: counts } = await get(`/properties/counts?excludeTest=${excludeTest}`);
    assert.deepEqual(counts, { all: excludeTest ? 3 : 4, active: excludeTest ? 1 : 2, inactive: 1, pending: 1, draft: 1 });
    for (const status of ['active', 'inactive', 'pending']) {
      const { body } = await get(`/properties?status=${status}&excludeTest=${excludeTest}`);
      assert.equal(body.total, counts[status]);
      if (excludeTest) assert.ok(body.properties.every(doc => doc.host !== 'synthetic-test-host'));
    }
  }
});
test('draft lists omit heavy form data, detail returns it and creator intact', async () => {
  const { body: list } = await get('/drafts?excludeTest=true');
  assert.equal(list.total, 1);
  assert.equal(list.drafts[0].formData, undefined);
  const { status, body } = await get('/drafts/synthetic-draft');
  assert.equal(status, 200);
  assert.deepEqual(body.draft.formData, drafts[0].formData);
  assert.equal(body.draft.createdBy.email, 'creator@example.test');
  assert.equal((await get('/drafts/synthetic-missing')).status, 404);
});


test('photo, VAT, location and literal search filters find matches beyond page one', async () => {
  const extra = Array.from({ length: 55 }, (_, i) => ({ _id: `synthetic-page-${i}`, title: `Synthetic row ${i}`, host: 'synthetic-host', images: ['synthetic-image'], location: { city: 'London' }, pricing: { monthly: 100, vat: { monthly: { status: 'none' } } } }));
  extra.push({ _id: 'synthetic-target', title: 'Synthetic [target]', host: 'synthetic-host', location: { city: 'Manchester' }, pricing: { monthly: 100 } });
  listings.push(...extra);
  try {
    for (const params of ['city=Manchester', 'q=' + encodeURIComponent('[target]'), 'city=Manchester&noPhotos=true&vatNotSet=true']) {
      const { status, body } = await get('/properties?limit=50&excludeTest=true&' + params);
      assert.equal(status, 200);
      assert.equal(body.total, 1);
      assert.equal(body.pages, 1);
      assert.equal(body.properties[0]._id, 'synthetic-target');
      assert.deepEqual(body.locations, ['London', 'Manchester']);
    }
    const { body } = await get('/properties?noPhotos=true&vatNotSet=true');
    assert.equal(body.total, 1);
    assert.equal(body.properties[0]._id, 'synthetic-target');
  } finally { listings.splice(listings.length - extra.length); }
});
