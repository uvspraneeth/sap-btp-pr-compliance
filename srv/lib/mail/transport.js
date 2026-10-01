import cds from '@sap/cds'

/**
 * Pluggable mail transport: console (dev/test) | smtp (nodemailer) | graph (Microsoft Graph sendMail).
 * Each returns { name, send({ to, subject, html, text }) }; errors propagate so the
 * persistent queue retries the message.
 */
const LOG = cds.log('mail')

/** In-memory record of mails "sent" by the console transport (tests read it) */
export const sentMails = []

export function createTransport(options = {}) {
  const kind = options.transport ?? 'console'
  const creds = options.credentials ?? {}
  const from = creds.from ?? options.from ?? 'PR Compliance <no-reply@example.com>'
  if (kind === 'smtp') return smtpTransport(creds, from)
  if (kind === 'graph') return graphTransport(creds)
  return consoleTransport(from)
}

function consoleTransport(from) {
  return {
    name: 'console',
    async send(mail) {
      const links = [...new Set([...(mail.html ?? '').matchAll(/href="([^"]+)"/g)].map(m => m[1].replace(/&amp;/g, '&')))]
      sentMails.push({ from, ...mail, links })
      if (sentMails.length > 200) sentMails.shift()
      LOG.info(`[console mail] to=${mail.to} subject="${mail.subject}"${links.length ? '\n  ' + links.join('\n  ') : ''}`)
    }
  }
}

function smtpTransport(creds, from) {
  let transporter
  return {
    name: 'smtp',
    async send({ to, subject, html, text }) {
      if (!transporter) {
        if (!creds.host) throw new Error('SMTP transport: credentials.host missing (bind user-provided service "pr-mail")')
        const { default: nodemailer } = await import('nodemailer')
        const port = Number(creds.port ?? 587)
        transporter = nodemailer.createTransport({
          host: creds.host,
          port,
          secure: creds.secure === true || creds.secure === 'true' || port === 465,
          auth: creds.user ? { user: creds.user, pass: creds.password } : undefined,
          connectionTimeout: 10e3,
          greetingTimeout: 10e3,
          socketTimeout: 20e3
        })
      }
      await transporter.sendMail({ from, to, subject, html, text })
    }
  }
}

function graphTransport(creds) {
  let token, tokenExp = 0
  const { tenantId, clientId, clientSecret, sender } = creds
  async function accessToken() {
    if (token && Date.now() < tokenExp - 60e3) return token
    if (!tenantId || !clientId || !clientSecret || !sender) throw new Error('Graph transport: tenantId, clientId, clientSecret and sender are required')
    const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, scope: 'https://graph.microsoft.com/.default' }),
      signal: AbortSignal.timeout(10e3)
    })
    if (!res.ok) throw new Error(`Graph token request failed: ${res.status}`)
    const json = await res.json()
    token = json.access_token
    tokenExp = Date.now() + Number(json.expires_in ?? 3600) * 1000
    return token
  }
  return {
    name: 'graph',
    async send({ to, subject, html }) {
      const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender)}/sendMail`, {
        method: 'POST',
        headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          message: { subject, body: { contentType: 'HTML', content: html }, toRecipients: [{ emailAddress: { address: to } }] },
          saveToSentItems: false
        }),
        signal: AbortSignal.timeout(15e3)
      })
      if (res.status !== 202) throw new Error(`Graph sendMail failed: ${res.status} ${(await res.text()).slice(0, 200)}`)
    }
  }
}
