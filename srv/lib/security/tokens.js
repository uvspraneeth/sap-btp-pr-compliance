import cds from '@sap/cds'
import crypto from 'node:crypto'

/**
 * HMAC-SHA256 signed, single-use (nonce bound to the task row), expiring
 * action tokens for the Approve / Reject links in approval e-mails.
 * Format: base64url(json).base64url(hmac)
 */
const LOG = cds.log('tokens')
const DEV_SECRET = 'pr-compliance-dev-only-secret-do-not-use-in-production'
const ACTIONS = new Set(['approve', 'reject'])
let _secret, _warned

const b64 = buf => Buffer.from(buf).toString('base64url')
const hmac = (purpose, data) => crypto.createHmac('sha256', secret()).update(`${purpose}.${data}`).digest()

function fromVcap(name) {
  if (!process.env.VCAP_SERVICES) return
  try {
    const vcap = JSON.parse(process.env.VCAP_SERVICES)
    const svc = Object.values(vcap).flat().find(s => s?.name === name || s?.instance_name === name)
    return svc?.credentials?.tokenSecret
  } catch {
    LOG.warn('VCAP_SERVICES could not be parsed')
  }
}

function secret() {
  if (_secret) return _secret
  const s = process.env.PR_TOKEN_SECRET || fromVcap(cds.env.pr?.secretsVcapName ?? 'pr-secrets')
  if (s) {
    if (s.length < 32 && cds.env.production) throw tokenError('Action token secret must be at least 32 characters', 'SECRET_WEAK', 500)
    return (_secret = s)
  }
  // fail closed in production - never sign links with a known secret
  if (cds.env.production) throw tokenError('Action token secret missing: bind user-provided service "pr-secrets" with credentials.tokenSecret', 'SECRET_MISSING', 500)
  if (!_warned) (_warned = true), LOG.warn('PR_TOKEN_SECRET not set - using an insecure development secret')
  return DEV_SECRET
}

function tokenError(message, code, status = 400) {
  return Object.assign(new Error(message), { code, status })
}

const safeEqual = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b)

export function signActionToken({ taskID, action, nonce, expiresAt }) {
  if (!taskID || !nonce || !ACTIONS.has(action)) throw tokenError('Invalid token claims', 'TOKEN_CLAIMS')
  const exp = Math.floor(Date.parse(expiresAt) / 1000)
  if (!Number.isFinite(exp)) throw tokenError('Invalid token expiry', 'TOKEN_CLAIMS')
  const body = b64(JSON.stringify({ t: taskID, a: action, n: nonce, e: exp }))
  return `${body}.${b64(hmac('pr-action.v1', body))}`
}

/** @returns {{ taskID: string, action: 'approve'|'reject', nonce: string, exp: number }} */
export function verifyActionToken(token) {
  if (typeof token !== 'string' || token.length > 1024) throw tokenError('Invalid link', 'TOKEN_INVALID')
  const [body, sig, extra] = token.split('.')
  if (!body || !sig || extra !== undefined) throw tokenError('Invalid link', 'TOKEN_INVALID')
  if (!safeEqual(Buffer.from(sig, 'base64url'), hmac('pr-action.v1', body))) throw tokenError('Invalid link', 'TOKEN_INVALID')
  let claims
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    throw tokenError('Invalid link', 'TOKEN_INVALID')
  }
  const { t: taskID, a: action, n: nonce, e: exp } = claims ?? {}
  if (typeof taskID !== 'string' || typeof nonce !== 'string' || !ACTIONS.has(action) || !Number.isInteger(exp))
    throw tokenError('Invalid link', 'TOKEN_INVALID')
  if (exp * 1000 < Date.now()) throw tokenError('This link has expired', 'TOKEN_EXPIRED', 410)
  return { taskID, action, nonce, exp }
}

/** Stateless anti-CSRF token for the confirmation form: bound to action token + user */
export const signFormToken = (token, userId) => b64(hmac('pr-form.v1', `${userId}.${token}`))
export const verifyFormToken = (formToken, token, userId) =>
  typeof formToken === 'string' && safeEqual(Buffer.from(formToken, 'base64url'), hmac('pr-form.v1', `${userId}.${token}`))
