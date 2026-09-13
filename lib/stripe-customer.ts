import 'server-only'

import { getStripe } from '@/lib/stripe'
import { getSupabaseAdmin } from '@/lib/supabase-admin'

/**
 * Stripe Customer id for this Supabase user. Creates the Customer and the
 * `stripe_customers` row on first checkout so hosted Checkout always has
 * `customer: cus_…` (the missing piece that blocked the payment page).
 */
export async function getOrCreateStripeCustomer(input: {
  userId: string
  email: string
}): Promise<string> {
  const db = getSupabaseAdmin()
  const { data: existing, error: lookupError } = await db
    .from('stripe_customers')
    .select('customer_id')
    .eq('user_id', input.userId)
    .is('deleted_at', null)
    .maybeSingle()

  if (lookupError) throw new Error(`Could not load Stripe customer: ${lookupError.message}`)
  if (existing?.customer_id) return existing.customer_id as string

  const customer = await getStripe().customers.create(
    {
      email: input.email,
      metadata: { userId: input.userId },
    },
    { idempotencyKey: `customer_${input.userId}` },
  )

  const { error: insertError } = await db.from('stripe_customers').insert({
    user_id: input.userId,
    customer_id: customer.id,
  })

  if (insertError) {
    // A concurrent first checkout may have won the unique(user_id) race.
    const { data: raced } = await db
      .from('stripe_customers')
      .select('customer_id')
      .eq('user_id', input.userId)
      .is('deleted_at', null)
      .maybeSingle()
    if (raced?.customer_id) return raced.customer_id as string
    throw new Error(`Could not save Stripe customer: ${insertError.message}`)
  }

  return customer.id
}
