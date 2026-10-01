import { dbEntities, mdEntities, num } from '../util.js'
import { findRule } from './approvers.js'

/**
 * Builds the JSON model for sap.suite.ui.commons.ProcessFlow in ONE round trip:
 * Requested -> Compliance (4 parallel checks, joined) -> approval levels
 * (one node per parallel approver) -> Purchase Order(s) -> S/4HANA.
 */
const CHECK_STATE = { PASS: 'Positive', WARN: 'Critical', FAIL: 'Negative' }
const TASK_STATE = { Approved: 'Positive', Rejected: 'Negative', Pending: 'Neutral', Cancelled: 'Planned' }
const TASK_TEXT = { Approved: 'Approved', Rejected: 'Rejected', Pending: 'Pending', Cancelled: 'Not required' }
const LEVEL_ICONS = ['sap-icon://employee-approvals', 'sap-icon://group', 'sap-icon://approvals']
const fmtDate = ts => (ts ? new Date(ts).toISOString().slice(0, 16).replace('T', ' ') : '')
const initials = name => (name ?? '?').split(/\s+/).map(p => p[0]).join('').slice(0, 2).toUpperCase()

export async function buildProcessFlow(prID) {
  const { PurchaseRequisitions, ComplianceChecks, ApprovalLevels, ApprovalTasks, PurchaseOrders } = dbEntities()
  const { Employees } = mdEntities()
  const pr = await SELECT.one.from(PurchaseRequisitions).where({ ID: prID })
  if (!pr) return JSON.stringify({ lanes: [], nodes: [] })

  const [checks, levels, tasks, pos] = await Promise.all([
    SELECT.from(ComplianceChecks).where({ pr_ID: prID, revision: pr.revision }),
    SELECT.from(ApprovalLevels).where({ pr_ID: prID, kind: 'PR', revision: pr.revision }).orderBy('level'),
    SELECT.from(ApprovalTasks).columns('ID', 'levelInst_ID', 'approver_userId', 'status', 'decidedAt', 'comment').where({ pr_ID: prID, kind: 'PR' }),
    SELECT.from(PurchaseOrders).columns('ID', 'poNumber', 'reconStatus', 'varianceApproval', 's4Status', 's4PONumber', 'totalAmount', 'currency_code').where({ pr_ID: prID }).orderBy('createdAt')
  ])
  const userIds = [...new Set([pr.requester_userId, ...tasks.map(t => t.approver_userId)].filter(Boolean))]
  const names = Object.fromEntries((userIds.length ? await SELECT.from(Employees).columns('userId', 'name').where({ userId: { in: userIds } }) : []).map(e => [e.userId, e.name]))

  const lanes = [], columns = []
  const lane = (id, icon, label) => { lanes.push({ id, icon, label, position: lanes.length }); const col = []; columns.push(col); return col }

  // 1. Requested
  const submitted = pr.status !== 'Draft'
  lane('REQ', 'sap-icon://request', 'Requested').push({
    id: 'req', lane: 'REQ', title: pr.prNumber ?? 'Draft requisition', titleAbbreviation: 'PR',
    state: submitted ? 'Positive' : 'Neutral', stateText: submitted ? `Submitted (rev. ${pr.revision})` : 'Draft',
    texts: [names[pr.requester_userId] ?? pr.requester_userId ?? '', `${num(pr.totalAmount).toFixed(2)} ${pr.currency_code ?? ''}`]
  })

  // 2. Compliance fork/join
  const compliance = lane('CHK', 'sap-icon://inspection', 'Compliance')
  for (const type of ['BUDGET', 'VENDOR', 'POLICY', 'DUPLICATE']) {
    const c = checks.find(x => x.checkType === type)
    compliance.push({
      id: `chk-${type}`, lane: 'CHK', title: type[0] + type.slice(1).toLowerCase(), titleAbbreviation: type.slice(0, 2),
      state: c ? CHECK_STATE[c.result] : 'Planned', stateText: c ? c.result : 'Not run', texts: c ? [c.message.slice(0, 80)] : []
    })
  }

  // 3. Approval levels - actual (current revision) or planned from the matching rule
  if (levels.length) {
    for (const l of levels) {
      const col = lane(`L${l.level}`, LEVEL_ICONS[l.level - 1] ?? 'sap-icon://approvals', `L${l.level} ${l.name}`)
      const lt = tasks.filter(t => t.levelInst_ID === l.ID)
      if (!lt.length) col.push({ id: `lvl-${l.ID}`, lane: `L${l.level}`, title: l.name, titleAbbreviation: `L${l.level}`, state: l.status === 'Rejected' ? 'PlannedNegative' : 'Planned', stateText: l.status, texts: [l.mode] })
      for (const t of lt) col.push({
        id: `task-${t.ID}`, lane: `L${l.level}`, title: names[t.approver_userId] ?? t.approver_userId, titleAbbreviation: initials(names[t.approver_userId]),
        state: TASK_STATE[t.status], stateText: TASK_TEXT[t.status],
        texts: [`${l.mode}${l.mode === 'QUORUM' ? ` ${l.quorum}` : ''}${t.decidedAt ? ' - ' + fmtDate(t.decidedAt) : ''}`, t.comment?.slice(0, 60) ?? '']
      })
    }
  } else {
    const rule = await findRule('PR', { category_code: pr.category_code, totalAmount: num(pr.totalAmount) }).catch(() => null)
    for (const d of (rule?.levels ?? []).sort((a, b) => a.level - b.level)) {
      lane(`L${d.level}`, LEVEL_ICONS[d.level - 1] ?? 'sap-icon://approvals', `L${d.level} ${d.name}`)
        .push({ id: `plan-${d.level}`, lane: `L${d.level}`, title: d.name, titleAbbreviation: `L${d.level}`, state: 'Planned', stateText: 'Waiting', texts: [d.mode] })
    }
  }

  // 4. Purchase orders + 5. S/4HANA
  const poCol = lane('PO', 'sap-icon://sales-order', 'Purchase Order')
  const s4Col = lane('S4', 'sap-icon://it-system', 'S/4HANA')
  const RECON = { MATCHED: 'Positive', TOLERANCE: 'Critical', VARIANCE: 'Negative', PENDING: 'Neutral' }
  const S4 = { Posted: 'Positive', Queued: 'Neutral', Failed: 'Negative', NotPosted: 'Planned' }
  for (const po of pos) {
    const varianceOk = po.reconStatus === 'VARIANCE' && po.varianceApproval === 'APPROVED'
    poCol.push({ id: `po-${po.ID}`, lane: 'PO', title: po.poNumber, titleAbbreviation: 'PO', children: [`s4-${po.ID}`],
      state: varianceOk ? 'Critical' : RECON[po.reconStatus], stateText: varianceOk ? 'Variance approved' : `Reconciliation: ${po.reconStatus}`,
      texts: [`${num(po.totalAmount).toFixed(2)} ${po.currency_code ?? ''}`] })
    s4Col.push({ id: `s4-${po.ID}`, lane: 'S4', title: po.s4PONumber ?? 'Not posted', titleAbbreviation: 'S4', state: S4[po.s4Status], stateText: po.s4Status, texts: [] })
  }
  if (!pos.length) {
    poCol.push({ id: 'po-plan', lane: 'PO', title: pr.status === 'Approved' ? 'Ready to order' : 'Purchase order', titleAbbreviation: 'PO', state: 'Planned', stateText: pr.status === 'Approved' ? 'Create PO' : 'Waiting', texts: [], children: ['s4-plan'] })
    s4Col.push({ id: 's4-plan', lane: 'S4', title: 'S/4HANA posting', titleAbbreviation: 'S4', state: 'Planned', stateText: 'Waiting', texts: [] })
  }

  // Wire each column to the next one (fork into parallel nodes, join into the next column)
  const nonEmpty = columns.filter(c => c.length)
  for (let i = 0; i < nonEmpty.length - 1; i++) {
    const next = nonEmpty[i + 1].map(n => n.id)
    for (const n of nonEmpty[i]) if (!n.children) n.children = nonEmpty[i + 1][0]?.lane === 'S4' ? [] : next
  }
  return JSON.stringify({ lanes, nodes: nonEmpty.flat() })
}
