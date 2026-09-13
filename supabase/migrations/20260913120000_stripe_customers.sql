-- Stripe Customer per signed-in user.
--
-- lib/stripe-customer.ts reads this before every Checkout Session, so without
-- it /api/order throws and the customer never reaches the payment page.
--
-- Deliberately the table only. The Bolt-template migrations (20260827201756,
-- 20260827201820) also create stripe_subscriptions, stripe_orders and two
-- views for a subscription model this shop does not have; they are left on
-- disk unapplied.

create table if not exists public.stripe_customers (
  id bigint primary key generated always as identity,
  user_id uuid not null unique references auth.users (id),
  customer_id text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz default null
);

-- Only the service role touches this table (getSupabaseAdmin). RLS on with no
-- policy is the deny-by-default we want: a leaked anon key reads nothing.
alter table public.stripe_customers enable row level security;

revoke all on public.stripe_customers from anon, authenticated;
grant all on public.stripe_customers to service_role;

-- The lookup in getOrCreateStripeCustomer filters on deleted_at, so index the
-- live rows rather than every row ever soft-deleted.
create index if not exists stripe_customers_user_id_idx
  on public.stripe_customers (user_id)
  where deleted_at is null;

drop trigger if exists stripe_customers_updated_at on public.stripe_customers;
create trigger stripe_customers_updated_at
before update on public.stripe_customers
for each row execute function public.set_application_orders_updated_at();
