import cds from '@sap/cds'
import { num, round2, fmtAmount, settings, logEvent, dbEntities } from '../util.js'

/**
 * PR <-> PO reconciliation (parallel pattern 3). Header and line checks run
 * in parallel against the approved PR; overall result = worst finding.
 * MATCHED -> post allowed, TOLERANCE -> allowed with warning, VARIANCE -> blocked
 * until fixed or approved via variance approval.
 */
const RANK = { MATCHED: 0, TOLERANCE: 1, VARIANCE: 2 }
const EPS = 0.005

export const fail = (status, message) => { throw Object.assign(new Error(message), { status }) }

/** Quantity already ordered per PR item across all POs of the PR (optionally excluding one PO) */
export async function orderedQtyByPRItem(prID, excludePO) {
  const { POItems } = dbEntities()
  const q = SELECT.from(POItems).columns('prItem_ID', 'sum(quantity) as qty').groupBy('prItem_ID')
  const rows = await (excludePO ? q.where`parent.pr_ID = ${prID} and parent_ID != ${excludePO}` : q.where`parent.pr_ID = ${prID}`)
  return Object.fromEntries(rows.filter(r => r.prItem_ID).map(r => [r.prItem_ID, num(r.qty)]))
}

/** Keeps PRItems.orderedQty in sync with all POs of the PR */
export async function syncOrderedQty(prID) {
  const { PRItems } = dbEntities()
  const ordered = await orderedQtyByPRItem(prID)
  const items = await SELECT.from(PRItems).columns('ID', 'orderedQty').where({ parent_ID: prID })
  await Promise.all(items.filter(i => num(i.orderedQty) !== (ordered[i.ID] ?? 0))
    .map(i => UPDATE(PRItems, i.ID).with({ orderedQty: ordered[i.ID] ?? 0 })))
}

// band(actual, limit, tolerancePct) -> MATCHED (<= limit) | TOLERANCE (<= limit + tol) | VARIANCE
const band = (actual, limit, tolPct) =>
  actual <= limit + EPS ? 'MATCHED' : actual <= limit * (1 + tolPct / 100) + EPS ? 'TOLERANCE' : 'VARIANCE'

