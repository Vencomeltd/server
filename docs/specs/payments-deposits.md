# VenCome Payments and Deposits Build Spec

Save this file in both repos as `docs/specs/payments-deposits.md`.

To start, tell Claude Code: "Read docs/specs/payments-deposits.md. Do Phase 0 only. Stop and report."

Then run one phase per session. After each phase, Claude Code stops, reports the changed files, and waits for approval.

---

## Rules for Claude Code

1. Work one phase at a time. Stop after each phase and list every changed file.
2. Surgical edits only. Do not refactor or restyle code outside the phase scope.
3. Use our existing stack: plain JavaScript (CommonJS) in vencome-server and React (JSX) in vencome-client. No TypeScript or Zod. Validate every request body with `express-validator` (already a server dependency).
4. Store every money value as an integer in pence (GBP). Never use floats for money.
5. Every Stripe write call gets an idempotency key built from the booking ID and the action, for example `hold:{bookingId}:v1`.
6. Every Stripe webhook handler must be idempotent. Store processed `event.id` values and skip duplicates.
7. Read all timing values from the config file in Phase 1. Never hardcode hours in the logic.
8. If the existing code conflicts with this spec, stop and report. Do not guess.

---

## Business rules (source of truth)

- Market: UK only. Currency: GBP only.
- Charge type: Stripe Connect **separate charges and transfers**. The platform charges the customer and holds the funds. The host share is transferred after the release window.
- Commission: 10% (confirmed by the client), set in admin config. The host gets `listingPrice - commission`. The host amount is always based on the listing price, never on the amount left after Stripe fees.
- Stripe fees: VenCome pays them from its commission. No customer service fee. Keep a `serviceFeePercent` config at 0 for later.
- Booking price is charged in full at booking. This covers no-shows.
- Deposit modes per listing: `none`, `card_hold`, `charged`.
- `charged` is only allowed when the booking value is over £200 (20000 pence).
- Card hold timing, based on the saved card brand:
  - Visa: hold placed 48 hours before check-in
  - Mastercard and Amex: hold placed 72 hours before check-in
  - Any other brand: use the Visa rule
  - If the booking is made inside that lead time, place the hold at booking while the customer is present
- Hold failure: the customer gets 24 hours to add a new card. After that, the host decides: proceed without a deposit, or cancel.
- Damage claim window: 24 hours after checkout (confirmed by the client).
- No damage claim: cancel the hold. The customer pays nothing.
- Damage claim approved: capture only the approved amount.
- Always read `capture_before` from the charge. Never capture or release after that time.
- If a stay is too long for a card hold to cover (see the coverage check in Phase 3), the listing falls back to its `longStayFallback` setting: `none` or `charged`.

---

## Phase 0: Audit (read-only)

Do not edit any file. Report the following, with file paths and line numbers.

1. Every Stripe call in vencome-server: `paymentIntents`, `checkout.sessions`, `transfers`, `refunds`, `accounts`, `setupIntents`, `customers`. For each call, list `transfer_data`, `application_fee_amount`, `on_behalf_of`, `transfer_group`, `capture_method`, and `setup_future_usage` if present.
2. Which charge type the code uses today: direct, destination, or separate charges and transfers.
3. The current escrow release job: file, schedule method (cron, queue, setTimeout), the 72-hour window logic, and the host payout formula.
4. Every deposit, wallet, claim, and dispute field in any Mongoose model.
5. The current deposit flow: where the deposit is charged, and whether it shares a PaymentIntent with the rent.
6. Whether Stripe Customers are created for users, and whether payment methods are saved.
7. Every scheduled job in the server, with schedule and purpose.
8. Every handled Stripe webhook event, with file and handler name.
9. The cancellation refund logic, and which tier version is in code (50%/0% or 75%/50%). Report only.
10. Where vencome-server is hosted, and whether a long-running process is available for scheduled jobs.
11. The host portal listing form and the API route that saves listing settings.

End with a gap list between the current code and this spec.

---

## Phase 1: Config and data models

### 1.1 Config file

`config/payments.js` already exists with `escrowReleaseHours: 48` (hours after checkout, used by the payout job). Extend it with the rest:

