-- Link orders to the logged-in user and record post-payment fulfillment.

alter table public.application_orders
  add column if not exists user_id uuid references auth.users (id),
  add column if not exists stripe_customer_id text,
  add column if not exists email_sent_at timestamptz,
  add column if not exists shop_email_sent_at timestamptz,
  add column if not exists econt_shipment_number text,
  add column if not exists econt_label_url text,
  add column if not exists econt_label_error text;

create index if not exists application_orders_user_id_idx
  on public.application_orders (user_id);

drop policy if exists "Users can view their own application orders"
  on public.application_orders;

create policy "Users can view their own application orders"
  on public.application_orders
  for select
  to authenticated
  using (user_id = auth.uid());

grant select on public.application_orders to authenticated;
