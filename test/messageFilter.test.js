const test = require('node:test');
const assert = require('node:assert/strict');
const containsBlockedContent = require('../utils/messageFilter');

const blocked = (text) => assert.equal(containsBlockedContent(text), true, `should block: ${text}`);
const allowed = (text) => assert.equal(containsBlockedContent(text), false, `should allow: ${text}`);

test('UK postcodes are blocked, spaced or not, any case', () => {
  for (const text of ['Come to SW19 3NJ', 'we are at m1 1ae', 'postcode SW193NJ', 'EC1A 1BB please', 'W1A 0AX', 'B33 8TH']) blocked(text);
});

test('street addresses are blocked', () => {
  for (const text of [
    'It is 12 High Street', 'meet at 5 Baker St', '221b Baker Street', '10 Downing Road', 'number 3 Elm Rd',
    '7 Park Avenue', '14 Mill Lane', '2 Oak Close', '9 Kings Drive', '40 Long Way', '1 Queens Court',
    '6 Market Place', '8 Berkeley Square', '3 Royal Crescent', '15 Grove Terrace', "I'm in flat 4", 'Unit 12 at the estate',
  ]) blocked(text);
});

test('ordinary messages that mention numbers are not mistaken for addresses', () => {
  for (const text of ['Can I book 3 hours on Friday?', 'We need space for 20 people', 'Is parking available?', 'The room is 40 sqm', 'Arriving at 10 am', 'We need 2 rooms close to the station', '3 people on the road trip']) allowed(text);
});

test('social and keyword blocks match whole words only', () => {
  for (const text of ['Does it have instant book?', 'Just a snapshot of the plan', 'For instance, a table', 'Let me send the schedule', 'Great xylophone room']) allowed(text);
  for (const text of ['find me on insta', 'snap me later', 'add me on Instagram', 'message me on WhatsApp', 'my email is below', 'call my phone', 'telegram works', 'fb me']) blocked(text);
});

test('@handles are blocked', () => {
  blocked('follow @studio_jane');
  blocked('@handle');
});

test('existing email, phone and link detection is unchanged', () => {
  blocked('reach me at jane@example.co.uk');
  blocked('call 07700 900123');
  blocked('+44 7700 900123');
  blocked('see www.example.org');
  blocked('https://foo.bar');
  blocked('x.com/someone');
  allowed('The price is £120');
});