```js
const PAYMENTS_CONFIG = Object.freeze({
  currency: "gbp",
  commissionRate: 0.10,            // overridden by admin setting if present
  serviceFeePercent: 0,            // customer fee, off for now
  chargedDepositMinPence: 20000,   // £200
  holdLeadHours: {
    visa: 48,
    mastercard: 72,
    amex: 72,
    default: 48,
  },
  claimWindowHours: 24,
  cardFixHours: 24,
  captureSafetyMarginHours: 6,     // act before capture_before minus this margin
  escrowReleaseHours: 48,          // hours after checkout; already live
  schedulerIntervalMinutes: 5,
});

module.exports = { PAYMENTS_CONFIG };
```

### 1.2 Listing model additions

```ts
deposit: {
  mode: { type: String, enum: ["none", "card_hold", "charged"], default: "none" },
  amountPence: { type: Number, min: 0, default: 0 },
  longStayFallback: { type: String, enum: ["none", "charged"], default: "none" },
}
```

### 1.3 User model additions

```ts
stripeCustomerId: { type: String, index: true }
```

### 1.4 Booking model additions

```ts
payment: {
  paymentIntentId: String,
  chargeId: String,
  amountPence: Number,           // total charged for the booking
  listingPricePence: Number,
  commissionPence: Number,
  hostAmountPence: Number,
  stripeFeePence: Number,        // from the balance transaction
  transferGroup: String,         // "booking_{bookingId}"
  transferId: String,
  transferredAt: Date,
  status: { type: String, enum: ["pending", "paid", "transferred", "refunded", "partially_refunded"] },
},
deposit: {
  mode: { type: String, enum: ["none", "card_hold", "charged"] },
  amountPence: Number,
  paymentMethodId: String,
  cardBrand: String,
  holdAt: Date,                  // when the hold is scheduled
  paymentIntentId: String,
  captureBefore: Date,           // from charge.payment_method_details.card.capture_before
  status: {
    type: String,
    enum: [
      "not_required", "scheduled", "held", "failed", "awaiting_new_card",
      "awaiting_host_decision", "waived", "released", "captured",
      "partially_captured", "charged", "refunded",
    ],
  },
  failureReason: String,
  cardFixDeadline: Date,
  hostDecision: { type: String, enum: ["proceed_without_deposit", "cancel"] },
  capturedPence: Number,
},
claim: {
  status: { type: String, enum: ["none", "open", "approved", "rejected"], default: "none" },
  amountPence: Number,
  reason: String,
  evidenceUrls: [String],        // Cloudflare R2
  openedAt: Date,
  resolvedAt: Date,
  resolvedBy: { type: Schema.Types.ObjectId, ref: "User" },
  approvedAmountPence: Number,
},
```

Add indexes on `deposit.status` + `deposit.holdAt`, and `deposit.status` + `deposit.captureBefore`.

### 1.5 Webhook event log

New model `StripeEvent`: `{ eventId: unique string, type: string, processedAt: Date }`.

---

## Phase 2: Checkout (separate charges and transfers)

Route: `POST /api/bookings/:bookingId/payment-intent`

1. Get or create the Stripe Customer for the user. Save `stripeCustomerId`.
2. Calculate amounts in pence:
   - `commissionPence = round(listingPricePence * commissionRate)`
   - `hostAmountPence = listingPricePence - commissionPence`
   - `amountPence = listingPricePence` (plus the service fee if the config is above 0)
3. Create the PaymentIntent on the platform account:

```ts
stripe.paymentIntents.create({
  amount: amountPence,
  currency: "gbp",
  customer: stripeCustomerId,
  setup_future_usage: "off_session",   // saves the card for the deposit hold
  transfer_group: `booking_${bookingId}`,
  metadata: { bookingId, type: "booking" },
  automatic_payment_methods: { enabled: true },
}, { idempotencyKey: `booking-pi:${bookingId}:v1` });
```

4. Do not set `transfer_data`, `application_fee_amount`, or `on_behalf_of`.
5. Only set `setup_future_usage` when the listing deposit mode is `card_hold`.
6. Return the `client_secret` to the client.

On `payment_intent.succeeded` (type `booking`):
- Save `chargeId`, `paymentMethodId`, and `cardBrand` from `charge.payment_method_details.card.brand`.
- Retrieve the balance transaction and save `stripeFeePence`.
- Set `payment.status = "paid"`.
- Run the deposit scheduling logic from Phase 3.