export async function reconcilePO(poID, { resetVarianceApproval = false } = {}) {
  const { PurchaseOrders, POItems, PurchaseRequisitions, PRItems, ReconciliationResults } = dbEntities()
  const po = await SELECT.one.from(PurchaseOrders).where({ ID: poID })
  if (!po) fail(404, `Purchase order ${poID} not found`)

  const [pr, poItems, prItems, others, orderedElsewhere, s] = await Promise.all([
    SELECT.one.from(PurchaseRequisitions).where({ ID: po.pr_ID }),
    SELECT.from(POItems).where({ parent_ID: poID }).orderBy('itemNo'),
    SELECT.from(PRItems).where({ parent_ID: po.pr_ID }),
    SELECT.one.from(PurchaseOrders).columns('sum(totalAmount) as total').where({ pr_ID: po.pr_ID, ID: { '!=': poID } }),
    orderedQtyByPRItem(po.pr_ID, poID),
    settings()
  ])
  if (!pr) fail(409, `Purchase order ${po.poNumber} is not linked to a purchase requisition`)

  const cur = po.currency_code
  const r = (checkType, result, expected, actual, message, itemNo = null) => ({
    po_ID: poID, itemNo, checkType, result,
    expected: String(expected ?? '').slice(0, 60), actual: String(actual ?? '').slice(0, 60), message: message.slice(0, 300)
  })
  const prItemById = new Map(prItems.map(i => [i.ID, i]))
  const cumulative = round2(num(others?.total) + num(po.totalAmount))

  const header = [
    async () => po.vendor_ID === pr.vendor_ID
      ? r('VENDOR', 'MATCHED', pr.vendor_ID, po.vendor_ID, 'Vendor matches approved PR')
      : r('VENDOR', 'VARIANCE', pr.vendor_ID, po.vendor_ID, 'Vendor differs from the vendor approved on the PR'),
    async () => {
      const result = band(cumulative, num(pr.totalAmount), num(s.PO_TOTAL_TOL_PCT))
      return r('TOTAL', result, fmtAmount(pr.totalAmount, cur), fmtAmount(cumulative, cur), {
        MATCHED: 'Ordered total within approved PR total',
        TOLERANCE: `Ordered total exceeds approved PR total within ${s.PO_TOTAL_TOL_PCT}% tolerance`,
        VARIANCE: `Ordered total exceeds approved PR total by more than ${s.PO_TOTAL_TOL_PCT}%`
      }[result])
    },
    async () => {
      const result = band(cumulative, num(pr.budgetCommitted), num(s.PO_TOTAL_TOL_PCT))
      return r('BUDGET', result, fmtAmount(pr.budgetCommitted, cur), fmtAmount(cumulative, cur), {
        MATCHED: 'Covered by the budget committed at approval',
        TOLERANCE: 'Slightly above committed budget (within tolerance)',
        VARIANCE: 'Exceeds the budget committed at approval'
      }[result])
    },
    async () => poItems.length ? null : r('ITEMS', 'VARIANCE', '>= 1', 0, 'Purchase order has no items')
  ]

  const lines = poItems.map(i => async () => {
    const p = prItemById.get(i.prItem_ID)
    if (!p) return [r('PRITEM', 'VARIANCE', '-', i.description, `Item ${i.itemNo} is not on the approved PR`, i.itemNo)]
    const out = []
    if ((i.material_ID ?? null) !== (p.material_ID ?? null))
      out.push(r('MATERIAL', 'VARIANCE', p.material_ID, i.material_ID, `Item ${i.itemNo}: material differs from PR item ${p.itemNo}`, i.itemNo))
    const remaining = round2(num(p.quantity) - (orderedElsewhere[p.ID] ?? 0))
    out.push(num(i.quantity) <= remaining + EPS
      ? r('QTY', 'MATCHED', remaining, num(i.quantity), `Item ${i.itemNo}: quantity within approved open quantity`, i.itemNo)
      : r('QTY', 'VARIANCE', remaining, num(i.quantity), `Item ${i.itemNo}: quantity exceeds approved open quantity`, i.itemNo))
    const price = band(num(i.unitPrice), num(p.unitPrice), num(s.PO_PRICE_TOL_PCT))
    out.push(r('PRICE', price, num(p.unitPrice), num(i.unitPrice), {
      MATCHED: `Item ${i.itemNo}: price within approved price`,
      TOLERANCE: `Item ${i.itemNo}: price above approved price within ${s.PO_PRICE_TOL_PCT}% tolerance`,
      VARIANCE: `Item ${i.itemNo}: price exceeds approved price by more than ${s.PO_PRICE_TOL_PCT}%`
    }[price], i.itemNo))
    return out
  })

  const results = (await Promise.all([...header, ...lines].map(fn => fn()))).flat().filter(Boolean)
  const status = results.reduce((w, x) => (RANK[x.result] > RANK[w] ? x.result : w), 'MATCHED')

  await DELETE.from(ReconciliationResults).where({ po_ID: poID })
  if (results.length) await INSERT.into(ReconciliationResults).entries(results)
  await UPDATE(PurchaseOrders, poID).with({
    reconStatus: status,
    ...(resetVarianceApproval && status === 'VARIANCE' && po.varianceApproval !== 'NONE' && { varianceApproval: 'NONE' })
  })
  await syncOrderedQty(po.pr_ID)

  const count = k => results.filter(x => x.result === k).length
  await logEvent({
    pr_ID: po.pr_ID, po_ID: poID, type: 'PO_RECONCILED',
    message: `${po.poNumber}: ${status} (${count('MATCHED')} matched, ${count('TOLERANCE')} tolerance, ${count('VARIANCE')} variance)`
  })
  cds.log('reconcile').debug(po.poNumber, status)
  return { status, results }
}
