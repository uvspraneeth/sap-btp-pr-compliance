import cds from '@sap/cds'
import crypto from 'node:crypto'
import { num, now, addHours, dbEntities, mdEntities, logEvent, userId } from '../util.js'
import { resolveApprovers, findRule } from './approvers.js'

/**
 * Data-driven multi-level approval engine.
 *
 * - Levels come from ApprovalRules/ApprovalLevelDefs (snapshotted per revision).
 * - Parallel approvers per level are reconciled by mode: ALL | ANY | QUORUM.
 * - Decisions (app or e-mail) are idempotent and race-safe:
 *     1. the subject row (PR / PO) is locked FOR UPDATE -> reconciliation is serialized,
 *     2. the task is updated conditionally (WHERE status = 'Pending') -> double clicks are no-ops.
 * - Mails go through the persistent outbox -> sent only after commit, retried on failure.
 */

const queueMail = async (event, data) => (await cds.connect.to('mail')).send(event, data)

/** Pure reconciliation rule for one level (exported for tests) */
export function levelOutcome(mode, quorum, { approved, rejected, pending }) {
  switch (mode) {
    case 'ALL': return rejected > 0 ? 'Rejected' : pending === 0 ? 'Approved' : null
    case 'ANY': return approved > 0 ? 'Approved' : rejected > 0 ? 'Rejected' : null
    case 'QUORUM': return approved >= quorum ? 'Approved' : approved + pending < quorum ? 'Rejected' : null
    default: cds.error(500, `Unknown approval mode ${mode}`)
  }
}

export async function startApproval({ prID, kind = 'PR', poID = null }) {
  const { PurchaseRequisitions, PurchaseOrders, ApprovalLevels } = dbEntities()
  const pr = await SELECT.one.from(PurchaseRequisitions).where({ ID: prID })
  if (!pr) cds.error(404, `Purchase requisition ${prID} not found`)
  const subject = kind === 'VARIANCE' ? await SELECT.one.from(PurchaseOrders).where({ ID: poID }) : pr
  if (!subject) cds.error(404, `Purchase order ${poID} not found`)
  const amount = num(subject.totalAmount)

  const rule = await findRule(kind, { category_code: pr.category_code, totalAmount: amount })
  if (!rule) cds.error(422, `No active ${kind} approval rule matches ${pr.prNumber}`)

  if (kind === 'VARIANCE') // a new variance request supersedes older open ones
    await closeOpenLevels({ pr_ID: prID, kind, po_ID: poID })

  const levels = [...rule.levels].sort((a, b) => a.level - b.level).map(d => ({
    ID: cds.utils.uuid(), pr_ID: prID, po_ID: poID, kind, revision: pr.revision,
    level: d.level, name: d.name, mode: d.mode, quorum: d.quorum, slaHours: d.slaHours,
    approverSource: d.approverSource, group_code: d.group_code,
    status: amount < num(d.minAmount) ? 'Skipped' : 'Waiting'
  }))
  if (levels.length) await INSERT.into(ApprovalLevels).entries(levels)

  const first = levels.find(l => l.status === 'Waiting')
  if (first) return activateLevel(first, pr)
  return finalize({ pr, kind, poID, approved: true }) // every level skipped
}