---

## Phase 3: Deposit hold scheduling

### 3.1 Coverage check

A card hold must stay valid until checkout plus the claim window.

```js
function holdWindowHours(brand, onSession) {
  if (onSession) return 7 * 24;                 // customer present: 7 days
  if (brand === "visa") return 4 * 24 + 18;     // Visa merchant-initiated: 4 days 18 hours
  return 7 * 24;                                // Mastercard, Amex, others
}

function leadHours(brand) {
  return PAYMENTS_CONFIG.holdLeadHours[brand] ?? PAYMENTS_CONFIG.holdLeadHours.default;
}
```

For the planned hold:
- `holdAt = checkIn - leadHours(brand)`
- `onSession = now >= holdAt` (the booking is inside the lead time, so hold now at booking)
- `effectiveHoldAt = onSession ? now : holdAt`
- `needUntil = checkOut + claimWindowHours + captureSafetyMarginHours`
- Covered if `effectiveHoldAt + holdWindowHours(brand, onSession) >= needUntil`

If not covered, apply `longStayFallback`:
- `none`: set `deposit.status = "not_required"`
- `charged`: only if the booking value is over £200, else `not_required`

Run this check at checkout, before payment, and show the customer which deposit applies.

### 3.2 Scheduling

- Covered and `onSession`: place the hold right after the booking payment succeeds, on-session (Phase 3.3).
- Covered and not `onSession`: set `deposit.status = "scheduled"` and `deposit.holdAt`.

### 3.3 Placing a hold

```ts
stripe.paymentIntents.create({
  amount: depositAmountPence,
  currency: "gbp",
  customer: stripeCustomerId,
  payment_method: paymentMethodId,
  capture_method: "manual",
  confirm: true,
  off_session: !onSession,
  metadata: { bookingId, type: "deposit_hold" },
}, { idempotencyKey: `deposit-hold:${bookingId}:v1` });
```

On success:
- Retrieve the latest charge and save `captureBefore` from `payment_method_details.card.capture_before`.
- Set `deposit.status = "held"`.

On a `card_declined`, `authentication_required`, or `expired_card` error:
- Set `deposit.status = "awaiting_new_card"` and save `failureReason`.
- Set `cardFixDeadline = now + cardFixHours`.
- Send the failure notifications (Phase 9).

### 3.4 Scheduler

Use node-cron (or the existing scheduler found in Phase 0), running every 5 minutes. The scheduler must be idempotent and safe after a restart.

Each run:
1. Place holds: `deposit.status = "scheduled"` and `holdAt <= now`.
2. Expire card fixes: `deposit.status = "awaiting_new_card"` and `cardFixDeadline <= now`. Set `awaiting_host_decision` and notify the host.
3. Release holds: `deposit.status = "held"`, `claim.status = "none"`, and `now >= checkOut + claimWindowHours`. Cancel the PaymentIntent, set `released`.
4. Protect expiring holds: `deposit.status = "held"`, `claim.status = "open"`, and `now >= captureBefore - captureSafetyMarginHours`. Capture the claimed amount, set `claim.status` to stay `open`, and alert admin. If the claim is later rejected or reduced, refund the difference.
5. Transfer host payouts (Phase 6).

---

## Phase 4: Hold failure flow

Route: `POST /api/bookings/:bookingId/deposit/update-card` (customer)
- Create a SetupIntent for the customer. The client confirms it.
- On success, place the hold on-session with the new card (Phase 3.3 with `onSession = true`).
- Re-run the coverage check with the new brand.

Route: `POST /api/bookings/:bookingId/deposit/host-decision` (host)
- Body: `{ decision: "proceed_without_deposit" | "cancel" }`
- Only allowed when `deposit.status = "awaiting_host_decision"`.
- `proceed_without_deposit`: set `deposit.status = "waived"`.
- `cancel`: run the cancellation flow as a customer cancellation (Phase 8).

---

## Phase 5: Damage claims

Route: `POST /api/bookings/:bookingId/claims` (host)
- Allowed only between checkout and `checkOut + claimWindowHours`.
- Body: `{ amountPence, reason, evidenceUrls }`. Validate `amountPence <= deposit.amountPence`.
- Evidence uploads go through the existing R2 upload validation.
- Set `claim.status = "open"`. Notify the customer and admin.

