// Validation shared by the browser and the API routes.
//
// Deliberately hand-rolled rather than zod: the surface is a dozen simple
// fields, the messages have to be Bulgarian anyway, and the client imports this
// module, so a schema library's bytes would land in the bundle for no gain. The
// one thing zod would genuinely earn — parsing untrusted webhook JSON — lives
// in `app/api/stripe/webhook` instead.
//
// No React and no server-only imports here, on purpose: both sides run the same
// code, so a client that skips validation gets the identical messages back.

import { plans, type PlanId } from '@/lib/data/pricing'
import { isDeliveryType, type DeliveryType } from '@/lib/econt/dto'

export type OrderErrorField =
  | 'firstName'
  | 'lastName'
  | 'email'
  | 'phone'
  | 'model'
  | 'deliveryType'
  | 'city'
  | 'officeCode'
  | 'street'
  | 'streetNum'
  | 'printName'
  | 'customization'
  | 'message'
  /** Not attributable to one field — render as a banner. */
  | 'form'

export type OrderErrors = Partial<Record<OrderErrorField, string>>

export const LIMITS = {
  firstName: 50,
  lastName: 50,
  /** The RFC 5321 maximum for a whole address. */
  email: 254,
  printName: 30,
  street: 120,
  streetNum: 10,
  floor: 5,
  apt: 10,
  note: 200,
  customization: 500,
  message: 1000,
} as const

/** Contact details, as typed into the form. */
export type ContactDraft = {
  firstName: string
  lastName: string
  email: string
  phone: string
  planId: string
  printName?: string
  customization?: string
  message?: string
}

/** Where it is going, as chosen in the form. */
export type DeliveryDraft = {
  type: DeliveryType
  cityId: number | null
  officeCode: string | null
  street?: string
  streetNum?: string
  quarter?: string
  floor?: string
  apt?: string
  note?: string
  streetIsFreeform?: boolean
}

export type OrderDraft = ContactDraft & { delivery: DeliveryDraft }

/**
 * Normalize a Bulgarian mobile number to E.164, or return null.
 *
 * Mobile specifically: Econt's SMS notification is the main way a customer
 * learns their parcel has arrived, and a landline silently loses that.
 * Accepts 0881234567, +359881234567, 00359 88 123 4567 and spaced or
 * dash-separated variants.
 */
export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/[\s()\-.]/g, '')
  const national = /^(?:\+359|00359|359|0)(8[7-9]\d{7})$/.exec(digits)
  return national ? `+359${national[1]}` : null
}

/**
 * Does this look like one part of a person's name?
 *
 * Unicode-aware rather than [A-Za-z]: the shop sells in Bulgaria, so Cyrillic is
 * the common case and a Latin-only rule would reject most real customers.
 * Allows the punctuation names actually contain — "Ана-Мария", "О'Брайън",
 * "Ван дер Берг" — while rejecting digits, symbols and a lone initial.
 */
