import { num, round2, today, daysAgo, dbEntities, mdEntities } from '../util.js'
import { redact } from './guard.js'
import { httpError } from './groq.js'

const HISTORY_STATUSES = ['Approved', 'Ordered', 'Closed']

/**
 * Grounding context built ONLY from application data. No personal data
 * (names, e-mails, user ids) - the requester is represented by role only.
 * Kept compact on purpose: every byte is paid in tokens.
 */
export async function buildContext(prID) {
  const { PurchaseRequisitions, PRItems, ComplianceChecks } = dbEntities()
  const { Materials, Vendors, Budgets } = mdEntities()

  const pr = await SELECT.one.from(PurchaseRequisitions).where({ ID: prID })
  if (!pr) throw httpError(404, 'PR_NOT_FOUND', `Purchase requisition ${prID} not found`)
  const items = await SELECT.from(PRItems)
    .columns('itemNo', 'material_ID', 'description', 'quantity', 'uom', 'unitPrice', 'netAmount')
    .where({ parent_ID: prID }).orderBy('itemNo')
  const mats = [...new Set(items.map(i => i.material_ID).filter(Boolean))]

  const [catalog, vendors, selected, history, checks, budget] = await Promise.all([
    mats.length ? SELECT.from(Materials).columns('ID', 'description', 'standardPrice', 'uom', 'preferredVendor_ID').where({ ID: { in: mats } }) : [],
    pr.category_code
      ? SELECT.from(Vendors).columns('ID', 'name', 'rating', 'certExpiry')
          .where({ category_code: pr.category_code, status: 'Active', certExpiry: { '>=': today() } })
          .orderBy('rating desc').limit(8)
      : [],
    pr.vendor_ID ? SELECT.one.from(Vendors).columns('ID', 'name', 'status', 'rating', 'certExpiry', 'category_code').where({ ID: pr.vendor_ID }) : null,
    mats.length
      ? SELECT.from(PRItems).columns('material_ID', 'unitPrice', 'parent.vendor_ID as vendorID')
          .where`material_ID in ${mats} and parent.ID != ${prID} and parent.status in ${HISTORY_STATUSES} and parent.submittedAt >= ${daysAgo(365)}`
          .limit(1000)
      : [],
    SELECT.from(ComplianceChecks).columns('checkType', 'result', 'message').where({ pr_ID: prID, revision: pr.revision }),
    pr.costCenter_code
      ? SELECT.one.from(Budgets).columns('amount', 'committed', 'consumed', 'currency_code')
          .where({ costCenter_code: pr.costCenter_code, fiscalYear: new Date().getFullYear() })
      : null
  ])

  // 12-month price history per material (aggregated in JS: tiny row counts)
  const hist = {}
  for (const h of history) {
    const a = (hist[h.material_ID] ??= { count: 0, sum: 0, min: Infinity, max: -Infinity, vendors: new Set() })
    const p = num(h.unitPrice)
    a.count++, (a.sum += p), (a.min = Math.min(a.min, p)), (a.max = Math.max(a.max, p))
    if (h.vendorID) a.vendors.add(h.vendorID)
  }

  return {
    pr: {
      number: pr.prNumber ?? null,
      title: redact(pr.title ?? ''),
      justification: redact(pr.justification ?? ''),
      requester: { role: 'Requester' },
      category: pr.category_code,
      costCenter: pr.costCenter_code,
      currency: pr.currency_code,
      totalAmount: round2(pr.totalAmount),
      needByDate: pr.needByDate ?? null,
      quotesObtained: num(pr.quotesObtained),
      status: pr.status,
      selectedVendor: selected
        ? { vendorID: selected.ID, name: selected.name, status: selected.status, rating: num(selected.rating), certExpiry: selected.certExpiry, category: selected.category_code }
        : null
    },
    items: items.map(i => ({
      itemNo: i.itemNo, materialID: i.material_ID ?? null, description: redact(i.description ?? ''),
      quantity: num(i.quantity), uom: i.uom, unitPrice: round2(i.unitPrice)
    })),
    catalog: catalog.map(m => ({ materialID: m.ID, description: m.description, standardPrice: round2(m.standardPrice), uom: m.uom, preferredVendorID: m.preferredVendor_ID ?? null })),
    eligibleVendors: vendors.map(v => ({ vendorID: v.ID, name: v.name, rating: num(v.rating), certExpiry: v.certExpiry })),
    priceHistory12m: Object.entries(hist).map(([materialID, a]) => ({
      materialID, count: a.count, avgPrice: round2(a.sum / a.count), minPrice: round2(a.min), maxPrice: round2(a.max), vendorIDs: [...a.vendors]
    })),
    complianceChecks: checks.map(c => ({ type: c.checkType, result: c.result, message: c.message })),
    budget: budget
      ? { amount: round2(budget.amount), available: round2(num(budget.amount) - num(budget.committed) - num(budget.consumed)), currency: budget.currency_code }
      : null
  }
}
