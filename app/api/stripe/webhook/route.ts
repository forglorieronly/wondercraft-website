import { NextResponse } from 'next/server'
import { getStripe, logStripeError } from '@/lib/stripe'
import { fulfillPaidOrder } from '@/lib/order/fulfill'
import { getSupabaseAdmin } from '@/lib/supabase-admin'

export const runtime = 'nodejs'

/**
 * Stripe is the source of truth for payment. Return 200 after a valid
 * signature so Stripe does not retry-storm; flag mismatches for review.
 */
export async function POST(request: Request) {
  const signature = request.headers.get('stripe-signature')
  const secret = process.env.STRIPE_WEBHOOK_SECRET
  if (!signature || !secret) {
    return NextResponse.json({ error: 'Webhook not configured' }, { status: 400 })
  }

  const payload = await request.text()
  let event
  try {
    event = getStripe().webhooks.constructEvent(payload, signature, secret)
  } catch (error) {
    logStripeError(error)
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

  const successful =
    event.type === 'checkout.session.completed' ||
    event.type === 'checkout.session.async_payment_succeeded'
  const failed = event.type === 'checkout.session.async_payment_failed'
  const expired = event.type === 'checkout.session.expired'
  if (!successful && !failed && !expired) {
    return NextResponse.json({ received: true })
  }

  const session = event.data.object as import('stripe').Stripe.Checkout.Session
  const orderRef = session.metadata?.orderRef
  if (!orderRef) {
    console.error(JSON.stringify({ evt: 'stripe.webhook', reason: 'missing_order_ref', id: event.id }))
    return NextResponse.json({ received: true })
  }

  const db = getSupabaseAdmin()
  const { data: order, error: lookupError } = await db
    .from('application_orders')
    .select(
      'id,order_ref,plan_id,customer_name,email,phone,delivery,customization,total_amount,currency,status,last_stripe_event_id,email_sent_at,shop_email_sent_at,econt_shipment_number',
    )
    .eq('order_ref', orderRef)
    .maybeSingle()

  if (lookupError || !order) {
    console.error(JSON.stringify({ evt: 'stripe.webhook', reason: 'order_not_found', orderRef }))
    return NextResponse.json({ received: true })
  }

  if (order.last_stripe_event_id === event.id) {
    return NextResponse.json({ received: true })
  }

  if (
    successful &&
    (session.amount_total !== order.total_amount ||
      (session.currency ?? '').toLowerCase() !== String(order.currency).toLowerCase())
  ) {
    await db
      .from('application_orders')
      .update({
        status: 'needs_review',
        payment_status: session.payment_status ?? 'unpaid',
        stripe_checkout_session_id: session.id,
        last_stripe_event_id: event.id,
      })
      .eq('id', order.id)
    console.error(
      JSON.stringify({
        evt: 'stripe.amount_mismatch',
        orderRef,
        expected: order.total_amount,
        got: session.amount_total,
      }),
    )
    return NextResponse.json({ received: true })
  }

  const update = successful
    ? { status: 'paid', payment_status: session.payment_status ?? 'paid' }
    : failed
      ? { status: 'payment_failed', payment_status: session.payment_status ?? 'unpaid' }
      : { status: 'payment_expired', payment_status: 'unpaid' }

  const { error } = await db
    .from('application_orders')
    .update({
      ...update,
      stripe_checkout_session_id: session.id,
      stripe_payment_intent_id:
        typeof session.payment_intent === 'string' ? session.payment_intent : null,
      last_stripe_event_id: event.id,
    })
    .eq('id', order.id)
    .is('last_stripe_event_id', order.last_stripe_event_id)

  if (error) {
    console.error(JSON.stringify({ evt: 'stripe.webhook', reason: 'update_failed', message: error.message }))
    return NextResponse.json({ error: 'Could not update order' }, { status: 500 })
  }

  if (successful && order.status !== 'paid') {
    await fulfillPaidOrder({
      id: order.id,
      order_ref: order.order_ref,
      plan_id: order.plan_id,
      customer_name: order.customer_name,
      email: order.email,
      phone: order.phone,
      delivery: order.delivery ?? {},
      customization: order.customization,
      total_amount: order.total_amount,
      currency: order.currency,
      email_sent_at: order.email_sent_at,
      shop_email_sent_at: order.shop_email_sent_at,
      econt_shipment_number: order.econt_shipment_number,
    })
  }

  return NextResponse.json({ received: true })
}
