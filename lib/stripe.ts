import 'server-only'

import Stripe from 'stripe'

let stripeClient: Stripe | undefined

export function getStripe(): Stripe {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY is not configured')
  }

  stripeClient ??= new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: '2026-03-25.dahlia',
    typescript: true,
  })
  return stripeClient
}

export function getAppUrl(request: Request): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim()
  if (configured) return configured.replace(/\/$/, '')
  return new URL(request.url).origin
}

export function toStripeAmount(eurCents: number): number {
  if (!Number.isSafeInteger(eurCents) || eurCents <= 0) {
    throw new Error('Invalid order amount')
  }
  return eurCents
}

/** Log Stripe failures with the fields the Dashboard search uses. Never send these to the browser. */
export function logStripeError(error: unknown): void {
  const err = error as {
    type?: string
    code?: string
    param?: string
    message?: string
  }
  console.error(
    JSON.stringify({
      evt: 'stripe.failure',
      type: err.type,
      code: err.code,
      param: err.param,
      message: err.message ?? (error instanceof Error ? error.message : String(error)),
    }),
  )
}
