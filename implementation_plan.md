# Stripe checkout implementation plan

Tracked plan for finishing payments on the Wondercraft site. Work happens on
branch `stripe-checkout`. Do not push until we are ready.

**Product decisions (locked)**

- Checkout requires a logged-in Supabase user.
- Currency is **EUR**. Payment method for v1 is **card only**.
- After a successful payment: send email, then create an **Econt label**.
- Hosted **Stripe Checkout** (redirect). No Apple Pay / Google Pay in v1.
- Keep orders in `application_orders`. Create a real **Stripe Customer** for
  each user (this is what is missing today — we never reach the Checkout page).
- Retire the Bolt Edge Functions (`supabase/functions/stripe-*`) and do not use
  the subscription tables as the order source of truth.

**Why it fails today (short)**

The order form posts to `POST /api/order`, which never creates a Stripe
Customer (`customer_email` only, and only if keys/DB succeed). Session create
can also fail on missing `STRIPE_SECRET_KEY` / `SUPABASE_URL` +
`SUPABASE_SERVICE_ROLE_KEY`, or on `integration_identifier` if the Stripe
account API version is older than `2026-03-25.dahlia`. The leftover Bolt stack
requires login + a Dashboard `price_id` and writes different tables; the UI
does not call it. Success is claimed by the success URL; webhooks are not a
reliable fulfillment path yet.

---

## How to use this file

Check a box when that item is done on this branch. Do not skip Phase 0–2
before email/Econt: charging without a verified webhook creates unpaid-looking
orders and duplicate labels.

Legend: `[ ]` not started · `[x]` done · `[~]` in progress (use a note)

---

## Phase 0 — Branch and baseline

- [x] Create git branch `stripe-checkout` from `main`
- [x] Write this plan
- [ ] Confirm on Vercel (Production): `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_SITE_URL`
- [ ] Confirm `SUPABASE_URL` is set (not only `NEXT_PUBLIC_SUPABASE_URL`) — admin writes use the non-public name
- [ ] Confirm migration `application_orders` is applied in the live Supabase project
- [ ] Apply new migration `20260908120000_orders_user_and_fulfillment.sql` on the live project
- [ ] Confirm Stripe Dashboard is in the mode we will test first (`sk_test_` locally / preview; `sk_live_` only on production after a test payment works)
- [x] Pin Checkout to API version `2026-03-25.dahlia` in code (no need to upgrade the account blindly)

---

## Phase 1 — One payment stack (Next.js), no Bolt

Goal: one create-session path, one webhook, one order table.

- [x] Remove `integration_identifier` from `stripe.checkout.sessions.create`
- [x] Pin `apiVersion` explicitly in `lib/stripe.ts`
- [x] Keep `mode: 'payment'`, `currency: 'eur'`, `payment_method_types: ['card']`
- [x] Keep **dynamic** `price_data` / `unit_amount` (product + shipping)
- [x] Stop using / do not deploy `supabase/functions/stripe-checkout` and `supabase/functions/stripe-webhook`
- [ ] Point Stripe Dashboard webhooks at `https://<production-domain>/api/stripe/webhook` only (not a Supabase function URL)
- [x] Leave `stripe_subscriptions` unused. Reuse `stripe_customers` as `auth.users.id` → `cus_…`
- [x] Document Stripe + Supabase server env vars in `.env.example` (no secret values)
- [x] Log Stripe `type` / `code` / `param` on the server when session create fails

**Done when:** a logged-in test user submitting the form either redirects to `checkout.stripe.com` or the server log shows a specific Stripe/DB error (not a silent generic fail).

---

## Phase 2 — Login required + Stripe Customer

Goal: no guest pay; every Checkout Session has `customer: cus_…`.

### UI

- [x] Opening “Поръчай” while logged out opens sign-in / sign-up first
- [x] After login, resume the order modal (preserve selected plan)
- [x] `/api/order` rejects unauthenticated requests (verify Supabase JWT from cookies)
- [x] Prefill order email from `user.email`; server overwrites with the account email

### Stripe Customer

- [x] On first checkout: `stripe.customers.create` with email + `metadata.userId`
- [x] Persist mapping (`stripe_customers.user_id` + `customer_id`) with the service role
- [x] Reuse the existing customer on later orders
- [x] Create Checkout Session with `customer` (not `customer_email` alone)
- [x] `metadata`: `orderRef`, `planId`, `userId`
- [x] Idempotency key stays `order_${orderRef}`

### Database

