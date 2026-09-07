# Edge Functions

The Bolt Stripe functions (`stripe-checkout`, `stripe-webhook`) are retired.

Checkout is created in the Next.js route `POST /api/order`. Stripe webhooks
are handled at `POST /api/stripe/webhook` on Vercel.

Do not deploy a Stripe webhook to Supabase — it expected a logged-in SaaS
subscription flow and ignored Checkout Sessions that had no Customer object.
