import 'server-only'

import { findPlan, type Plan } from '@/lib/data/pricing'
import { addMoney, eur, toEur, type Money } from '@/lib/money'
import type { CityDto, DeliveryDto, OfficeDto } from '@/lib/econt/dto'
import { logFailure } from '@/lib/econt/route-helpers'
import { calculateShipping } from '@/lib/econt/shipping'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import type { OrderInput } from './schema'

/**
 * The resolved destination, or as much of it as Econt would tell us.
 *
 * `city` is null when Econt was unreachable at submit time. The order is still
 * accepted — see the note in submitOrder — so the raw identifiers the browser
 * sent are kept for the follow-up phone call.
 */
export type OrderContext = {
  city: CityDto | null
  office: OfficeDto | null
  rawCityId: number
  rawOfficeCode: string | null
}

export type AcceptedOrder = {
  orderRef: string
  plan: Plan
  product: Money
  /** Null when Econt could not price it; we confirm by phone in that case. */
  shipping: Money | null
  total: Money
  quoteId: string | null
}

/**
 * Accept an order.
 *
 * The single place an order becomes real: re-price, persist, then the route
 * creates a Stripe Checkout Session for this logged-in user.
 */
export type SubmitOrderAuth = {
  userId: string
  stripeCustomerId: string
}

export async function submitOrder(
  input: OrderInput,
  context: OrderContext,
  auth: SubmitOrderAuth,
): Promise<AcceptedOrder> {
  const plan = findPlan(input.planId)
  if (!plan) throw new Error(`Unknown plan ${input.planId}`)

  const product = eur(plan.priceEurCents)
  const delivery: DeliveryDto = {
    type: input.delivery.type,
    cityId: context.city?.id ?? context.rawCityId,
    officeCode: context.office?.code ?? context.rawOfficeCode ?? undefined,
    street: input.delivery.street,
    streetNum: input.delivery.streetNum,
    quarter: input.delivery.quarter,
    floor: input.delivery.floor,
    apt: input.delivery.apt,
    note: input.delivery.note,
    streetIsFreeform: input.delivery.streetIsFreeform,
  }

  // Recompute rather than trust the browser's total.
  //
  // A failure here leaves shipping null, and the route refuses to open Checkout
  // on that. This used to charge the product price alone and silently absorb the
  // courier cost on every order — which is the one way to lose more than the
  // sale. The order is still recorded (as needs_quote) so the shop can call with
  // a price, so the sale is deferred rather than turned away.
  let shipping: Money | null = null
  let quoteId: string | null = null
  if (context.city) {
    try {
      const quote = await calculateShipping({
        plan,
        city: context.city,
        office: context.office,
        delivery,
        receiver: { name: input.name, phone: input.phone },
      })
      shipping = toEur(quote.shipping)
      quoteId = quote.quoteId
    } catch (error) {
      logFailure(error)
    }
  }

  const total = shipping ? addMoney(product, shipping) : product
  const orderRef = makeOrderRef()

  await persistOrder({ orderRef, input, context, product, shipping, total, quoteId, auth })
  await notifyOrder({ orderRef, input, total })

  return { orderRef, plan, product, shipping, total, quoteId }
}

async function persistOrder(record: {
  orderRef: string
  input: OrderInput
  context: OrderContext
  product: Money
  shipping: Money | null
  total: Money
  quoteId: string | null
  auth: SubmitOrderAuth
}): Promise<void> {
  const { orderRef, input, context, auth } = record
  const { error } = await getSupabaseAdmin().from('application_orders').insert({
    order_ref: orderRef,
    user_id: auth.userId,
    stripe_customer_id: auth.stripeCustomerId,
    plan_id: input.planId,
    customer_name: input.name,
    email: input.email,
    phone: input.phone,
    delivery: {
      type: input.delivery.type,
      cityId: context.city?.id ?? context.rawCityId,
      cityName: context.city?.name ?? null,
      postCode: context.city?.postCode ?? null,
      officeCode: context.office?.code ?? context.rawOfficeCode ?? null,
      street: blank(input.delivery.street),
      streetNum: blank(input.delivery.streetNum),
      quarter: blank(input.delivery.quarter),
      floor: blank(input.delivery.floor),
      apt: blank(input.delivery.apt),
      note: blank(input.delivery.note),
      unverified: context.city === null,
      quoteId: record.quoteId,
    },
    customization: {
      printName: input.printName,
      customization: input.customization,
      message: input.message,
    },
    product_amount: record.product.cents,
    shipping_amount: record.shipping?.cents ?? null,
    total_amount: record.total.cents,
    currency: 'eur',
    // An unpriced shipment never reaches Stripe (see app/api/order/route.ts), so
    // it must not sit in the queue looking like an order awaiting payment. The
    // lead is still worth keeping — someone has to ring them back with a price.
    status: record.shipping ? 'pending_payment' : 'needs_quote',
  })
  if (error) throw new Error(`Could not persist order: ${error.message}`)
}

/** Email and Econt label run from the Stripe webhook after payment, not here. */
async function notifyOrder(_record: {
  orderRef: string
  input: OrderInput
  total: Money
}): Promise<void> {
  // Intentionally empty. The phone call is the current notification channel.
}

/**
 * A short, human-quotable reference: WC-<base36 time><random>.
 *
 * Time-prefixed so references sort chronologically, and short enough to read
 * back over the phone without asking anyone to spell a UUID.
 */
/** Empty strings are noise in a log; null says "not provided". */
function blank(v: string | undefined): string | null {
  const t = (v ?? '').trim()
  return t.length > 0 ? t : null
}

function makeOrderRef(): string {
  const time = Date.now().toString(36).toUpperCase()
  const rand = Math.floor(Math.random() * 36 ** 3)
    .toString(36)
    .toUpperCase()
    .padStart(3, '0')
  return `WC-${time}${rand}`
}
