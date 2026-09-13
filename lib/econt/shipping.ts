import 'server-only'

import { isParcelConfigured, type Plan } from '@/lib/data/pricing'
import { bgn, eur, toBgn, type Money } from '@/lib/money'
import { econtPost } from './client'
import { assertSenderConfigured, getEcontConfig, type EcontSender } from './config'
import { canFitInAps } from './constraints'
import { TTL, memoTtl } from './cache'
import { EcontError } from './errors'
import type { CityDto, DeliveryDto, OfficeDto } from './dto'
import type {
  CreateLabelRequest,
  CreateLabelResponse,
  EcontAddress,
  EcontCityRef,
  EcontLabel,
} from './types'

export type ShippingQuote = {
  /** What the courier costs, in BGN as Econt priced it. */
  shipping: Money
  /** Stable key for this exact selection — see quoteKeyFor(). */
  quoteId: string
}

export type QuoteInput = {
  plan: Plan
  city: CityDto
  office: OfficeDto | null
  delivery: DeliveryDto
  /** Receiver name and phone. Econt requires them even to price a shipment. */
  receiver: { name: string; phone: string }
}

/**
 * Price a shipment without creating it (`mode: 'calculate'`).
 *
 * Everything about the product — weight, dimensions, pack count, declared value
 * — is read from the plan here on the server. The browser only ever names a
 * plan id. See dto.ts QuoteRequest for why.
 */
export async function calculateShipping(input: QuoteInput): Promise<ShippingQuote> {
  const parcel = input.plan.parcel

  if (!isParcelConfigured(parcel)) {
    // Sending weight: 0 would quote a price far below the real one and we would
    // silently absorb the difference on every order. Fail loudly instead.
    throw new EcontError(
      'config',
      `Parcel dimensions for plan "${input.plan.id}" are not configured (see PACKED_PARCEL in lib/data/pricing.ts)`,
      { detail: { parcel } },
    )
  }

  if (input.delivery.type === 'aps' && !canFitInAps(parcel)) {
    throw new EcontError(
      'validation',
      'Пратката е твърде голяма за автомат на Еконт. Изберете офис или доставка до адрес.',
      { field: 'deliveryType' },
    )
  }

  const config = getEcontConfig()
  // A shipment needs a sender; nomenclature lookups do not, which is why this
  // check lives here rather than in getEcontConfig().
  assertSenderConfigured(config)

  const label = buildLabel(input, config.sender)
  const quoteId = quoteKeyFor(input)

  const response = await memoTtl(`quote:${quoteId}`, TTL.quote, () =>
    econtPost<CreateLabelRequest, CreateLabelResponse>(
      'Shipments/LabelService.createLabel.json',
      { label, mode: 'calculate' },
    ),
  )

  return { shipping: resolvePrice(response), quoteId }
}

export type CreatedShipment = {
  shipmentNumber: string
  pdfUrl: string | null
}

/**
 * Create a real Econt label. Call only after Stripe has marked the order paid.
 * Never from the public order route — that would ship unpaid carts.
 */
export async function createShipment(input: QuoteInput): Promise<CreatedShipment> {
  const parcel = input.plan.parcel

  if (!isParcelConfigured(parcel)) {
    throw new EcontError(
      'config',
      `Parcel dimensions for plan "${input.plan.id}" are not configured (see PACKED_PARCEL in lib/data/pricing.ts)`,
      { detail: { parcel } },
    )
  }

  if (input.delivery.type === 'aps' && !canFitInAps(parcel)) {
    throw new EcontError(
      'validation',
      'Пратката е твърде голяма за автомат на Еконт.',
      { field: 'deliveryType' },
    )
  }

  const config = getEcontConfig()
  assertSenderConfigured(config)

  const label = buildLabel(input, config.sender)
  const response = await econtPost<CreateLabelRequest, CreateLabelResponse>(
    'Shipments/LabelService.createLabel.json',
    { label, mode: 'create' },
  )

  const shipmentNumber = response.label?.shipmentNumber?.trim()
  if (!shipmentNumber) {
    throw new EcontError('upstream', 'Econt created no shipment number', {
      detail: response.label,
    })
  }

  return {
    shipmentNumber,
    pdfUrl: response.label?.pdfURL?.trim() || null,
  }
}

