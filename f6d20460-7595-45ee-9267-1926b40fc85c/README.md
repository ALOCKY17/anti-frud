# Clearline local Stripe test-mode review

Clearline receives signed Stripe **test-mode** PaymentIntent webhooks and stores minimal payment metadata in a local SQLite database. It never authorizes, cancels, refunds, or blocks payments. Review labels are internal notes only.

## Requirements

- Node.js 22.13 or newer
- A Stripe account in test mode
- Stripe CLI, signed in to that test account

## Start the local dashboard

First install dependencies and copy the ignored local environment template:

```powershell
npm install
Copy-Item .env.example .env
```

In one PowerShell terminal, authenticate the Stripe CLI with your test account and forward only the PaymentIntent events Clearline processes:

```powershell
stripe login
stripe listen --events payment_intent.created,payment_intent.processing,payment_intent.requires_action,payment_intent.payment_failed,payment_intent.succeeded,payment_intent.canceled --forward-to http://127.0.0.1:4242/webhooks/stripe
```

Copy the temporary `whsec_...` signing secret printed by `stripe listen` into `.env` as `STRIPE_WEBHOOK_SECRET=whsec_...`. In a second terminal, start the dashboard:

```powershell
npm start
```

The app listens only on `127.0.0.1:4242`. Open <http://127.0.0.1:4242>. Never share secrets in chat, commit them, or add them to browser code. Keep both processes running. To generate sample test payment events:

```powershell
stripe trigger payment_intent.payment_failed
stripe trigger payment_intent.succeeded
```

The Stripe CLI command creates test-mode events only. The webhook verifies Stripe's signature, rejects live-mode events, and uses event IDs for idempotency. The dashboard refresh button reloads received cases.

## What is stored

The local `data/clearline.sqlite` database stores Stripe event IDs/types and PaymentIntent ID, amount, currency, processor status, timestamps, failed-event count, a processor decline code, and local review decisions. It does not store raw webhook bodies, customer names/emails, card numbers, CVCs, or payment-method details. Stripe may include customer data in its webhook payloads; Clearline reads only the fields it needs and discards the raw payload after signature verification.

The local heuristic gives points for failed PaymentIntent events and amounts in `HIGH_VALUE_CURRENCY` (default USD) at or above `HIGH_VALUE_MINOR` (default `100000`, in that currency's smallest unit). It is illustrative—not calibrated, a fraud determination, or suitable for automatic declines. A `low concern`, `reviewed`, or `flagged` action changes only Clearline's local case status.

## Tests

```powershell
npm test
```

Tests use signed, locally generated Stripe-shaped fixtures and a temporary SQLite database. They do not contact Stripe or require credentials.

## Not production-ready

This is a local development integration, not a deployable multi-user risk platform. Do not expose it to the internet or use live-mode events. Before production, add authenticated merchant/user tenancy, authorization and CSRF protection, managed encrypted storage, secret rotation, migrations/backups, monitoring, retention controls, operational review/audit policy, and risk-rule validation against merchant-owned outcomes. A production webhook endpoint must be publicly reachable over HTTPS and configured in Stripe Dashboard; this local server deliberately binds to loopback only.
