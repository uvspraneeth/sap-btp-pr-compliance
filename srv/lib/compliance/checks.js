import cds from '@sap/cds'
import { num, round2, today, daysAgo, fmtAmount, settings, dbEntities, mdEntities } from '../util.js'

/**
 * Parallel compliance checks (fork). Each check is independent, reads only
 * committed master/history data and returns { result: PASS|WARN|FAIL, message }.
 * A failing check never takes the others down (errors become FAIL results).
 */
export async function runComplianceChecks(pr, items) {
  const s = await settings()
  const ctx = { pr, items, s }
  return Promise.all([
    timed('BUDGET', () => budgetCheck(ctx)),
    timed('VENDOR', () => vendorCheck(ctx)),
    timed('POLICY', () => policyCheck(ctx)),
    timed('DUPLICATE', () => duplicateCheck(ctx))
  ])
}

/** Join rule: any FAIL blocks, any WARN proceeds flagged, else PASS */
export function reconcileChecks(results) {
  if (results.some(r => r.result === 'FAIL')) return 'BLOCK'
  if (results.some(r => r.result === 'WARN')) return 'WARN'
  return 'PASS'
}

const RANK = { PASS: 0, WARN: 1, FAIL: 2 }
const worst = findings => findings.reduce((w, f) => (RANK[f.result] > RANK[w] ? f.result : w), 'PASS')
const summarize = (findings, okMessage) => {
  const issues = findings.filter(f => f.result !== 'PASS')
  return { result: worst(findings), message: (issues.length ? issues.map(f => f.message).join(' | ') : okMessage).slice(0, 500) }
}

async function timed(checkType, fn) {
  const t0 = Date.now()
  try {
    return { checkType, ...(await fn()), durationMs: Date.now() - t0 }
  } catch (e) {
    cds.log('compliance').error(`${checkType} check failed`, e)
    return { checkType, result: 'FAIL', message: `Check could not be executed: ${e.message}`.slice(0, 500), durationMs: Date.now() - t0 }
  }
}

// ---------------------------------------------------------------------------
async function budgetCheck({ pr }) {
  const { Budgets } = mdEntities()
  const fiscalYear = new Date().getFullYear()
  const budget = await SELECT.one.from(Budgets).where({ costCenter_code: pr.costCenter_code, fiscalYear })
  if (!budget) return { result: 'FAIL', message: `No ${fiscalYear} budget for cost center ${pr.costCenter_code}` }
  const available = round2(num(budget.amount) - num(budget.committed) - num(budget.consumed))
  const total = num(pr.totalAmount)
  if (total > available)
    return { result: 'FAIL', message: `Insufficient budget: requested ${fmtAmount(total, pr.currency_code)}, available ${fmtAmount(available, budget.currency_code)}` }
  const remainingPct = num(budget.amount) ? ((available - total) / num(budget.amount)) * 100 : 0
  if (remainingPct < 10)
    return { result: 'WARN', message: `Budget nearly exhausted: only ${remainingPct.toFixed(1)}% left after this PR` }
  return { result: 'PASS', message: `Budget available: ${fmtAmount(available, budget.currency_code)}` }
}

async function vendorCheck({ pr }) {
  if (!pr.vendor_ID) return { result: 'FAIL', message: 'No vendor selected' }
  const { Vendors } = mdEntities()
  const v = await SELECT.one.from(Vendors).where({ ID: pr.vendor_ID })
  if (!v) return { result: 'FAIL', message: `Vendor ${pr.vendor_ID} does not exist` }
  const findings = []
  if (v.status !== 'Active') findings.push({ result: 'FAIL', message: `Vendor ${v.name} is ${v.status}` })
  if (!v.certExpiry || v.certExpiry < today()) findings.push({ result: 'FAIL', message: `Vendor compliance certificate expired (${v.certExpiry ?? 'missing'})` })
  else if (v.certExpiry < daysAgo(-30).slice(0, 10)) findings.push({ result: 'WARN', message: `Vendor certificate expires on ${v.certExpiry}` })
  if (pr.category_code && v.category_code !== pr.category_code) findings.push({ result: 'WARN', message: `Vendor not approved for category ${pr.category_code}` })
  if (num(v.rating) < 3) findings.push({ result: 'WARN', message: `Low vendor rating (${v.rating})` })
  return summarize(findings, `Vendor ${v.name} is active and certified`)
}