Route: `POST /api/admin/claims/:bookingId/resolve` (admin, RBAC, audit logged)
- Body: `{ decision: "approve" | "reject", approvedAmountPence? }`
- Approve on a held deposit: `paymentIntents.capture(id, { amount_to_capture: approvedAmountPence })`. Stripe releases the rest automatically. Set `captured` or `partially_captured`.
- Reject on a held deposit: cancel the PaymentIntent. Set `released`.
- If the deposit was already captured in Phase 3.4 step 4, refund the rejected or reduced part.
- Transfer approved damage money to the host with a separate transfer, `source_transaction` set to the deposit charge.

---

## Phase 6: Host payout

In the scheduler, find bookings where `payment.status = "paid"`, the booking is not cancelled, and the release window has passed (`checkOut + escrowReleaseHours`, as the current payout job already does).

```ts
stripe.transfers.create({
  amount: hostAmountPence,
  currency: "gbp",
  destination: hostStripeAccountId,
  source_transaction: chargeId,
  transfer_group: `booking_${bookingId}`,
  metadata: { bookingId, type: "host_payout" },
}, { idempotencyKey: `host-payout:${bookingId}:v1` });
```

Save `transferId` and `transferredAt`. Set `payment.status = "transferred"`.

Dashboard setting, not code: set VenCome's own platform payouts to manual in the Stripe Dashboard, and request funds segregation access from Stripe.

---

## Phase 7: Charged deposit mode

- Only when `deposit.mode` (or the fallback) is `charged` and the booking value is over £200.
- Charge the deposit as its own PaymentIntent at booking (`type: "deposit_charged"`), not combined with the rent. This keeps refunds clean.
- After the claim window with no claim: refund the full deposit.
- Approved claim: refund the deposit minus the approved amount, and transfer the approved amount to the host.
- Stripe does not return its fee on refunds. VenCome absorbs this.

---

## Phase 8: Cancellations

- Read the refund percentage from a config table. Do not hardcode tiers, since the policy version is still open (50%/0% vs 75%/50%).
- Refund the booking PaymentIntent by the policy amount.
- If the host payout was already transferred, reverse the host share with `stripe.transfers.createReversal`.
- Cancel any scheduled or held deposit. Refund any charged deposit.
- A no-show is not a cancellation. The host payout proceeds as normal.

---

## Phase 9: Notifications (SendGrid + Twilio)

| Event | Customer | Host | Admin |
|---|---|---|---|
| Deposit hold placed | Email | | |
| Hold failed | Email + SMS with update-card link | Email | |
| Card fix deadline passed | | Email + SMS with decision link | |
| Claim opened | Email | | Email |
| Claim resolved | Email | Email | |
| Deposit released | Email | | |
| Hold about to expire with open claim | | | Email |
| Host payout sent | | Email | |

---

## Phase 10: Webhooks

Handle, with idempotency via `StripeEvent`:
- `payment_intent.succeeded`: route by `metadata.type`
- `payment_intent.payment_failed`
- `payment_intent.amount_capturable_updated`: confirm the hold is active
- `payment_intent.canceled`: confirm the hold was released
- `charge.refunded`
- `charge.dispute.created`: flag the booking, alert admin
- `transfer.reversed`

Verify the signature with the raw request body.

---

## Phase 11: Frontend (vencome-client)

1. Host portal, listing form: a deposit settings section with mode, amount, and long-stay fallback. Show a note when `charged` is selected: only applies to bookings over £200.
2. Checkout: price breakdown, deposit summary ("£X will be held on your card 48 to 72 hours before check-in. You're only charged if there's damage."), and consent text for saving the card.
3. Customer booking page: a deposit status badge (scheduled, held, released, captured), and an update-card screen for the failure flow.
4. Host booking page: a damage claim form (active only inside the claim window) with R2 evidence upload, and host decision buttons for the failure flow.
5. Admin dashboard: a claims queue with booking details, evidence, hold expiry countdown, and approve/reject with amount.

Forms follow the existing client pattern (controlled React state, as in CreateSpace and EditSpace). Data fetching uses TanStack Query or the existing `apiFetch` helper. Mobile responsive. Code blocks marked `ts` elsewhere in this spec are illustrative; write them as plain JavaScript.