const NAME_PART = /^\p{L}[\p{L}\p{M}]*(?:[ \-'’]\p{L}[\p{L}\p{M}]*)*$/u

export function isNamePart(raw: string): boolean {
  const value = raw.trim()
  return value.length >= 2 && NAME_PART.test(value)
}

/**
 * Normalize an email address, or return null.
 *
 * A format check, not a proof of delivery — only sending to the address proves
 * that, and this runs while someone is typing. So it catches what customers
 * actually get wrong (missing @, a domain with no dot, a stray space) and does
 * not attempt RFC 5322, whose permitted grammar rejects nothing a customer would
 * plausibly mean.
 *
 * Lowercased on the way out: no mail provider treats mailboxes as
 * case-sensitive, and one canonical form is what a confirmation email wants.
 */
const EMAIL = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/

export function normalizeEmail(raw: string): string | null {
  const email = raw.trim()
  if (email.length > LIMITS.email) return null
  return EMAIL.test(email) ? email.toLowerCase() : null
}

export function validateContact(draft: ContactDraft): OrderErrors {
  const errors: OrderErrors = {}

  const firstName = draft.firstName.trim()
  if (!firstName) errors.firstName = 'Моля, въведете име.'
  else if (firstName.length > LIMITS.firstName)
    errors.firstName = `Името е до ${LIMITS.firstName} символа.`
  else if (!isNamePart(firstName)) errors.firstName = 'Моля, въведете валидно име.'

  const lastName = draft.lastName.trim()
  if (!lastName) errors.lastName = 'Моля, въведете фамилия.'
  else if (lastName.length > LIMITS.lastName)
    errors.lastName = `Фамилията е до ${LIMITS.lastName} символа.`
  else if (!isNamePart(lastName)) errors.lastName = 'Моля, въведете валидна фамилия.'

  const email = draft.email.trim()
  if (!email) errors.email = 'Моля, въведете имейл.'
  else if (!normalizeEmail(email))
    errors.email = 'Моля, въведете валиден имейл, напр. ivan@example.com.'

  const phone = draft.phone.trim()
  if (!phone) errors.phone = 'Моля, въведете телефон.'
  else if (!normalizePhone(phone))
    errors.phone =
      'Моля, въведете валиден български мобилен номер, напр. 0881234567.'

  if (!isPlanId(draft.planId)) errors.model = 'Моля, изберете модел.'

  const printName = (draft.printName ?? '').trim()
  if (printName.length > LIMITS.printName)
    errors.printName = `Името за печат е до ${LIMITS.printName} символа.`
  else if (/[\r\n]/.test(printName))
    errors.printName = 'Името за печат трябва да е на един ред.'

  if ((draft.customization ?? '').length > LIMITS.customization)
    errors.customization = `Текстът е до ${LIMITS.customization} символа.`

  if ((draft.message ?? '').length > LIMITS.message)
    errors.message = `Съобщението е до ${LIMITS.message} символа.`

  return errors
}

export function validateDelivery(delivery: DeliveryDraft): OrderErrors {
  const errors: OrderErrors = {}

  if (!isDeliveryType(delivery.type)) {
    errors.deliveryType = 'Моля, изберете начин на доставка.'
    return errors
  }

  // A typed city is not a chosen city: Econt needs the id, and a name alone is
  // ambiguous (three different Калояново, in three different regions).
  if (!delivery.cityId) {
    errors.city = 'Моля, изберете град от списъка.'
    return errors
  }

  if (delivery.type === 'office' || delivery.type === 'aps') {
    if (!delivery.officeCode) {
      errors.officeCode =
        delivery.type === 'aps'
          ? 'Моля, изберете автомат на Еконт.'
          : 'Моля, изберете офис на Еконт.'
    }
    return errors
  }

  const street = (delivery.street ?? '').trim()
  if (!street) errors.street = 'Моля, въведете улица.'
  else if (street.length > LIMITS.street)
    errors.street = `Улицата е до ${LIMITS.street} символа.`

  const num = (delivery.streetNum ?? '').trim()
  if (!num) errors.streetNum = 'Моля, въведете номер.'
  else if (num.length > LIMITS.streetNum)
    errors.streetNum = `Номерът е до ${LIMITS.streetNum} символа.`

  return errors
}

/** Everything the server needs, normalized and safe to act on. */
export type OrderInput = {
  firstName: string
  lastName: string
  /** The two parts joined — Econt and the logs both want one full name. */
  name: string
  email: string
  phone: string
  planId: PlanId
  printName: string | null
  customization: string | null
  message: string | null
  delivery: DeliveryDraft & { cityId: number }
}

export function validateOrder(
  draft: OrderDraft,
): { errors: OrderErrors; value?: OrderInput } {
  const errors: OrderErrors = {
    ...validateContact(draft),
    ...validateDelivery(draft.delivery),
  }

  if (Object.keys(errors).length > 0) return { errors }

  const phone = normalizePhone(draft.phone)
  const email = normalizeEmail(draft.email)
  const cityId = draft.delivery.cityId
  const firstName = draft.firstName.trim()
  const lastName = draft.lastName.trim()
  // validateContact/validateDelivery already guarantee all of these, but
  // narrowing here keeps OrderInput honest rather than asserting non-null.
  if (!phone || !email || !cityId || !isPlanId(draft.planId)) {
    return { errors: { form: 'Моля, проверете данните във формата.' } }
  }

  return {
    errors: {},
    value: {
      firstName,
      lastName,
      name: `${firstName} ${lastName}`,
      email,
      phone,
      planId: draft.planId,
      printName: blankToNull(draft.printName),
      customization: blankToNull(draft.customization),
      message: blankToNull(draft.message),
      delivery: { ...draft.delivery, cityId },
    },
  }
}

export function hasErrors(errors: OrderErrors): boolean {
  return Object.keys(errors).length > 0
}

export function isPlanId(value: string): value is PlanId {
  return plans.some((p) => p.id === value)
}

function blankToNull(v: string | undefined): string | null {
  const t = (v ?? '').trim()
  return t.length > 0 ? t : null
}
