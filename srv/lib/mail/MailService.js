import cds from '@sap/cds'
import { createTransport, sentMails } from './transport.js'
import { approvalRequestMail, prDecisionMail, poMail } from './templates.js'
import { signActionToken } from '../security/tokens.js'
import { addHours } from '../util.js'

export { sentMails }
const LOG = cds.log('mail')

// ---------------------------------------------------------------------------
// Data loaders (business fields only - data minimization); also used by /email-action
// ---------------------------------------------------------------------------
export async function loadApprovalContext(taskID) {
  const { ApprovalTasks, PurchaseRequisitions, PurchaseOrders, ComplianceChecks } = cds.entities('pr')
  const task = await SELECT.one.from(ApprovalTasks)
    .columns('ID', 'kind', 'level', 'status', 'decidedAt', 'tokenNonce', 'tokenExpires', 'pr_ID', 'po_ID', 'approver_userId',
      'approver.email as approverEmail', 'approver.name as approverName',
      'levelInst.name as levelName', 'levelInst.mode as levelMode', 'levelInst.dueAt as dueAt')
    .where({ ID: taskID })
  if (!task) return null
  const po = task.po_ID ? await SELECT.one.from(PurchaseOrders).columns('ID', 'poNumber', 'totalAmount', 'currency_code', 'pr_ID').where({ ID: task.po_ID }) : null
  const prID = task.pr_ID ?? po?.pr_ID
  const pr = prID ? await loadPR(prID, PurchaseRequisitions) : {}
  const checks = prID ? await SELECT.from(ComplianceChecks).columns('checkType', 'result', 'message').where({ pr_ID: prID, revision: pr.revision }) : []
  return { task, pr, po, checks }
}

const loadPR = (ID, PurchaseRequisitions = cds.entities('pr').PurchaseRequisitions) =>
  SELECT.one.from(PurchaseRequisitions)
    .columns('ID', 'prNumber', 'title', 'justification', 'status', 'totalAmount', 'currency_code', 'revision', 'complianceOutcome',
      'costCenter_code', 'requester_userId', 'createdBy', 'requester.name as requesterName', 'vendor.name as vendorName')
    .where({ ID })

async function recipient(userId) {
  if (!userId) return null
  const { Employees } = cds.entities('pr.master')
  return SELECT.one.from(Employees).columns('userId', 'name', 'email').where({ userId })
}

async function decisionComments(where) {
  const { ApprovalTasks } = cds.entities('pr')
  return SELECT.from(ApprovalTasks).columns('status', 'comment', 'approver_userId', 'approver.name as approverName')
    .where({ ...where, status: { in: ['Approved', 'Rejected'] } }).and('comment is not null')
    .orderBy('decidedAt desc').limit(5)
}

const baseUrl = () => String(cds.env.pr?.publicUrl ?? '').replace(/\/$/, '')
export const prLink = prID => `${baseUrl()}/launchpad.html#PurchaseRequisition-manage&/PurchaseRequisitions(ID=${prID},IsActiveEntity=true)`
export const poLink = poID => `${baseUrl()}/launchpad.html#PurchaseOrder-manage&/PurchaseOrders(ID=${poID},IsActiveEntity=true)`
export const actionLink = token => `${baseUrl()}/email-action?t=${encodeURIComponent(token)}`

// ---------------------------------------------------------------------------
/**
 * Outboxed notification service (cds.requires.mail, outboxed: true):
 * handlers run after the business transaction committed, with retries.
 */
export default class MailService extends cds.Service {
  init() {
    this.transport = createTransport(this.options)
    LOG.info(`mail transport: ${this.transport.name}`)

    this.on('approvalRequest', async req => {
      const { taskID, reminder = false } = req.data
      const ctx = await loadApprovalContext(taskID)
      if (!ctx || ctx.task.status !== 'Pending') return LOG.debug('task not pending anymore - skipped', taskID)
      const { task, pr } = ctx
      if (!task.approverEmail) return LOG.warn(`no e-mail for approver ${task.approver_userId} - skipped`)
      const links = { view: task.kind === 'VARIANCE' && task.po_ID ? poLink(task.po_ID) : prLink(pr.ID) }
      if (task.tokenNonce) {
        const expiresAt = task.tokenExpires ?? addHours(cds.env.pr?.tokenTtlHours ?? 72)
        for (const action of ['approve', 'reject'])
          links[action] = actionLink(signActionToken({ taskID, action, nonce: task.tokenNonce, expiresAt }))
      }
      await this.deliver(task.approverEmail, approvalRequestMail({ ...ctx, links, reminder }))
    })

    this.on('prDecision', async req => {
      const pr = await loadPR(req.data.prID)
      if (!pr) return
      const to = await recipient(pr.requester_userId ?? pr.createdBy)
      if (!to?.email) return LOG.warn(`no e-mail for requester of ${pr.prNumber} - skipped`)
      const comments = await decisionComments({ pr_ID: pr.ID, kind: 'PR' })
      await this.deliver(to.email, prDecisionMail({ pr, comments, link: prLink(pr.ID) }))
    })

    this.on('varianceDecision', req => this.poNotification(req.data.poID, 'variance'))
    this.on('poPosted', req => this.poNotification(req.data.poID, 'posted'))
    this.on('poPostFailed', req => this.poNotification(req.data.poID, 'failed'))

    return super.init()
  }

  async poNotification(poID, kind) {
    const { PurchaseOrders } = cds.entities('pr')
    const po = await SELECT.one.from(PurchaseOrders)
      .columns('ID', 'poNumber', 'totalAmount', 'currency_code', 'varianceApproval', 's4Status', 's4PONumber', 's4Error', 'createdBy', 'pr.prNumber as prNumber')
      .where({ ID: poID })
    if (!po) return
    const to = await recipient(po.createdBy)
    if (!to?.email) return LOG.warn(`no e-mail for creator of ${po.poNumber} - skipped`)
    const comments = kind === 'variance' ? await decisionComments({ po_ID: poID, kind: 'VARIANCE' }) : []
    await this.deliver(to.email, poMail({ kind, po, comments, link: poLink(poID) }))
  }

  async deliver(to, { subject, html, text }) {
    await this.transport.send({ to, subject, html, text })
    LOG.debug('mail sent', { to, subject })
  }
}
