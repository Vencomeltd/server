const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

// Spec section 6: messages from customers always reach the host's own email.
// Wholly synthetic users, listing and conversation; no database or email sent.
const sent = [];
const sendEmailId = require.resolve('../utils/sendEmail');
require.cache[sendEmailId] = { id: sendEmailId, filename: sendEmailId, loaded: true, exports: async (mail) => { sent.push(mail); } };
const GUEST = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const HOST = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const authId = require.resolve('../middleware/auth');
require.cache[authId] = { id: authId, filename: authId, loaded: true, exports: (req, _res, next) => { req.user = { id: GUEST }; next(); } };

const Message = require('../models/Message');
const Conversation = require('../models/Conversation');
const Property = require('../models/Property');
const User = require('../models/User');

const host = { _id: HOST, email: 'host-own@synthetic.example.test', firstName: 'Synth' };
const users = { [HOST]: host, [GUEST]: { _id: GUEST, email: 'guest@synthetic.example.test', firstName: 'Guest' } };
Property.findById = () => ({ populate: async () => ({ _id: 'cccccccccccccccccccccccc', title: 'Synthetic room', host }) });
Conversation.findOne = async () => null;
Conversation.findById = async () => ({ _id: 'dddddddddddddddddddddddd', host: HOST, guest: GUEST });
Conversation.findByIdAndUpdate = async () => null;
Conversation.prototype.save = async function () { return this; };
Message.prototype.save = async function () { return this; };
Message.prototype.populate = async function () { return this; };
User.findById = (id) => ({ select: async () => users[String(id)] || null });

const app = express();
app.use(express.json());
// Socket.io stand-in: nobody is online, so the recipient is emailed.
app.set('io', { to: () => ({ emit: () => {} }), sockets: { adapter: { rooms: new Map() } } });
app.use('/messages', require('../routes/messages'));
const server = app.listen(0, '127.0.0.1');
const ready = new Promise((resolve) => server.on('listening', resolve));
test.after(() => server.close());
const post = async (route, body) => {
  await ready;
  const res = await fetch(`http://127.0.0.1:${server.address().port}/messages${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.status;
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test('a booking enquiry from the listing page emails the host at their own address', async () => {
  sent.length = 0;
  const status = await post('/enquiry', { propertyId: 'cccccccccccccccccccccccc', checkIn: '2026-12-01', checkOut: '2026-12-02', guests: 1, durationType: 'daily', totalPrice: 100, message: 'Is <b>parking</b> included?' });
  await settle();
  assert.equal(status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'host-own@synthetic.example.test');
  assert.ok(sent[0].html.includes('&lt;b&gt;parking&lt;/b&gt;'), 'customer text is escaped in the email');
});

test('a customer message emails the host at their own address', async () => {
  sent.length = 0;
  const status = await post('/', { conversationId: 'dddddddddddddddddddddddd', text: 'Hello host' });
  await settle();
  assert.equal(status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'host-own@synthetic.example.test');
});
