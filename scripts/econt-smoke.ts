import assert from 'node:assert/strict'

// Config is read lazily inside getEcontConfig(), per call — so setting the mode
// here, after the imports are evaluated, is still in time.
process.env.ECONT_MODE = 'fixture'
delete process.env.ECONT_FIXTURE_FAULT

import { invalidate } from '../lib/econt/cache.ts'
import {
  assertSenderConfigured,
  getEcontConfig,
} from '../lib/econt/config.ts'
import { canFitInAps } from '../lib/econt/constraints.ts'
import { isEcontError, toUserMessageBg } from '../lib/econt/errors.ts'
import {
  findOffice,
  getCities,
  getCityDetails,
  getOffices,
} from '../lib/econt/nomenclatures.ts'
import { calculateShipping } from '../lib/econt/shipping.ts'
import { isParcelConfigured, plans } from '../lib/data/pricing.ts'
import { formatMoney } from '../lib/money.ts'

async function main(): Promise<void> {
  const SOFIA = 41
  const ELIN_PELIN = 420 // automat only
  const BABEK = 501 // no Econt presence at all
  const GABROVO = 103 // one office, carrying the live API's real field types

  // --- Cities -----------------------------------------------------------------
  const cities = await getCities()
  assert.ok(cities.length > 0, 'expected fixture cities')

  const sofia = cities.find((c) => c.id === SOFIA)
  assert.ok(sofia, 'Sofia missing')
  assert.equal(sofia.name, 'София')
  assert.equal(sofia.postCode, '1000')
  assert.equal(sofia.hasOffice, true)
  assert.equal(sofia.hasAps, true)

  // Big cities float to the top of the list rather than sorting alphabetically.
  assert.equal(cities[0].name, 'София')
  assert.equal(cities[1].name, 'Пловдив')

  // A city whose only presence is an automat must not offer office pickup.
  const elinPelin = cities.find((c) => c.id === ELIN_PELIN)
  assert.ok(elinPelin)
  assert.equal(elinPelin.hasAps, true)
  assert.equal(elinPelin.hasOffice, false, 'Elin Pelin has no walk-in office')

  // A city with nothing must offer neither.
  const babek = cities.find((c) => c.id === BABEK)
  assert.ok(babek)
  assert.equal(babek.hasOffice, false)
  assert.equal(babek.hasAps, false)

  // Duplicate names must remain distinguishable by region and post code.
  const kaloyanovo = cities.filter((c) => c.name === 'Калояново')
  assert.equal(kaloyanovo.length, 3)
  assert.equal(new Set(kaloyanovo.map((c) => c.postCode)).size, 3)
  assert.ok(kaloyanovo.every((c) => c.region.length > 0))

  // --- Offices ----------------------------------------------------------------
  const sofiaOffices = await getOffices(SOFIA)
  assert.ok(sofiaOffices.length > 0)

  // Mobile post stations are never offered as a pickup point.
  assert.ok(
    sofiaOffices.every((o) => !o.isMps),
    'MPS offices must be filtered out',
  )

  const mladost = sofiaOffices.find((o) => o.code === '1010')
  assert.ok(mladost)
  assert.equal(mladost.name, 'Офис Младост 1')
  assert.equal(mladost.address, 'бул. Александър Малинов 51, кв. Младост 1')
  assert.equal(mladost.hours, '08:30 – 18:30')
  assert.equal(mladost.phone, '0700 1 7000')
  assert.equal(mladost.isAps, false)

  // An office with neither phones nor hours must map to nulls, not to "undefined".
  const lyulin = sofiaOffices.find((o) => o.code === '1012')
  assert.ok(lyulin)
  assert.equal(lyulin.hours, null)
  assert.equal(lyulin.phone, null)

  // A 24/7 automat reads as words, not as 00:00 – 23:59.
  const automat = sofiaOffices.find((o) => o.code === '1013')
  assert.ok(automat)
  assert.equal(automat.isAps, true)
  assert.equal(automat.hours, 'Нон-стоп')

  assert.equal((await getOffices(BABEK)).length, 0, 'Babek must have no offices')

  // Regression: the live nomenclature sends numbers and nulls where types.ts
  // promises strings, and every DTO field is consumed by .trim()/.localeCompare()
  // downstream. This exact shape threw "e.trim is not a function" in production
  // and emptied the office picker for a city that has an office.
  const mistyped = (await getOffices(GABROVO)).find((o) => o.code === '5311')
  assert.ok(mistyped, 'a mistyped office must still be offered, not dropped')
  assert.equal(
    mistyped.address,
    'ул. Априловска 12',
    'a numeric street number must survive, not be dropped',
  )
  assert.equal(mistyped.phone, '66123456', 'a null phone must be skipped, not thrown on')
  assert.equal(mistyped.hours, null, 'half-known hours must degrade to null')

  const gabrovoCity = cities.find((c) => c.id === GABROVO)
  assert.equal(gabrovoCity?.hasOffice, true)

  const found = await findOffice(SOFIA, '1010')
  assert.equal(found?.name, 'Офис Младост 1')
  assert.equal(await findOffice(SOFIA, 'nope'), undefined)

  // --- Streets and quarters ---------------------------------------------------
  const details = await getCityDetails(SOFIA)
  assert.ok(details.streets.length > 0)
  assert.ok(details.quarters.length > 0)
  assert.deepEqual(
    [...details.streets].map((s) => s.name).sort((a, b) => a.localeCompare(b, 'bg')),
    details.streets.map((s) => s.name),
    'streets must come back sorted',
  )
  // Villages genuinely have no street nomenclature — hence the freeform fallback.
  const emptyDetails = await getCityDetails(BABEK)
  assert.equal(emptyDetails.streets.length, 0)
  assert.equal(emptyDetails.quarters.length, 0)

  // --- Pricing ----------------------------------------------------------------
  const plan = plans[0]
  const receiver = { name: 'Иван Петров', phone: '+359881234567' }

  // PACKED_PARCEL is unmeasured until the owner fills it in, so quoting the real
  // plan must fail as a config error rather than send weight: 0 and undercharge.
  // This assertion inverts on its own once the numbers land — see below.
  if (!isParcelConfigured(plan.parcel)) {
    await assert.rejects(
      () =>
        calculateShipping({
          plan,
          city: sofia,
          office: mladost,
          delivery: { type: 'office', cityId: SOFIA, officeCode: '1010' },
          receiver,
        }),
      (err: unknown) => {
        assert.ok(isEcontError(err) && err.kind === 'config')
        assert.match(toUserMessageBg(err), /по телефон/)
        return true
      },
      'an unmeasured parcel must fail as a config error',
    )
    console.log('econt-smoke: PACKED_PARCEL unmeasured — real plan asserted to fail closed')
  } else {
    // The numbers have landed, so the assertion inverts: the real plan must now
    // price for real. This is the coverage that proves the measurements reach
    // Econt, rather than the synthetic parcel below standing in for them.
    const realQuote = await calculateShipping({
      plan,
      city: sofia,
      office: mladost,
      delivery: { type: 'office', cityId: SOFIA, officeCode: '1010' },
      receiver,
    })
    assert.ok(realQuote.shipping.cents > 0, 'the measured plan must carry a price')

    // 90x60x20 is well past a locker, so the automat must be refused before
    // Econt is asked — the same rule the modal greys the option out on.
    assert.equal(canFitInAps(plan.parcel), false, 'the packed box must not fit a locker')
    await assert.rejects(
      () =>
        calculateShipping({
          plan,
          city: sofia,
          office: mladost,
          delivery: { type: 'aps', cityId: SOFIA, officeCode: '1013' },
          receiver,
        }),
      (err: unknown) => {
        assert.ok(isEcontError(err) && err.kind === 'validation')
        return true
      },
      'the measured plan must be refused for an automat',
    )
    console.log(
      `econt-smoke: PACKED_PARCEL measured — office ${formatMoney(realQuote.shipping)}, automat refused`,
    )
  }

  // The pricing paths themselves are exercised against a deliberately synthetic
  // parcel, so this coverage does not wait on the owner's measurements and does
  // not silently change meaning when they arrive.
  const measured = {
    ...plan,
    parcel: { weightKg: 3, lengthCm: 55, widthCm: 35, heightCm: 12 },
  }
  const oversized = {
    ...plan,
    parcel: { weightKg: 4, lengthCm: 120, widthCm: 80, heightCm: 10 },
  }

  const officeQuote = await calculateShipping({
    plan: measured,
    city: sofia,
    office: mladost,
    delivery: { type: 'office', cityId: SOFIA, officeCode: '1010' },
    receiver,
  })
  assert.ok(officeQuote.shipping.cents > 0)
  assert.equal(officeQuote.shipping.currency, 'BGN')
  assert.ok(officeQuote.quoteId.includes(plan.id))

  const apsQuote = await calculateShipping({
    plan: measured,
    city: sofia,
    office: automat,
    delivery: { type: 'aps', cityId: SOFIA, officeCode: '1013' },
    receiver,
  })
  assert.ok(
    apsQuote.shipping.cents < officeQuote.shipping.cents,
    'an automat must not cost more than a staffed office',
  )

  const addressQuote = await calculateShipping({
    plan: measured,
    city: sofia,
    office: null,
    delivery: {
      type: 'address',
      cityId: SOFIA,
      street: 'ул. Раковски',
      streetNum: '96',
    },
    receiver,
  })
  assert.ok(
    addressQuote.shipping.cents > officeQuote.shipping.cents,
    'door delivery must cost more than office pickup',
  )

  // The same selection must produce the same quote id, and be served from the memo.
  const again = await calculateShipping({
    plan: measured,
    city: sofia,
    office: mladost,
    delivery: { type: 'office', cityId: SOFIA, officeCode: '1010' },
    receiver,
  })
  assert.equal(again.quoteId, officeQuote.quoteId)
  assert.equal(again.shipping.cents, officeQuote.shipping.cents)

  // Changing anything price-relevant must produce a different quote id.
  assert.notEqual(officeQuote.quoteId, apsQuote.quoteId)
  assert.notEqual(officeQuote.quoteId, addressQuote.quoteId)

  console.log(
    `econt-smoke: automat ${formatMoney(apsQuote.shipping)}, office ${formatMoney(officeQuote.shipping)}, door ${formatMoney(addressQuote.shipping)}`,
  )

  // A parcel too big for a locker must be refused before Econt is even asked.
  await assert.rejects(
    () =>
      calculateShipping({
        plan: oversized,
        city: sofia,
        office: automat,
        delivery: { type: 'aps', cityId: SOFIA, officeCode: '1013' },
        receiver,
      }),
    (err: unknown) => {
      assert.ok(isEcontError(err) && err.kind === 'validation')
      assert.match(toUserMessageBg(err), /автомат/)
      return true
    },
    'an oversized parcel must be refused for an automat',
  )

  // ...but the same parcel is fine to an office or an address.
  assert.ok(
    (
      await calculateShipping({
        plan: oversized,
        city: sofia,
        office: mladost,
        delivery: { type: 'office', cityId: SOFIA, officeCode: '1010' },
        receiver,
      })
    ).shipping.cents > 0,
  )

  // --- APS fit ----------------------------------------------------------------
  const limit = { weightKg: 20, lengthCm: 60, widthCm: 40, heightCm: 40 }
  assert.equal(canFitInAps({ weightKg: 2, lengthCm: 50, widthCm: 30, heightCm: 20 }, limit), true)
  // A box can be rotated: 60×10×40 fits a 60×40×40 locker.
  assert.equal(canFitInAps({ weightKg: 2, lengthCm: 60, widthCm: 10, heightCm: 40 }, limit), true)
  assert.equal(canFitInAps({ weightKg: 2, lengthCm: 120, widthCm: 80, heightCm: 10 }, limit), false)
  assert.equal(canFitInAps({ weightKg: 25, lengthCm: 10, widthCm: 10, heightCm: 10 }, limit), false)

  // --- Every forced fault maps to a Bulgarian message -------------------------
  // getCities() fans out to two upstream calls, so a fault rejects both while
  // Promise.all only surfaces one. memoTtl marks the stored promise as handled
  // so the other does not become an unhandled rejection; if that regresses,
  // this loop crashes the process rather than failing an assertion.
  const expected: Record<string, { kind: string; match: RegExp }> = {
    timeout: { kind: 'timeout', match: /Еконт/ },
    auth: { kind: 'auth', match: /Еконт/ },
    upstream: { kind: 'upstream', match: /Еконт/ },
    validation: { kind: 'validation', match: /адрес/ },
  }

  for (const [fault, want] of Object.entries(expected)) {
    process.env.ECONT_FIXTURE_FAULT = fault
    invalidate()
    await assert.rejects(
      () => getCities(),
      (err: unknown) => {
        assert.ok(isEcontError(err), `${fault}: expected an EcontError`)
        assert.equal(err.kind, want.kind, `${fault}: wrong kind`)
        assert.match(toUserMessageBg(err), want.match, `${fault}: wrong message`)
        return true
      },
      `fault "${fault}" must reject`,
    )
  }

  // An auth failure must never tell the customer it was an auth failure.
  process.env.ECONT_FIXTURE_FAULT = 'auth'
  invalidate()
  const authMessage = await getCities().catch((e) => toUserMessageBg(e))
  assert.doesNotMatch(String(authMessage), /credential|парол|auth/i)

  // 'empty' is a successful response with nothing in it, not an error.
  process.env.ECONT_FIXTURE_FAULT = 'empty'
  invalidate()
  assert.deepEqual(await getCities(), [])
  assert.deepEqual(await getOffices(SOFIA), [])

  // --- A failed load must not be cached ---------------------------------------
  process.env.ECONT_FIXTURE_FAULT = 'timeout'
  invalidate()
  await assert.rejects(() => getCities())
  delete process.env.ECONT_FIXTURE_FAULT
  assert.ok(
    (await getCities()).length > 0,
    'a rejection must not poison the cache for the next request',
  )

  // --- Sender config must not gate nomenclatures -----------------------------
  // Regression guard for a circular-configuration bug: sender validation used to
  // run on every call, so getOffices() refused to work until the sender's own
  // office code was set — which is the thing you need getOffices() to find.
  process.env.ECONT_MODE = 'live'
  process.env.ECONT_BASE_URL = 'https://ee.econt.com/services'
  process.env.ECONT_USERNAME = 'u'
  process.env.ECONT_PASSWORD = 'p'
  for (const key of [
    'ECONT_SENDER_PHONE',
    'ECONT_SENDER_CITY_NAME',
    'ECONT_SENDER_CITY_POST_CODE',
    'ECONT_SENDER_OFFICE_CODE',
    'ECONT_SENDER_STREET',
  ]) {
    delete process.env[key]
  }

  // Credentials alone are enough to read the nomenclature...
  assert.doesNotThrow(() => getEcontConfig())

  // ...but a shipment still refuses to be priced without a sender, and says
  // which variables are missing.
  assert.throws(
    () => assertSenderConfigured(getEcontConfig()),
    (err: unknown) => {
      assert.ok(isEcontError(err) && err.kind === 'config')
      const missing = (err.detail as { missing: string[] }).missing
      assert.deepEqual(missing, [
        'ECONT_SENDER_PHONE',
        'ECONT_SENDER_CITY_NAME',
        'ECONT_SENDER_CITY_POST_CODE',
        'ECONT_SENDER_OFFICE_CODE or ECONT_SENDER_STREET',
      ])
      return true
    },
  )

  // Either dispatch method satisfies it, and neither is required by the other.
  process.env.ECONT_SENDER_PHONE = '+359885147348'
  process.env.ECONT_SENDER_CITY_NAME = 'Благоевград'
  process.env.ECONT_SENDER_CITY_POST_CODE = '2700'
  process.env.ECONT_SENDER_OFFICE_CODE = '2710'
  assert.doesNotThrow(() => assertSenderConfigured(getEcontConfig()))

  delete process.env.ECONT_SENDER_OFFICE_CODE
  process.env.ECONT_SENDER_STREET = 'ул. Тодор Александров'
  assert.doesNotThrow(() => assertSenderConfigured(getEcontConfig()))

  // Missing credentials are still caught on every call, not just shipments.
  delete process.env.ECONT_PASSWORD
  assert.throws(
    () => getEcontConfig(),
    (err: unknown) => {
      assert.ok(isEcontError(err) && err.kind === 'config')
      assert.deepEqual((err.detail as { missing: string[] }).missing, [
        'ECONT_PASSWORD',
      ])
      return true
    },
  )

  // Live mode must never silently fall back to the demo base URL. Credentials
  // set and ECONT_BASE_URL forgotten used to mean demo tariffs quoted as the
  // contract's, with nothing to show for it in the logs.
  process.env.ECONT_PASSWORD = 'p'
  delete process.env.ECONT_BASE_URL
  assert.throws(
    () => getEcontConfig(),
    (err: unknown) => {
      assert.ok(isEcontError(err) && err.kind === 'config')
      assert.deepEqual((err.detail as { missing: string[] }).missing, [
        'ECONT_BASE_URL',
      ])
      return true
    },
  )

  // Fixture mode must keep working with no credentials whatsoever — that is what
  // keeps a fresh clone and a network-restricted sandbox usable. It also keeps
  // its demo default, which is why the check above is scoped to live mode.
  process.env.ECONT_MODE = 'fixture'
  delete process.env.ECONT_USERNAME
  assert.equal(getEcontConfig().baseUrl, 'https://demo.econt.com/ee/services')
  assert.doesNotThrow(() => getEcontConfig())
  assert.doesNotThrow(() => assertSenderConfigured(getEcontConfig()))
  invalidate()
  assert.ok((await getCities()).length > 0)

  console.log('econt-smoke: all assertions passed')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
