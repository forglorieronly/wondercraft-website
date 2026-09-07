import { NextResponse } from 'next/server'
import { getAppUrl, getStripe, logStripeError, toStripeAmount } from '@/lib/stripe'
import { getOrCreateStripeCustomer } from '@/lib/stripe-customer'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { createClient, isSupabaseConfigured } from '@/lib/supabase/server'
import type { MoneyDto, OrderResponse } from '@/lib/econt/dto'
import { isDeliveryType } from '@/lib/econt/dto'
import { findCity, findOffice } from '@/lib/econt/nomenclatures'
import { logFailure, rateLimitGuard } from '@/lib/econt/route-helpers'
import type { Money } from '@/lib/money'
import { hasErrors, validateOrder, type OrderDraft } from '@/lib/order/schema'
import { submitOrder, type OrderContext } from '@/lib/order/submit-order'
import type { CityDto, OfficeDto } from '@/lib/econt/dto'

export const runtime = 'nodejs'

const MAX_BODY_BYTES = 8 * 1024

/**
 * Place an order for the signed-in user: persist it, create a Stripe Customer
 * if needed, then redirect to hosted Checkout (card, EUR).
 */
export async function POST(request: Request) {
  const limited = rateLimitGuard(request, 'order')
  if (limited) return limited

  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) {
    return NextResponse.json(
      { ok: false, message: 'Заявката е прекалено голяма.' },
      { status: 413 },
    )
  }

  if (!isSupabaseConfigured()) {
    return NextResponse.json(
      { ok: false, message: 'Моля, влезте в профила си, за да поръчате.' },
      { status: 401 },
    )
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user?.email) {
    return NextResponse.json(
      { ok: false, message: 'Моля, влезте в профила си, за да поръчате.' },
      { status: 401 },
    )
  }

  let draft: OrderDraft
  try {
    draft = (await request.json()) as OrderDraft
  } catch {
    return NextResponse.json({ ok: false, message: 'Невалидна заявка.' }, { status: 400 })
  }

  if (!draft?.delivery || !isDeliveryType(draft.delivery.type)) {
    return NextResponse.json({ ok: false, message: 'Невалидна заявка.' }, { status: 400 })
  }

  const accountEmail = user.email.toLowerCase()
  const { errors, value } = validateOrder({
    firstName: String(draft.firstName ?? ''),
    lastName: String(draft.lastName ?? ''),
    email: accountEmail,
    phone: String(draft.phone ?? ''),
    planId: String(draft.planId ?? ''),
    printName: draft.printName,
    customization: draft.customization,
    message: draft.message,
    delivery: {
      type: draft.delivery.type,
      cityId: Number(draft.delivery.cityId) || null,
      officeCode: draft.delivery.officeCode ?? null,
      street: draft.delivery.street,
      streetNum: draft.delivery.streetNum,
      quarter: draft.delivery.quarter,
      floor: draft.delivery.floor,
      apt: draft.delivery.apt,
      note: draft.delivery.note,
      streetIsFreeform: draft.delivery.streetIsFreeform,
    },
  })

  if (hasErrors(errors) || !value) {
    return json({
      ok: false,
      message: 'Моля, проверете данните във формата.',
      errors: errors as Record<string, string>,
    })
  }

  try {
    let city: CityDto | null = null
    let office: OfficeDto | null = null

    try {
      city = (await findCity(value.delivery.cityId)) ?? null
      if (!city) {
        return json({
          ok: false,
          message: 'Не разпознахме този град. Изберете го отново от списъка.',
          field: 'city',
        })
      }

      if (value.delivery.type !== 'address') {
        office =
          (await findOffice(city.id, String(value.delivery.officeCode))) ?? null
        if (!office) {
          return json({
            ok: false,
            message:
              value.delivery.type === 'aps'
                ? 'Този автомат вече не е активен. Изберете друг.'
                : 'Този офис вече не е активен. Изберете друг.',
            field: 'officeCode',
          })
        }
      }
    } catch (error) {
      logFailure(error)
      city = null
      office = null
    }

    const stripeCustomerId = await getOrCreateStripeCustomer({
      userId: user.id,
      email: accountEmail,
    })

    const context: OrderContext = {
      city,
      office,
      rawCityId: value.delivery.cityId,
      rawOfficeCode: value.delivery.officeCode ?? null,
    }

    const accepted = await submitOrder(value, context, {
      userId: user.id,
      stripeCustomerId,
    })
    const stripe = getStripe()
    const appUrl = getAppUrl(request)
    const session = await stripe.checkout.sessions.create(
      {
        mode: 'payment',
        customer: stripeCustomerId,
        payment_method_types: ['card'],
        locale: 'bg',
        line_items: [
          {
            price_data: {
              currency: 'eur',
              product_data: { name: accepted.plan.name },
              unit_amount: toStripeAmount(accepted.total.cents),
            },
            quantity: 1,
          },
        ],
        success_url: `${appUrl}/order/success?orderRef=${encodeURIComponent(accepted.orderRef)}&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${appUrl}/order/cancel?orderRef=${encodeURIComponent(accepted.orderRef)}`,
        metadata: {
          orderRef: accepted.orderRef,
          planId: value.planId,
          userId: user.id,
        },
        payment_intent_data: {
          receipt_email: accountEmail,
          metadata: { orderRef: accepted.orderRef, userId: user.id },
        },
      },
      { idempotencyKey: `order_${accepted.orderRef}` },
    )

    if (!session.url) throw new Error('Stripe did not return a checkout URL')

    const { error: linkError } = await getSupabaseAdmin()
      .from('application_orders')
      .update({ stripe_checkout_session_id: session.id })
      .eq('order_ref', accepted.orderRef)
    if (linkError) throw new Error(`Could not link checkout session: ${linkError.message}`)

    return json({
      ok: true,
      orderRef: accepted.orderRef,
      checkoutUrl: session.url,
      total: toDto(accepted.total),
      shipping: accepted.shipping ? toDto(accepted.shipping) : null,
    })
  } catch (error) {
    logStripeError(error)
    logFailure(error)
    return json({
      ok: false,
      message:
        'Нещо се обърка при изпращането. Опитайте отново или ни се обадете.',
    })
  }
}

function toDto(money: Money): MoneyDto {
  return { cents: money.cents, currency: money.currency }
}

function json(payload: OrderResponse): NextResponse {
  return NextResponse.json(payload, {
    status: 200,
    headers: { 'Cache-Control': 'no-store' },
  })
}
