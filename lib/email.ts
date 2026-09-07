import 'server-only'

type SendEmailInput = {
  to: string
  subject: string
  text: string
}

/**
 * Send one transactional email via Resend. Returns false when the key is
 * missing so callers can skip without failing the paid order.
 */
export async function sendEmail(input: SendEmailInput): Promise<boolean> {
  const key = process.env.RESEND_API_KEY?.trim()
  const from = process.env.ORDER_EMAIL_FROM?.trim()
  if (!key || !from) {
    console.warn(
      JSON.stringify({
        evt: 'email.skipped',
        reason: 'RESEND_API_KEY or ORDER_EMAIL_FROM is not configured',
        to: input.to,
        subject: input.subject,
      }),
    )
    return false
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [input.to],
      subject: input.subject,
      text: input.text,
    }),
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    console.error(
      JSON.stringify({
        evt: 'email.failure',
        status: response.status,
        detail,
        to: input.to,
        subject: input.subject,
      }),
    )
    return false
  }

  return true
}
