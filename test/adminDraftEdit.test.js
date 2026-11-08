const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const authId = require.resolve('../middleware/auth');
const pass = (req, _res, next) => { req.user = { id: 'synthetic-admin' }; next(); };
require.cache[authId] = { id: authId, filename: authId, loaded: true, exports: Object.assign(pass, { adminAuth: pass, requireAdminRole: () => pass }) };
const Draft = require('../models/Draft');

// Wholly synthetic draft, no client data and no database connection.
const makeDraft = () => ({
  _id: 'synthetic-draft',
  host: 'synthetic-host',
  title: 'Synthetic studio',
  coverImage: 'https://example.test/a.jpg',
  step: 7,
  formData: {
    title: 'Synthetic studio',
    description: 'Original description',
    capacity: 4,
    images: ['https://example.test/a.jpg', 'https://example.test/b.jpg'],
    pricing: { monthly: { enabled: true, price: '500' } },
    city: 'London',
  },
});
let store = makeDraft();
let writes = 0;
Draft.findById = async (id) => (id === store._id ? { ...store } : null);
Draft.findByIdAndUpdate = async (id, update) => {
  if (id !== store._id) return null;
  writes += 1;
  store = { ...store, ...update };
  return store;
};

const app = express();
app.use(express.json());
app.use('/admin', require('../routes/admin'));
const server = app.listen(0, '127.0.0.1');
const ready = new Promise((resolve) => server.on('listening', resolve));
test.after(() => server.close());
const put = async (id, body) => {
  await ready;
  const res = await fetch(`http://127.0.0.1:${server.address().port}/admin/drafts/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

test('admin edit changes only the allowed fields and keeps the rest of the draft', async () => {
  store = makeDraft();
  const { status, body } = await put('synthetic-draft', {
    title: '  Renamed studio  ',
    description: 'New description',
    capacity: '8',
    images: ['https://example.test/b.jpg', 'https://example.test/c.jpg', 'https://example.test/b.jpg'],
    pricing: { monthly: { enabled: true, price: '1' } },
    host: 'someone-else',
    step: 1,
  });
  assert.equal(status, 200);
  assert.equal(body.draft.title, 'Renamed studio');
  assert.equal(body.draft.coverImage, 'https://example.test/b.jpg');
  assert.equal(body.draft.formData.capacity, 8);
  assert.deepEqual(body.draft.formData.images, ['https://example.test/b.jpg', 'https://example.test/c.jpg']);
  assert.equal(body.draft.formData.pricing.monthly.price, '500', 'prices are not editable here');
  assert.equal(body.draft.formData.city, 'London');
  assert.equal(body.draft.host, 'synthetic-host', 'host cannot be reassigned');
  assert.equal(body.draft.step, 7, 'step is left as the host saved it');
});

test('removing every photo clears the cover image', async () => {
  store = makeDraft();
  const { status, body } = await put('synthetic-draft', { images: [] });
  assert.equal(status, 200);
  assert.equal(body.draft.coverImage, '');
  assert.deepEqual(body.draft.formData.images, []);
});

test('bad input is rejected without writing anything', async () => {
  store = makeDraft();
  writes = 0;
  for (const bad of [
    {},
    { title: '   ' },
    { title: 5 },
    { title: 'x'.repeat(151) },
    { description: 'x'.repeat(5001) },
    { capacity: -1 },
    { capacity: 'lots' },
    { images: 'https://example.test/a.jpg' },
    { images: ['javascript:alert(1)'] },
    { images: ['data:image/png;base64,AAAA'] },
    { images: Array.from({ length: 31 }, (_, i) => `https://example.test/${i}.jpg`) },
  ]) {
    const { status } = await put('synthetic-draft', bad);
    assert.equal(status, 400, JSON.stringify(bad).slice(0, 60));
  }
  assert.equal(writes, 0);
});

test('unknown draft returns 404', async () => {
  const { status } = await put('synthetic-missing', { title: 'Nope' });
  assert.equal(status, 404);
});
