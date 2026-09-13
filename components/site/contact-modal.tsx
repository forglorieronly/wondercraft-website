'use client'

import { useEffect, useReducer, useRef } from 'react'
import { plans, type PlanId } from '@/lib/data/pricing'
import {
  LIMITS,
  hasErrors,
  validateContact,
  validateDelivery,
} from '@/lib/order/schema'
import type { OrderResponse } from '@/lib/econt/dto'
import { findPlan } from '@/lib/data/pricing'
import { DeliverySection } from './checkout/delivery-section'
import { OrderSummary } from './checkout/order-summary'
import { useShippingQuote } from './checkout/use-shipping-quote'
import {
  initialOrderState,
  orderReducer,
  toOrderDraft,
} from './checkout/order-reducer'
import { useAuth } from './auth-context'
import { AlertIcon, CheckIcon, SpinnerIcon } from './icons'
import { Field } from './field'
import { ModalShell, useModalShell } from './modal-shell'

/** The contact fields that validate on blur. */
type ContactField = 'firstName' | 'lastName' | 'email' | 'phone'

export function ContactModal({
  initialModel,
  onClose,
}: {
  initialModel: PlanId
  onClose: () => void
}) {
  const { user } = useAuth()
  const firstFieldRef = useRef<HTMLInputElement>(null)
  const [state, dispatch] = useReducer(orderReducer, initialModel, initialOrderState)

  const { errors, planId } = state
  const isCustom = planId === 'custom'
  const submitted = state.submit.status === 'done'
  const submitting = state.submit.status === 'submitting'
  const plan = findPlan(planId)

  useShippingQuote(state, dispatch)

  useEffect(() => {
    firstFieldRef.current?.focus()
  }, [])

  useEffect(() => {
    const email = user?.email?.trim().toLowerCase()
    if (email) dispatch({ type: 'setText', field: 'email', value: email })
  }, [user?.email])

  // Validate the field the customer just left, so a bad phone or a missing
  // surname surfaces where it was typed rather than after the whole form is
  // filled in. Reuses the same validator submit runs and shows only this
  // field's message; `setText` already clears it again as they retype.
  function handleBlur(field: ContactField) {
    const errors = validateContact(toOrderDraft(state))
    dispatch({ type: 'setFieldError', field, message: errors[field] })
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (submitting) return

    const draft = toOrderDraft(state)
    const next = { ...validateContact(draft), ...validateDelivery(draft.delivery) }
    dispatch({ type: 'setErrors', errors: next })
    if (hasErrors(next)) return

    dispatch({ type: 'submitStart' })
    try {
      // The server validates and prices the order, creates its Stripe Checkout
      // Session, and returns the hosted redirect URL.
      const orderRes = await fetch('/api/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      })
      const orderBody = (await orderRes.json()) as OrderResponse

      if (!orderBody.ok) {
        if (orderBody.errors) dispatch({ type: 'setErrors', errors: orderBody.errors })
        else if (orderBody.field) {
          dispatch({ type: 'setErrors', errors: { [orderBody.field]: orderBody.message } as never })
        }
        dispatch({ type: 'submitError', message: orderBody.message })
        return
      }

      if (!orderRes.ok || !orderBody.checkoutUrl) {
        dispatch({
          type: 'submitError',
          message: 'Не успяхме да стартираме плащането. Опитайте отново.',
        })
        return
      }

      window.location.assign(orderBody.checkoutUrl)
    } catch {
      dispatch({
        type: 'submitError',
        message:
          'Нещо се обърка при изпращането. Проверете връзката и опитайте отново.',
      })
    }
  }

  return (
    <ModalShell
      title={submitted ? 'Благодарим ви!' : 'Поръчай сега'}
      onClose={onClose}
      aside={
        submitted ? undefined : (
          // Sticky so the total and the button stay in view if the column
          // itself has to scroll — a quote error adds a paragraph below.
          <div className="lg:sticky lg:top-0">
            <OrderSummary
              productEurCents={plan?.priceEurCents ?? 0}
              quote={state.quote}
            />
            {state.submit.status === 'error' && (
              <p
                role="alert"
                className="mt-4 flex items-start gap-2 rounded-md border border-error bg-salmon-soft px-4 py-3 text-sm leading-relaxed text-charcoal"
              >
                <AlertIcon className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
                {state.submit.message}
              </p>
            )}
            <button
              type="submit"
              form="order-form"
              disabled={submitting}
              className="mt-4 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md border border-border-soft bg-salmon px-6 py-3 font-sans text-base font-semibold text-charcoal shadow-soft transition-all duration-200 ease-[cubic-bezier(0.34,1.56,0.64,1)] hover:-translate-y-0.5 hover:scale-[1.02] hover:bg-salmon-hover hover:shadow-soft-lg active:scale-[0.96] active:duration-100 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0 disabled:hover:scale-100"
            >
              {submitting && (
                <SpinnerIcon className="h-4 w-4 animate-spin" aria-hidden="true" />
              )}
              {submitting ? 'Изпращаме…' : 'Поръчай сега'}
            </button>
            <p className="mt-3 text-center text-sm text-charcoal-soft">
              Плащането е със карта през Stripe.
            </p>
          </div>
        )
      }
    >
      {submitted ? (
        <SuccessPanel
          orderRef={
            state.submit.status === 'done' ? state.submit.orderRef : ''
          }
        />
      ) : (
        <form
          id="order-form"
          onSubmit={handleSubmit}
          noValidate
          // flex-1 covers the stacked layout; the explicit placement is for the
          // lg grid, where flex sizing no longer applies.
          className="min-h-0 flex-1 overflow-y-auto px-6 py-5 lg:col-start-1 lg:row-start-2"
        >
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Име" error={errors.firstName}>
                {({ describedBy, hasError }) => (
                  <input
                    ref={firstFieldRef}
                    name="firstName"
                    type="text"
                    autoComplete="given-name"
                    maxLength={LIMITS.firstName}
                    className="modal-input"
                    value={state.firstName}
                    aria-invalid={hasError || undefined}
                    aria-describedby={describedBy}
                    onBlur={() => handleBlur('firstName')}
                    onChange={(e) =>
                      dispatch({
                        type: 'setText',
                        field: 'firstName',
                        value: e.target.value,
                      })
                    }
                  />
                )}
              </Field>

              <Field label="Фамилия" error={errors.lastName}>
                {({ describedBy, hasError }) => (
                  <input
                    name="lastName"
                    type="text"
                    autoComplete="family-name"
                    maxLength={LIMITS.lastName}
                    className="modal-input"
                    value={state.lastName}
                    aria-invalid={hasError || undefined}
                    aria-describedby={describedBy}
                    onBlur={() => handleBlur('lastName')}
                    onChange={(e) =>
                      dispatch({
                        type: 'setText',
                        field: 'lastName',
                        value: e.target.value,
                      })
                    }
                  />
                )}
              </Field>
            </div>

            <Field
              label="Имейл"
              error={errors.email}
              hint="Имейлът на профила ви. Потвърждението за плащане отива тук."
            >
              {({ describedBy, hasError }) => (
                <input
                  name="email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  maxLength={LIMITS.email}
                  className="modal-input bg-mist"
                  value={state.email}
                  readOnly
                  aria-invalid={hasError || undefined}
                  aria-describedby={describedBy}
                />
              )}
            </Field>

            <Field label="Телефон" error={errors.phone}>
              {({ describedBy, hasError }) => (
                <input
                  name="phone"
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  className="modal-input"
                  value={state.phone}
                  aria-invalid={hasError || undefined}
                  aria-describedby={describedBy}
                  onBlur={() => handleBlur('phone')}
                  onChange={(e) =>
                    dispatch({ type: 'setText', field: 'phone', value: e.target.value })
                  }
                />
              )}
            </Field>

            <Field label="Модел" error={errors.model}>
              {({ describedBy, hasError }) => (
                <select
                  name="model"
                  className="modal-input"
                  value={planId}
                  aria-invalid={hasError || undefined}
                  aria-describedby={describedBy}
                  onChange={(e) =>
                    dispatch({ type: 'setPlan', planId: e.target.value as PlanId })
                  }
                >
                  {plans.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} — {p.euro} ({p.lev})
                    </option>
                  ))}
                </select>
              )}
            </Field>

            {isCustom && (
              <>
                <Field label="Име за печат" error={errors.printName}>
                  {({ describedBy, hasError }) => (
                    <input
                      name="printName"
                      type="text"
                      maxLength={LIMITS.printName}
                      className="modal-input"
                      value={state.printName}
                      aria-invalid={hasError || undefined}
                      aria-describedby={describedBy}
                      onChange={(e) =>
                        dispatch({
                          type: 'setText',
                          field: 'printName',
                          value: e.target.value,
                        })
                      }
                    />
                  )}
                </Field>
                <Field label="Допълнителна персонализация" error={errors.customization}>
                  {({ describedBy }) => (
                    <textarea
                      name="customization"
                      rows={2}
                      maxLength={LIMITS.customization}
                      className="modal-input resize-none"
                      value={state.customization}
                      aria-describedby={describedBy}
                      onChange={(e) =>
                        dispatch({
                          type: 'setText',
                          field: 'customization',
                          value: e.target.value,
                        })
                      }
                    />
                  )}
                </Field>
              </>
            )}

            <hr className="border-border-soft" />

            <DeliverySection state={state} dispatch={dispatch} />

            <hr className="border-border-soft" />

            <Field label="Съобщение (по избор)" error={errors.message}>
              {({ describedBy }) => (
                <textarea
                  name="message"
                  rows={2}
                  maxLength={LIMITS.message}
                  className="modal-input resize-none"
                  value={state.message}
                  aria-describedby={describedBy}
                  onChange={(e) =>
                    dispatch({ type: 'setText', field: 'message', value: e.target.value })
                  }
                />
              )}
            </Field>
          </div>

        </form>
      )}
    </ModalShell>
  )
}

function SuccessPanel({ orderRef }: { orderRef: string }) {
  const { requestClose } = useModalShell()

  return (
    <div className="px-6 py-10 text-center">
      <span className="mx-auto inline-flex h-14 w-14 items-center justify-center rounded-full border border-border-soft bg-salmon">
        <CheckIcon className="h-7 w-7 text-charcoal" aria-hidden="true" />
      </span>
      <p className="mt-5 text-pretty text-base leading-relaxed text-charcoal">
        Получихме заявката ви. Ще се свържем с вас възможно най-скоро, за да
        потвърдим поръчката и доставката.
      </p>
      {orderRef && (
        <p className="mt-4 text-sm text-charcoal-soft">
          Номер на поръчката:{' '}
          <span className="font-sans font-semibold tabular-nums text-charcoal">
            {orderRef}
          </span>
        </p>
      )}
      <button
        type="button"
        onClick={requestClose}
        className="mt-6 inline-flex min-h-11 items-center justify-center rounded-md border border-border-soft bg-transparent px-6 py-3 font-sans text-base font-semibold text-charcoal"
      >
        Затвори
      </button>
    </div>
  )
}