async function activateLevel(level, pr) {
  const { ApprovalLevels, ApprovalTasks, PurchaseRequisitions } = dbEntities()
  const prior = await SELECT.from(ApprovalTasks).columns('approver_userId')
    .where`pr_ID = ${pr.ID} and kind = ${level.kind} and status = 'Approved' and levelInst.revision = ${level.revision}`
  const approvers = await resolveApprovers(level, pr, { alreadyApproved: prior.map(p => p.approver_userId) })

  const quorum = level.mode === 'ALL' ? approvers.length
    : level.mode === 'ANY' ? 1
    : Math.min(Math.max(1, num(level.quorum)), approvers.length)
  const ttl = cds.env.pr?.tokenTtlHours ?? 72
  const tasks = approvers.map(approver_userId => ({
    ID: cds.utils.uuid(), pr_ID: pr.ID, po_ID: level.po_ID, levelInst_ID: level.ID, kind: level.kind,
    level: level.level, approver_userId, status: 'Pending',
    tokenNonce: crypto.randomBytes(16).toString('hex'), tokenExpires: addHours(ttl)
  }))
  await INSERT.into(ApprovalTasks).entries(tasks)
  await UPDATE(ApprovalLevels, level.ID).with({ status: 'Active', quorum, activatedAt: now(), dueAt: addHours(level.slaHours ?? 48) })
  if (level.kind === 'PR') await UPDATE(PurchaseRequisitions, pr.ID).with({ status: 'InApproval', currentLevel: level.level })

  const modeText = level.mode === 'QUORUM' ? `QUORUM ${quorum}/${approvers.length}` : level.mode
  await logEvent({ pr_ID: pr.ID, po_ID: level.po_ID, type: 'LEVEL_ACTIVATED', level: level.level, message: `${level.name} [${modeText}]: ${approvers.join(', ')}` })
  for (const t of tasks) await queueMail('approvalRequest', { taskID: t.ID })
}

/**
 * Record one approver's decision and reconcile its level.
 * Runs in the caller's transaction; cds.context.user is the decider.
 */
export async function decide({ taskID, decision, comment, via = 'APP' }) {
  const { ApprovalTasks, PurchaseRequisitions, PurchaseOrders } = dbEntities()
  if (decision !== 'Approved' && decision !== 'Rejected') cds.error(400, `Invalid decision ${decision}`)
  comment = comment?.trim() || null
  if (decision === 'Rejected' && !comment) cds.error(400, 'Please provide a reason for the rejection')

  const task = await SELECT.one.from(ApprovalTasks).where({ ID: taskID })
  if (!task) cds.error(404, 'Approval task not found')
  if (task.approver_userId !== userId()) cds.error(403, 'This approval task is assigned to someone else')
  if (task.status !== 'Pending') cds.error(409, `This task has already been ${task.status.toLowerCase()}`)

  // Serialize reconciliation of parallel approvers on the same subject
  if (task.kind === 'VARIANCE') await SELECT.one.from(PurchaseOrders).columns('ID').where({ ID: task.po_ID }).forUpdate()
  else await SELECT.one.from(PurchaseRequisitions).columns('ID').where({ ID: task.pr_ID }).forUpdate()

  const changed = await UPDATE(ApprovalTasks).where({ ID: taskID, status: 'Pending' })
    .with({ status: decision, comment, decidedAt: now(), decidedVia: via, tokenNonce: null })
  if (!changed) cds.error(409, 'This task has already been decided')

  await logEvent({ pr_ID: task.pr_ID, po_ID: task.po_ID, type: decision === 'Approved' ? 'TASK_APPROVED' : 'TASK_REJECTED', level: task.level, message: comment ?? `${decision} via ${via}` })
  await reconcileLevel(task.levelInst_ID)
  return SELECT.one.from(ApprovalTasks).where({ ID: taskID })
}

async function reconcileLevel(levelID) {
  const { ApprovalLevels, ApprovalTasks, PurchaseRequisitions } = dbEntities()
  const level = await SELECT.one.from(ApprovalLevels).where({ ID: levelID })
  if (level?.status !== 'Active') return

  const tasks = await SELECT.from(ApprovalTasks).columns('status').where({ levelInst_ID: levelID })
  const count = s => tasks.filter(t => t.status === s).length
  const outcome = levelOutcome(level.mode, num(level.quorum), { approved: count('Approved'), rejected: count('Rejected'), pending: count('Pending') })
  if (!outcome) return // waiting for further parallel approvers

  await UPDATE(ApprovalLevels, levelID).with({ status: outcome, completedAt: now() })
  await UPDATE(ApprovalTasks).where({ levelInst_ID: levelID, status: 'Pending' })
    .with({ status: 'Cancelled', decidedAt: now(), decidedVia: 'SYS', tokenNonce: null })
  await logEvent({ pr_ID: level.pr_ID, po_ID: level.po_ID, type: outcome === 'Approved' ? 'LEVEL_APPROVED' : 'LEVEL_REJECTED', level: level.level, message: level.name })

  const pr = await SELECT.one.from(PurchaseRequisitions).where({ ID: level.pr_ID })
  if (outcome === 'Rejected') {
    await closeOpenLevels({ pr_ID: level.pr_ID, kind: level.kind, po_ID: level.po_ID })
    return finalize({ pr, kind: level.kind, poID: level.po_ID, approved: false })
  }
  const next = await SELECT.one.from(ApprovalLevels)
    .where({ pr_ID: level.pr_ID, kind: level.kind, po_ID: level.po_ID, revision: level.revision, status: 'Waiting', level: { '>': level.level } })
    .orderBy('level')
  if (next) return activateLevel(next, pr)
  return finalize({ pr, kind: level.kind, poID: level.po_ID, approved: true })
}

