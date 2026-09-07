import Link from 'next/link'
import { getStripe } from '@/lib/stripe'

export const metadata = {
  title: 'Поръчката е получена — Wondercraft',
}

export default async function OrderSuccessPage({
  searchParams,
}: {
  searchParams: Promise<{ orderRef?: string; session_id?: string }>
}) {
  const { orderRef, session_id } = await searchParams
  const paid = session_id ? await sessionIsPaid(session_id, orderRef) : false

  return (
    <section className="flex min-h-[70vh] items-center justify-center px-5 py-20">
      <div className="mx-auto max-w-md text-center">
        <span
          className={`mx-auto inline-flex h-16 w-16 items-center justify-center rounded-full border border-border-soft ${paid ? 'bg-jade-tint' : 'bg-mist'}`}
        >
          {paid ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className="h-8 w-8 text-jade-ink">
              <path d="M4 12.5l5 5L20 6" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className="h-8 w-8 text-stone">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 2" />
            </svg>
          )}
        </span>
        <h1 className="mt-6 font-display text-3xl font-bold text-charcoal">
          {paid ? 'Благодарим ви за поръчката!' : 'Обработваме плащането'}
        </h1>
        <p className="mt-4 text-base leading-relaxed text-charcoal-soft">
          {paid
            ? 'Плащането ви е получено успешно. Ще получите имейл с потвърждение, а ние ще подготвим пратката.'
            : 'Ако току-що платихте, потвърждението може да отнеме няколко секунди. Ако не сте завършили плащането, върнете се към началото и опитайте отново.'}
        </p>
        {orderRef ? (
          <p className="mt-3 text-sm text-charcoal-soft">
            Номер на поръчката:{' '}
            <span className="font-semibold tabular-nums text-charcoal">{orderRef}</span>
          </p>
        ) : null}
        <Link
          href="/"
          className="mt-8 inline-flex min-h-11 items-center justify-center rounded-md border border-border-soft bg-salmon px-6 py-3 font-sans text-base font-semibold text-charcoal shadow-soft transition-all duration-200 ease-[cubic-bezier(0.34,1.56,0.64,1)] hover:-translate-y-0.5 hover:bg-salmon-hover hover:shadow-soft-lg active:scale-[0.96] active:duration-100"
        >
          Обратно към началото
        </Link>
      </div>
    </section>
  )
}

async function sessionIsPaid(sessionId: string, orderRef: string | undefined): Promise<boolean> {
  try {
    const session = await getStripe().checkout.sessions.retrieve(sessionId)
    if (orderRef && session.metadata?.orderRef !== orderRef) return false
    return session.payment_status === 'paid'
  } catch {
    return false
  }
}
