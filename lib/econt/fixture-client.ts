import 'server-only'

import type { EcontConfig } from './config'
import { EcontError } from './errors'
import type { EcontPath } from './client'
import type {
  CreateLabelRequest,
  CreateLabelResponse,
  GetOfficesRequest,
  GetOfficesResponse,
  GetQuartersRequest,
  GetQuartersResponse,
  GetStreetsRequest,
  GetStreetsResponse,
} from './types'
import { fixtureCities } from './fixtures/cities'
import { fixtureOffices } from './fixtures/offices'
import { fixtureQuarters, fixtureStreets } from './fixtures/city-details'

/**
 * Stand-in for the Econt API, used when ECONT_MODE=fixture.
 *
 * This exists because sandboxed environments (including Claude Code's) block
 * *.econt.com outright, and because every error branch in the checkout needs to
 * be reachable without waiting for Econt to actually fail. It is not a mock in
 * the test-double sense — it is a second implementation with the same contract,
 * so the UI can be developed and demoed end to end offline.
 */
export async function fixturePost<TReq extends object, TRes>(
  path: EcontPath,
  body: TReq,
  config: EcontConfig,
): Promise<TRes> {
  // Enough latency for loading states to actually be visible in development.
  await sleep(150 + Math.random() * 250)

  raiseConfiguredFault(config)

  const empty = config.fault === 'empty'

  switch (path) {
    case 'Nomenclatures/NomenclaturesService.getCities.json':
      return { cities: empty ? [] : fixtureCities } as TRes

    case 'Nomenclatures/NomenclaturesService.getOffices.json': {
      const { cityID } = body as GetOfficesRequest
      const offices = empty
        ? []
        : cityID === undefined
          ? fixtureOffices
          : fixtureOffices.filter((o) => o.address?.city?.id === cityID)
      return { offices } satisfies GetOfficesResponse as TRes
    }

    case 'Nomenclatures/NomenclaturesService.getStreets.json': {
      const { cityID } = body as GetStreetsRequest
      return {
        streets: empty ? [] : fixtureStreets(cityID),
      } satisfies GetStreetsResponse as TRes
    }

    case 'Nomenclatures/NomenclaturesService.getQuarters.json': {
      const { cityID } = body as GetQuartersRequest
      return {
        quarters: empty ? [] : fixtureQuarters(cityID),
      } satisfies GetQuartersResponse as TRes
    }

    case 'Shipments/LabelService.createLabel.json':
      return priceLabel(body as unknown as CreateLabelRequest) as TRes

    default:
      throw new EcontError('upstream', `No fixture for ${path}`, {
        detail: { path },
      })
  }
}

/**
 * A plausible tariff, not Econt's real one: a base fee plus weight, cheaper to
 * an automat and dearer to the door. Deterministic, so the same selection always
 * quotes the same price and screenshots stay stable.
 */
function priceLabel(req: CreateLabelRequest): CreateLabelResponse {
  const label = req.label
  const weight = Number(label.weight) || 0

  if (weight <= 0) {
    throw new EcontError('validation', 'Липсва тегло на пратката.', {
      field: 'weight',
      detail: { weight },
    })
  }

  let leva = 5.9 + weight * 0.6
  if (label.receiverOfficeCode) {
    // Automat codes in the fixtures are the isAPS offices.
    const isAps = fixtureOffices.some(
      (o) => o.code === label.receiverOfficeCode && o.isAPS,
    )
    if (isAps) leva -= 1
  } else {
    leva += 2.5 // to the door
  }

  const cdAmount = label.services?.cdAmount ?? 0
  if (cdAmount > 0) leva += Math.max(1, cdAmount * 0.01)

  const total = round2(leva)

  return {
    label: {
      currency: 'BGN',
      totalPrice: total,
      courierServicePrice: total,
      senderDueAmount: 0,
      receiverDueAmount: round2(total + cdAmount),
      ...(req.mode === 'create'
        ? {
            shipmentNumber: `105${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`,
            pdfURL: 'https://ee.econt.com/label-fixture.pdf',
          }
        : {}),
    },
  }
}

/**
 * ECONT_FIXTURE_FAULT lets every error branch in the UI be exercised offline.
 * 'empty' is handled by the callers above rather than thrown, since an empty
 * nomenclature is a successful response, not a failure.
 */
function raiseConfiguredFault(config: EcontConfig): void {
  switch (config.fault) {
    case 'timeout':
      throw new EcontError('timeout', 'Econt did not respond within 8000ms (forced)')
    case 'auth':
      throw new EcontError('auth', 'Econt rejected our credentials (forced)')
    case 'upstream':
      throw new EcontError('upstream', 'Econt returned HTTP 500 (forced)')
    case 'validation':
      throw new EcontError(
        'validation',
        'Еконт не разпозна този адрес. Проверете улицата и номера.',
        { field: 'street' },
      )
    case 'empty':
    case null:
      return
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