- [x] `application_orders` gains `user_id` (FK to `auth.users`) — migration file added
- [x] RLS: authenticated users can read **their** orders; only `service_role` inserts/updates payment fields
- [ ] Apply migration on the live Supabase project before relying on it in production

**Done when:** Stripe Dashboard shows a Customer for the test user, then a Checkout Session attached to that customer, and the browser reaches the Stripe card page.

---

## Phase 3 — Webhook is source of truth

Goal: “paid” exists only after Stripe says so. Success URL is not fulfillment.

- [x] Handle `checkout.session.completed`, `async_payment_succeeded`, `async_payment_failed`, `expired`
- [x] Keep raw-body signature verify (`request.text()` + `STRIPE_WEBHOOK_SECRET`)
- [x] Look up order by `metadata.orderRef`; ignore unknown events with HTTP 200
- [x] Compare `amount_total` and `currency`; on mismatch set `needs_review` and return **200**
- [x] Store `stripe_checkout_session_id`, `stripe_payment_intent_id`, `last_stripe_event_id`
- [ ] Vercel Deployment Protection: Stripe POSTs must reach `/api/stripe/webhook` without the auth wall
- [ ] Local testing: `stripe listen --forward-to localhost:3000/api/stripe/webhook`
- [x] `/order/success`: thank only if Stripe says the session is `paid` (not from the query string alone)
- [x] `/order/cancel`: leave order pending; expired via webhook

**Done when:** test card `4242 4242 4242 4242` results in `application_orders.status = paid`.

---

## Phase 4 — Email after payment

Goal: shop + customer are notified only when the webhook marks paid.

- [x] Provider: Resend (`RESEND_API_KEY` + `ORDER_EMAIL_FROM`); Stripe receipt via `payment_intent_data.receipt_email`
- [ ] Add Resend keys and `SHOP_NOTIFY_EMAIL` on Vercel
- [x] Customer email (Bulgarian): order ref, plan, total EUR, delivery summary
- [x] Shop/ops email when `SHOP_NOTIFY_EMAIL` is set
- [x] Send from the webhook after paid; skip duplicate `last_stripe_event_id`
- [x] Store `email_sent_at` / `shop_email_sent_at`
- [x] Failed send does not roll back `paid`

**Done when:** one test payment produces emails and no extras on webhook retry.

---

## Phase 5 — Econt label after payment

Goal: create a shipment only for paid orders.

- [ ] Fill `PACKED_PARCEL` with real cm / kg (owner measurement) — labels will fail closed until this is done
- [ ] Confirm Econt sender env on Vercel (`ECONT_MODE=live`, matching contract credentials)
- [x] Add `createShipment()` next to `calculateShipping()`, `mode: 'create'` only
- [x] Call it from the webhook after `paid`, not from `/api/order`
- [x] Persist `econt_shipment_number` / `econt_label_url`
- [x] Idempotent: skip if a shipment number is already stored
- [x] If Econt create fails: order stays `paid`, `econt_label_error` is set; never auto-refund
- [x] No cash-on-delivery on the label

**Done when:** a paid test stores a shipment number on the order.

---

## Phase 6 — Cleanup and launch checks

- [x] Delete Bolt Stripe function source; document retirement in `supabase/functions/README.md`
- [x] Remove unused placeholder `stripePriceId` from plans
- [x] Update README: order flow, env vars, webhook URL, paid ⇒ email ⇒ label
- [x] `npm run typecheck` and `npm run build` clean
- [ ] Production smoke: sign up → order → Stripe card → DB paid → emails → Econt label
- [ ] Confirm no webhook is still registered on the old Supabase function URL

---

## Out of scope for this branch

- Apple Pay, Google Pay, Klarna, cash on delivery
- Subscriptions / recurring billing
- Custom card form (Payment Element)
- Guest checkout
- Translating or rewriting marketing copy except new payment/email strings in Bulgarian

---

## Suggested implementation order (when coding starts)

1. Env audit + drop `integration_identifier` + pin API version (Phase 0–1)
2. Auth gate + Stripe Customer + session create (Phase 2)
3. Webhook + honest success page (Phase 3)
4. Email (Phase 4)
5. Parcel dimensions + Econt create (Phase 5)
6. Remove Bolt leftovers + README (Phase 6)

---

## Progress log

| Date | Note |
| --- | --- |
| 2026-09-08 | Plan written. Branch `stripe-checkout` created. No payment code changed yet. |
| 2026-09-08 | Implemented Phases 1–6 in code. Remaining: Vercel/Supabase/Stripe Dashboard ops, Resend keys, `PACKED_PARCEL`, production smoke. |
