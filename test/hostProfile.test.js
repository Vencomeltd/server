const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const authId = require.resolve('../middleware/auth');
const pass = (_req, _res, next) => next();
require.cache[authId] = { id: authId, filename: authId, loaded: true, exports: pass };
const User = require('../models/User');
const Property = require('../models/Property');
// Wholly synthetic records, no client listing IDs or database connection.
const hostId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const listings = [
  { _id: 'synthetic-live', host: hostId, isActive: true, reviews: [] },
  { _id: 'synthetic-unpublished', host: hostId, isActive: false, reviews: [] },
  { _id: 'synthetic-pending', host: hostId, isActive: false, moderationStatus: 'pending_review', reviews: [] },
];
const matches = (doc, filter) => Object.entries(filter).every(([key, want]) => String(doc[key]) === String(want));
const host = { _id: hostId, firstName: 'Synthetic', slug: 'synthetic-host', toObject() { const { toObject, ...rest } = this; return rest; } };
User.findById = () => ({ select: async () => host });
Property.countDocuments = async (filter) => listings.filter(doc => matches(doc, filter)).length;
Property.find = (filter) => ({ select: async () => listings.filter(doc => matches(doc, filter)) });
const app = express();
app.use('/hosts', require('../routes/hosts'));
const server = app.listen(0, '127.0.0.1');
const ready = new Promise(resolve => server.on('listening', resolve));
test.after(() => server.close());
test('public host profile counts only the live listings it can show', async () => {
  await ready;
  const res = await fetch(`http://127.0.0.1:${server.address().port}/hosts/${hostId}`);
  const body = await res.json();
  assert.equal(res.status, 200);
  // GET /properties?host= (the cards on the page) lists isActive listings only.
  assert.equal(body.totalListings, listings.filter(doc => doc.isActive).length);
});