/**
 * Pull the number to charge out of Econt's response.
 *
 * Econt returns several amounts and their meanings depend on who pays. We add
 * delivery to the order total, so we want the courier service price — but the
 * field names overlap in the docs, so this prefers them in a documented order
 * and must be confirmed against the real API on a preview deploy before launch.
 * `receiverDueAmount` is deliberately NOT used: it includes cash-on-delivery.
 */
function resolvePrice(response: CreateLabelResponse): Money {
  const label = response.label
  const candidates = [label?.courierServicePrice, label?.totalPrice]
  const amount = candidates.find((v) => typeof v === 'number' && v >= 0)

  if (typeof amount !== 'number') {
    throw new EcontError('upstream', 'Econt returned no usable price', {
      detail: label,
    })
  }

  const currency = (label?.currency ?? 'BGN').toUpperCase()
  if (currency === 'EUR') return eur(Math.round(amount * 100))
  if (currency === 'BGN') return bgn(Math.round(amount * 100))

  throw new EcontError('upstream', `Econt priced in unexpected currency ${currency}`, {
    detail: label,
  })
}

function buildLabel(input: QuoteInput, sender: EcontSender): EcontLabel {
  const { plan, delivery, receiver } = input

  const label: EcontLabel = {
    senderClient: { name: sender.name, phones: [sender.phone].filter(Boolean) },
    receiverClient: { name: receiver.name, phones: [receiver.phone] },
    packCount: 1,
    shipmentType: 'PACK',
    weight: plan.parcel.weightKg,
    shipmentDescription: `${plan.name} (${plan.sku})`,
    services: {
      // Declared value insures the parcel for what the goods are worth. Not a
      // cash-on-delivery amount — that arrives with payment, in a later phase.
      declaredValueAmount: round2(toBgn(eur(plan.priceEurCents)).cents / 100),
      declaredValueCurrency: 'BGN',
      smsNotification: true,
    },
  }

  if (sender.officeCode) label.senderOfficeCode = sender.officeCode
  else {
    label.senderAddress = {
      city: cityStub(sender.cityName, sender.cityPostCode),
      street: sender.street,
      num: sender.streetNum,
      other: sender.streetOther,
    }
  }

  if (delivery.type === 'address') {
    label.receiverAddress = buildReceiverAddress(input)
  } else {
    label.receiverOfficeCode = delivery.officeCode
  }

  return label
}

function buildReceiverAddress(input: QuoteInput): EcontAddress {
  const { city, delivery } = input
  const extras = [
    delivery.floor ? `ет. ${delivery.floor}` : '',
    delivery.apt ? `ап. ${delivery.apt}` : '',
    delivery.note ?? '',
  ]
    .filter((s) => s.trim().length > 0)
    .join(', ')

  const address: EcontAddress = {
    city: cityStub(city.name, city.postCode),
    num: delivery.streetNum,
    quarter: delivery.quarter,
  }

  // A street Econt's nomenclature does not know must go in `other`, or the
  // whole address is rejected. New builds and villages hit this constantly.
  if (delivery.streetIsFreeform) {
    address.other = [delivery.street, delivery.streetNum, extras]
      .filter((s) => s && s.trim().length > 0)
      .join(' ')
  } else {
    address.street = delivery.street
    if (extras) address.other = extras
  }

  return address
}

/**
 * Econt resolves a city by id, or by name + post code. We only have the latter
 * for our own sender config, so use it at both ends for consistency — and send
 * no id at all rather than a placeholder, which Econt would try to look up.
 */
function cityStub(name: string, postCode: string): EcontCityRef {
  return { name, postCode, country: BULGARIA }
}

const BULGARIA = {
  id: 1033,
  code2: 'BG',
  code3: 'BGR',
  name: 'България',
  nameEn: 'Bulgaria',
} as const

/**
 * Identifies a quote by everything that could change its price.
 *
 * Used both as the memo key and as the `quoteId` handed to the browser, so the
 * order route can tell whether the price it recomputes belongs to the quote the
 * customer was shown. Deliberately excludes the receiver's name and phone —
 * they do not affect price, and keeping them out means the key is not personal
 * data and can be logged freely.
 */
export function quoteKeyFor(input: QuoteInput): string {
  const { plan, city, delivery } = input
  return [
    plan.id,
    plan.parcel.weightKg,
    city.id,
    delivery.type,
    delivery.officeCode ?? '',
    delivery.street ?? '',
    delivery.streetNum ?? '',
    delivery.quarter ?? '',
    delivery.streetIsFreeform ? 'free' : '',
  ].join('|')
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