---

## Phase 12: Testing

Use Stripe test mode and test clocks to move time forward.

Test cards:
- Visa success: 4242 4242 4242 4242
- Mastercard success: 5555 5555 5555 4444
- Amex success: 3782 822463 10005
- Requires authentication: 4000 0025 0000 3155
- Insufficient funds: 4000 0000 0000 9995
- Attaches, then fails on later charges: 4000 0000 0000 0341

Test cases:
1. Visa booking made 2 months ahead. The hold is placed 48 hours before check-in.
2. Mastercard booking made 2 months ahead. The hold is placed 72 hours before check-in.
3. Booking made 24 hours before check-in. The hold is placed at booking.
4. Hold fails (card 0341). The customer gets the update-card link. Fixing the card places a new hold.
5. Hold fails and the customer doesn't act. After 24 hours the host gets the decision prompt. Test both decisions.
6. No claim. The hold is released after the claim window.
7. Claim approved for a partial amount. Only that amount is captured.
8. Claim still open near `captureBefore`. The system captures the claimed amount and alerts admin.
9. A 5-day stay on a card-hold listing. The fallback applies.
10. Charged deposit on a £250 booking. Full refund after the window with no claim.
11. Host payout after the release window. The transfer uses `source_transaction` and the host gets exactly 90% of the listing price.
12. Cancellation after the host payout. The transfer is reversed.
13. A duplicate webhook event is ignored.

---

## Open decisions (confirm before the related phase)

1. Damage claim window: DECIDED, 24 hours (affects Phase 3 and 5)
2. Commission: DECIDED, 10% (config value only)
3. Cancellation policy tiers: 50%/0% or 75%/50% (Phase 8)
4. Escrow release window: 72 hours or other (Phase 6)
5. Who resolves claims: VenCome admin only, or the host and customer first (Phase 5)
6. Stripe extended holds (up to 30 days): ask Stripe if VenCome qualifies. If yes, the coverage check in Phase 3 changes.

---

## Implementation status (2026-09-24)

Phases 1 to 11 are built and dark-launched. Nothing changes for live customers until `PAYMENTS_V2=true` is set on the server.

**Naming (to avoid clashing with the live deposit/wallet system):** on a booking the spec's `deposit` is `depositHold` and `claim` is `damageClaim`. On a listing the spec's `deposit` is `depositPolicy`. `payment` keeps its spec name. The legacy `deposit`, wallet and Checkout-Session flow are untouched.

**Where things live (vencome-server):**
- `config/payments.js`: timings, cancellation tiers, `isPaymentsV2Enabled()`
- `utils/paymentsV2/amounts.js`: pure maths and hold-coverage planning (unit tested)
- `utils/paymentsV2/depositHold.js`: place, release, capture, refund, claim transfer
- `utils/paymentsV2/bookingPayment.js`: webhook handling for the new flow
- `utils/paymentsV2/scheduler.js`: 5-minute cron (holds, card-fix expiry, releases, expiring-hold capture, host payouts)
- `utils/paymentsV2/cancel.js`: cancellation refunds and transfer reversal
- `routes/paymentsV2.js`: payment-intent, update-card, host-decision, claims
- `routes/adminClaims.js`: admin claims queue and resolve
- `models/StripeEvent.js`: processed webhook event ids

**To switch on (test mode first):**
1. Set `PAYMENTS_V2=true` on the server (Render).
2. In the Stripe Dashboard webhook endpoint, add these events on top of `checkout.session.completed` and `charge.dispute.created`: `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.amount_capturable_updated`, `payment_intent.canceled`, `charge.refunded`, `transfer.reversed`.
3. Dashboard settings (not code): set platform payouts to manual and request funds segregation access.
4. Run the Phase 12 cases with Stripe test keys and test clocks. The pure-logic cases run with `node --test test/paymentsV2.test.js`.

**Deliberate deviations:** `setup_future_usage` is also set for `charged` deposits (the saved card is needed to charge them); the PaymentIntent uses `allow_redirects: "never"`; a host cancelling after a failed hold gets the normal customer refund tier; a reversed transfer is proportional to the refund percent.
