import cds from '@sap/cds'
import crypto from 'node:crypto'
import express from 'express'
import { verifyActionToken, signFormToken, verifyFormToken } from '../security/tokens.js'
import { loadApprovalContext, prLink, poLink } from './MailService.js'
import { confirmPage, resultPage } from './templates.js'
import { decide } from '../workflow/engine.js'

/**
 * Approve / Reject from Outlook:
 *   GET  /email-action?t=<token>  -> login (approuter/XSUAA) + confirmation page. Never changes state,
 *                                    so Safe Links / Defender link prefetching cannot approve anything.
 *   POST /email-action            -> re-validates everything, then calls the workflow engine.
 * Checks: signature + expiry, single-use nonce (cleared by the engine on decision), task still
 * Pending, logged-in user === assigned approver, stateless form token (anti-CSRF).
 */
const LOG = cds.log('email-action')

export function mountEmailActions(app) {
  const router = express.Router()
  router.use(secureHeaders)
  router.use(...cds.middlewares.before) // cds.context + authentication (mocked / XSUAA)
  router.use(requireUser)
  router.get('/', (req, res) => handle(req, res, 'GET'))
  router.post('/', express.urlencoded({ extended: false, limit: '10kb', parameterLimit: 10 }), (req, res) => handle(req, res, 'POST'))
  app.use('/email-action', router)
}

function secureHeaders(req, res, next) {
  res.locals.nonce = crypto.randomBytes(16).toString('base64')
  res.set({
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${res.locals.nonce}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`
  })
  next()
}

function requireUser(req, res, next) {
  const user = cds.context?.user
  if (user?.id && !user._is_anonymous) return next()
  if (typeof req._login === 'function') return req._login() // mocked/basic auth challenge (dev)
  send(res, 401, { title: 'Sign-in required', message: 'Please sign in to confirm your decision.', tone: 'critical' })
}

const send = (res, status, opts) => res.status(status).type('html').send(resultPage({ nonce: res.locals.nonce, ...opts }))

async function handle(req, res, method) {
  const token = String((method === 'GET' ? req.query.t : req.body?.t) ?? '')
  const user = cds.context.user
  try {
    let claims
    try {
      claims = verifyActionToken(token)
    } catch (e) {
      return e.code === 'TOKEN_EXPIRED'
        ? send(res, 410, { title: 'Link expired', message: 'This approval link has expired. Please open the request in the app to decide.', tone: 'critical' })
        : send(res, 400, { title: 'Invalid link', message: 'This approval link is not valid. Please use the latest e-mail or open the app.', tone: 'negative' })
    }

    const ctx = await loadApprovalContext(claims.taskID)
    const link = ctx && (ctx.task.kind === 'VARIANCE' && ctx.task.po_ID ? poLink(ctx.task.po_ID) : prLink(ctx.pr.ID))
    const problem = validate(ctx, claims, user)
    if (problem) return send(res, problem.status, { ...problem, link })

    if (method === 'GET')
      return res.type('html').send(confirmPage({ nonce: res.locals.nonce, action: claims.action, token, formToken: signFormToken(token, user.id), ctx }))

    // POST
    if (!verifyFormToken(req.body?.f, token, user.id))
      return send(res, 403, { title: 'Request not accepted', message: 'The confirmation form is invalid. Please open the link from the e-mail again.', tone: 'negative', link })
    const comment = String(req.body?.comment ?? '').trim().slice(0, 500)
    if (claims.action === 'reject' && !comment)
      return res.status(400).type('html').send(confirmPage({
        nonce: res.locals.nonce, action: claims.action, token, formToken: signFormToken(token, user.id), ctx, error: 'Please enter a reason for the rejection.'
      }))

    const decision = claims.action === 'approve' ? 'Approved' : 'Rejected'
    await cds.tx({ user }, () => decide({ taskID: claims.taskID, decision, comment: comment || null, via: 'EMAIL' }))
    LOG.info(`task ${claims.taskID} ${decision} via e-mail by ${user.id}`)
    return send(res, 200, {
      title: decision === 'Approved' ? 'Approved - thank you' : 'Rejected',
      message: `Your decision on ${ctx.po?.poNumber ?? ctx.pr.prNumber} was recorded. The requester will be notified.`,
      tone: decision === 'Approved' ? 'positive' : 'negative', link
    })
  } catch (e) {
    const status = Number(e.status ?? e.statusCode ?? e.code)
    if (status === 409) return send(res, 409, { title: 'Already decided', message: 'This approval step has already been completed.', tone: 'neutral' })
    if (status === 403) return send(res, 403, { title: 'Not allowed', message: 'You are not the assigned approver for this step.', tone: 'negative' })
    if (status === 404) return send(res, 404, { title: 'Not found', message: 'This approval task no longer exists.', tone: 'negative' })
    LOG.error('e-mail action failed', e)
    return send(res, 500, { title: 'Something went wrong', message: 'Your decision could not be recorded. Please try again or use the app.', tone: 'negative' })
  }
}

function validate(ctx, claims, user) {
  if (!ctx) return { status: 404, title: 'Not found', message: 'This approval task no longer exists.', tone: 'negative' }
  const { task } = ctx
  if (task.approver_userId !== user.id)
    return { status: 403, title: 'Not allowed', message: 'This approval is assigned to another user. Please sign in with the account the e-mail was sent to.', tone: 'negative' }
  if (task.status !== 'Pending')
    return { status: 409, title: 'Already decided', message: `This step was already completed (${task.status}${task.decidedAt ? ' on ' + task.decidedAt.slice(0, 10) : ''}).`, tone: 'neutral' }
  if (!task.tokenNonce || task.tokenNonce !== claims.nonce)
    return { status: 410, title: 'Link no longer valid', message: 'This link has been used or replaced by a newer e-mail.', tone: 'critical' }
  if (task.tokenExpires && Date.parse(task.tokenExpires) < Date.now())
    return { status: 410, title: 'Link expired', message: 'This approval link has expired. Please open the request in the app to decide.', tone: 'critical' }
}