async function policyCheck({ pr, items, s }) {
  const { Materials } = mdEntities()
  const { PurchaseRequisitions } = dbEntities()
  const findings = []
  const total = num(pr.totalAmount)

  // Price vs catalog
  const matIds = [...new Set(items.map(i => i.material_ID).filter(Boolean))]
  const materials = matIds.length ? await SELECT.from(Materials).columns('ID', 'standardPrice').where({ ID: { in: matIds } }) : []
  const std = Object.fromEntries(materials.map(m => [m.ID, num(m.standardPrice)]))
  for (const i of items) {
    if (!i.material_ID) { findings.push({ result: 'WARN', message: `Item ${i.itemNo}: free-text item without catalog price` }); continue }
    const ref = std[i.material_ID]
    if (!ref) continue
    const pct = ((num(i.unitPrice) - ref) / ref) * 100
    if (pct > s.PRICE_FAIL_PCT) findings.push({ result: 'FAIL', message: `Item ${i.itemNo}: price ${pct.toFixed(0)}% above catalog` })
    else if (pct > s.PRICE_WARN_PCT) findings.push({ result: 'WARN', message: `Item ${i.itemNo}: price ${pct.toFixed(0)}% above catalog` })
  }

  // Justification and quotes
  if (total >= s.JUSTIFICATION_MIN_AMOUNT && (pr.justification ?? '').trim().length < 30)
    findings.push({ result: 'FAIL', message: `Business justification (min. 30 characters) required from ${fmtAmount(s.JUSTIFICATION_MIN_AMOUNT, pr.currency_code)}` })
  if (total >= s.QUOTES_MIN_AMOUNT && num(pr.quotesObtained) < 3)
    findings.push({ result: 'FAIL', message: `At least 3 quotes required from ${fmtAmount(s.QUOTES_MIN_AMOUNT, pr.currency_code)}` })

  // Split-purchase detection: same requester + vendor within the window
  if (pr.vendor_ID && total < s.SPLIT_THRESHOLD) {
    const since = daysAgo(s.SPLIT_WINDOW_DAYS)
    const agg = await SELECT.one.from(PurchaseRequisitions).columns('sum(totalAmount) as sum', 'count(1) as cnt')
      .where`requester_userId = ${pr.requester_userId} and vendor_ID = ${pr.vendor_ID} and ID != ${pr.ID}
             and submittedAt >= ${since} and status not in ('Draft','Withdrawn','Rejected')`
    const combined = num(agg?.sum) + total
    if (num(agg?.cnt) > 0 && combined >= s.SPLIT_THRESHOLD)
      findings.push({ result: 'WARN', message: `Possible split purchase: ${agg.cnt} other PR(s) to the same vendor in ${s.SPLIT_WINDOW_DAYS} days (combined ${fmtAmount(combined, pr.currency_code)})` })
  }
  return summarize(findings, 'Prices, justification and quotes comply with policy')
}

async function duplicateCheck({ pr, items, s }) {
  const { PRItems } = dbEntities()
  const mats = [...new Set(items.map(i => i.material_ID).filter(Boolean))]
  if (!mats.length) return { result: 'PASS', message: 'No catalog items to compare' }
  const since = daysAgo(s.DUP_WINDOW_DAYS)
  const dups = await SELECT.from(PRItems).columns('parent.prNumber as prNumber', 'material_ID')
    .where`material_ID in ${mats} and parent.requester_userId = ${pr.requester_userId} and parent.ID != ${pr.ID}
           and parent.submittedAt >= ${since} and parent.status not in ('Draft','Withdrawn','Rejected')`
  if (!dups.length) return { result: 'PASS', message: `No similar requests in the last ${s.DUP_WINDOW_DAYS} days` }
  const numbers = [...new Set(dups.map(d => d.prNumber))].slice(0, 5)
  return { result: 'WARN', message: `Possible duplicate of ${numbers.join(', ')} (same material within ${s.DUP_WINDOW_DAYS} days)` }
}
