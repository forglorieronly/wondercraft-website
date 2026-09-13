import 'server-only'

import { findPlan } from '@/lib/data/pricing'
import { sendEmail } from '@/lib/email'
import { isDeliveryType, type DeliveryDto } from '@/lib/econt/dto'
import { logFailure } from '@/lib/econt/route-helpers'
import { createShipment } from '@/lib/econt/shipping'
import { findCity, findOffice } from '@/lib/econt/nomenclatures'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { eur, formatMoney } from '@/lib/money'

type OrderRow = {
  id: string
  order_ref: string
  plan_id: string
  customer_name: string
  email: string
  phone: string
  delivery: Record<string, unknown>
  customization: Record<string, unknown> | null
  total_amount: number
  currency: string
  email_sent_at: string | null
  shop_email_sent_at: string | null
  econt_shipment_number: string | null
}

/**
 * Emails and Econt label after Stripe has marked the order paid.
 * Each step is idempotent; a failure here must not un-pay the order.
 */
export async function fulfillPaidOrder(order: OrderRow): Promise<void> {
  const db = getSupabaseAdmin()
  const plan = findPlan(order.plan_id)
  const totalLabel = formatMoney(eur(order.total_amount))
  const deliverySummary = describeDelivery(order.delivery)

  if (!order.email_sent_at) {
    const sent = await sendEmail({
      to: order.email,
      subject: `Поръчка ${order.order_ref} — плащането е получено`,
      text: [
        `Здравейте, ${order.customer_name},`,
        '',
        'Плащането ви е получено успешно.',
        `Номер на поръчката: ${order.order_ref}`,
        `Модел: ${plan?.name ?? order.plan_id}`,
        `Сума: ${totalLabel}`,
        `Доставка: ${deliverySummary}`,
        '',
        'Ще се свържем с вас, ако имаме уточнения по доставката.',
        '',
        'Wondercraft',
      ].join('\n'),
    })
    if (sent) {
      await db.from('application_orders').update({ email_sent_at: new Date().toISOString() }).eq('id', order.id)
    }
  }

  const shopTo = process.env.SHOP_NOTIFY_EMAIL?.trim()
  if (shopTo && !order.shop_email_sent_at) {
    const sent = await sendEmail({
      to: shopTo,
      subject: `Нова платена поръчка ${order.order_ref}`,
      text: [
        `Поръчка: ${order.order_ref}`,
        `Клиент: ${order.customer_name}`,
        `Имейл: ${order.email}`,
        `Телефон: ${order.phone}`,
        `Модел: ${plan?.name ?? order.plan_id}`,
        `Сума: ${totalLabel}`,
        `Доставка: ${deliverySummary}`,
        `Персонализация: ${JSON.stringify(order.customization ?? {})}`,
      ].join('\n'),
    })
    if (sent) {
      await db
        .from('application_orders')
        .update({ shop_email_sent_at: new Date().toISOString() })
        .eq('id', order.id)
    }
  }

  if (order.econt_shipment_number) return

  try {
    const input = await quoteInputFromOrder(order)
    if (!input) {
      await db
        .from('application_orders')
        .update({ econt_label_error: 'Destination was unverified at submit; create the label by hand.' })
        .eq('id', order.id)
      return
    }

    const created = await createShipment(input)
    await db
      .from('application_orders')
      .update({
        econt_shipment_number: created.shipmentNumber,
        econt_label_url: created.pdfUrl,
        econt_label_error: null,
      })
      .eq('id', order.id)
      .is('econt_shipment_number', null)
  } catch (error) {
    logFailure(error)
    await db
      .from('application_orders')
      .update({
        econt_label_error: error instanceof Error ? error.message : String(error),
      })
      .eq('id', order.id)
  }
}

function describeDelivery(delivery: Record<string, unknown>): string {
  const type = delivery.type
  const city = String(delivery.cityName ?? delivery.cityId ?? '')
  if (type === 'address') {
    return `Адрес, ${city}, ${delivery.street ?? ''} ${delivery.streetNum ?? ''}`.trim()
  }
  if (type === 'aps') return `Автомат ${delivery.officeCode ?? ''}, ${city}`.trim()
  return `Офис ${delivery.officeCode ?? ''}, ${city}`.trim()
}

async function quoteInputFromOrder(order: OrderRow) {
  const plan = findPlan(order.plan_id)
  const delivery = order.delivery
  if (!plan || delivery.unverified) return null
  if (!isDeliveryType(delivery.type)) return null

  const cityId = Number(delivery.cityId)
  if (!cityId) return null

  const city = await findCity(cityId)
  if (!city) return null

  let office = null
  if (delivery.type !== 'address') {
    office = (await findOffice(city.id, String(delivery.officeCode ?? ''))) ?? null
    if (!office) return null
  }

  const dto: DeliveryDto = {
    type: delivery.type,
    cityId: city.id,
    officeCode: office?.code ?? (typeof delivery.officeCode === 'string' ? delivery.officeCode : undefined),
    street: str(delivery.street),
    streetNum: str(delivery.streetNum),
    quarter: str(delivery.quarter),
    floor: str(delivery.floor),
    apt: str(delivery.apt),
    note: str(delivery.note),
    streetIsFreeform: Boolean(delivery.streetIsFreeform),
  }

  return {
    plan,
    city,
    office,
    delivery: dto,
    receiver: { name: order.customer_name, phone: order.phone },
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}