async function finalize({ pr, kind, poID, approved }) {
  const { PurchaseRequisitions, PurchaseOrders, ComplianceChecks } = dbEntities()
  const { Budgets } = mdEntities()

  if (kind === 'VARIANCE') {
    await UPDATE(PurchaseOrders, poID).with({ varianceApproval: approved ? 'APPROVED' : 'REJECTED' })
    await logEvent({ pr_ID: pr.ID, po_ID: poID, type: approved ? 'VARIANCE_APPROVED' : 'VARIANCE_REJECTED' })
    return queueMail('varianceDecision', { poID })
  }

  if (approved) {
    // Commit budget atomically - guards against concurrent overspend
    const amount = num(pr.totalAmount), fiscalYear = new Date().getFullYear()
    const committed = await UPDATE(Budgets)
      .where`costCenter_code = ${pr.costCenter_code} and fiscalYear = ${fiscalYear} and amount - committed - consumed >= ${amount}`
      .with({ committed: { '+=': amount } })
    if (committed) {
      await UPDATE(PurchaseRequisitions, pr.ID).with({ status: 'Approved', decidedAt: now(), budgetCommitted: amount })
      await logEvent({ pr_ID: pr.ID, type: 'APPROVED', message: 'All approval levels completed' })
    } else {
      await INSERT.into(ComplianceChecks).entries({ pr_ID: pr.ID, revision: pr.revision, checkType: 'BUDGET', result: 'FAIL', message: 'Budget was exhausted before final approval', durationMs: 0 })
      await UPDATE(PurchaseRequisitions, pr.ID).with({ status: 'Blocked', complianceOutcome: 'BLOCK', decidedAt: now() })
      await logEvent({ pr_ID: pr.ID, type: 'BLOCKED', message: 'Budget exhausted at final approval' })
    }
  } else {
    await UPDATE(PurchaseRequisitions, pr.ID).with({ status: 'Rejected', decidedAt: now() })
    await logEvent({ pr_ID: pr.ID, type: 'REJECTED' })
  }
  return queueMail('prDecision', { prID: pr.ID })
}

async function closeOpenLevels({ pr_ID, kind, po_ID = null }) {
  const { ApprovalLevels, ApprovalTasks } = dbEntities()
  await UPDATE(ApprovalTasks).where({ pr_ID, kind, po_ID, status: 'Pending' })
    .with({ status: 'Cancelled', decidedAt: now(), decidedVia: 'SYS', tokenNonce: null })
  await UPDATE(ApprovalLevels).where({ pr_ID, kind, po_ID, status: { in: ['Waiting', 'Active'] } })
    .with({ status: 'Cancelled', completedAt: now() })
}

/** Requester withdraws a PR that is in approval */
export async function withdraw({ prID, reason }) {
  const { PurchaseRequisitions } = dbEntities()
  const pr = await SELECT.one.from(PurchaseRequisitions).where({ ID: prID }).forUpdate()
  if (!pr) cds.error(404, 'Purchase requisition not found')
  if (pr.status !== 'InApproval') cds.error(409, `Only requisitions in approval can be withdrawn (status: ${pr.status})`)
  await closeOpenLevels({ pr_ID: prID, kind: 'PR' })
  await UPDATE(PurchaseRequisitions, prID).with({ status: 'Withdrawn', currentLevel: 0 })
  await logEvent({ pr_ID: prID, type: 'WITHDRAWN', message: reason?.trim() || null })
}
