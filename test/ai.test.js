// AI module tests: grounding context, guard, caching, rate limit - no network.
// Boots only the DB model (no services) so it runs independently of handler code.
process.env.PR_DISABLE_JOBS = '1'
import cds from '@sap/cds'
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { buildContext } from '../srv/lib/ai/context.js'
import { guardRecommendation, guardBrief, redact } from '../srv/lib/ai/guard.js'
import { checkRateLimit, resetRateLimit } from '../srv/lib/ai/groq.js'
import { getPRRecommendations, getApprovalBrief } from '../srv/lib/ai/index.js'

const root = import.meta.dirname + '/..'
const PR = 'aaaaaaaa-0000-4000-8000-000000000001'
const HIST = 'aaaaaaaa-0000-4000-8000-000000000002'
const alice = new cds.User({ id: 'alice', roles: ['Requester'] })
const asAlice = fn => cds.tx({ user: alice }, fn)

let groq, groqCalls = 0, groqReply
const reply = obj => ({ model: 'stub-model', choices: [{ message: { content: typeof obj === 'string' ? obj : JSON.stringify(obj) } }] })

before(async () => {
  await cds.deploy(root + '/db').to('sqlite::memory:')
  const { PurchaseRequisitions, ComplianceChecks } = cds.entities('pr')
  const now = new Date().toISOString()
  await INSERT.into(PurchaseRequisitions).entries([
    {
      ID: PR, prNumber: 'PR-26-000100', title: 'Laptops for new hires', requester_userId: 'alice',
      justification: 'Onboarding of 3 engineers, contact alice@example.com or +91 98765 43210',
      costCenter_code: 'CC-IT-100', category_code: 'IT', vendor_ID: 'V1001', currency_code: 'USD',
      totalAmount: 4140, status: 'InApproval', revision: 1, submittedAt: now, createdBy: 'alice',
      items: [
        { itemNo: 10, material_ID: 'M-LAPTOP-14', description: 'Laptop 14 inch', quantity: 3, uom: 'EA', unitPrice: 1260, netAmount: 3780 },
        { itemNo: 20, material_ID: 'M-DOCK', description: 'Dock', quantity: 2, uom: 'EA', unitPrice: 180, netAmount: 360 }
      ]
    },
    {
      ID: HIST, prNumber: 'PR-26-000050', title: 'Earlier laptops', requester_userId: 'bob', costCenter_code: 'CC-IT-100',
      category_code: 'IT', vendor_ID: 'V1002', currency_code: 'USD', totalAmount: 2250, status: 'Approved', revision: 1, submittedAt: now,
      items: [
        { itemNo: 10, material_ID: 'M-LAPTOP-14', quantity: 1, uom: 'EA', unitPrice: 1100, netAmount: 1100 },
        { itemNo: 20, material_ID: 'M-LAPTOP-14', quantity: 1, uom: 'EA', unitPrice: 1150, netAmount: 1150 }
      ]
    }
  ])
  await INSERT.into(ComplianceChecks).entries([
    { pr_ID: PR, revision: 1, checkType: 'POLICY', result: 'WARN', message: 'Item 10: price 5% above catalog' },
    { pr_ID: PR, revision: 1, checkType: 'BUDGET', result: 'PASS', message: 'Budget available' }
  ])

  cds.env.requires.groq.credentials = { url: 'http://groq.invalid' } // stubbed below, never called over the network
  groq = await cds.connect.to('groq')
  groq.send = async () => (groqCalls++, groqReply)
})

after(() => cds.db?.disconnect?.())

describe('grounding context', () => {
  test('contains only app data and no personal data', async () => {
    const ctx = await buildContext(PR)
    const json = JSON.stringify(ctx)
    assert.ok(!/alice|bob|@example|98765/i.test(json), 'no names, user ids, e-mails or phones')
    assert.deepEqual(ctx.pr.requester, { role: 'Requester' })
    const ids = ctx.eligibleVendors.map(v => v.vendorID)
    assert.ok(ids.includes('V1001') && ids.includes('V1002'))
    assert.ok(!ids.includes('V1004'), 'blocked vendor excluded')
    const laptop = ctx.priceHistory12m.find(h => h.materialID === 'M-LAPTOP-14')
    assert.equal(laptop.avgPrice, 1125)
    assert.deepEqual(laptop.vendorIDs, ['V1002'])
    assert.equal(ctx.catalog.find(m => m.materialID === 'M-LAPTOP-14').standardPrice, 1200)
    assert.equal(ctx.complianceChecks.length, 2)
    assert.equal(ctx.budget.available, 250000)
  })

  test('unknown PR -> 404', async () => {
    await assert.rejects(buildContext('aaaaaaaa-0000-4000-8000-00000000ffff'), { status: 404 })
  })
})

describe('guard', () => {
  let ctx
  before(async () => (ctx = await buildContext(PR)))

  test('drops foreign vendors / items and recomputes numbers', () => {
    const out = guardRecommendation(JSON.stringify({
      summary: 'Mail buyer@evil.example for details',
      vendorRecommendation: { vendorID: 'V9999', reason: 'cheapest on the market' },
      priceInsights: [
        { itemNo: 10, materialID: 'M-LAPTOP-14', historicalAvg: 1, catalogPrice: 2, requestedPrice: 3, comment: '5% above catalog' },
        { itemNo: 10, materialID: 'M-LAPTOP-14', comment: 'duplicate' },
        { itemNo: 20, materialID: 'M-OTHER', comment: 'hallucinated material' },
        { itemNo: 99, materialID: 'M-DOCK', comment: 'unknown item' }
      ],
      complianceHints: ['Obtain a second quote', 42],
      risks: ['Price above history'],
      confidence: 'very high'
    }), ctx)
    assert.equal(out.vendorRecommendation, null)
    assert.equal(out.priceInsights.length, 1)
    assert.deepEqual(out.priceInsights[0], { itemNo: 10, materialID: 'M-LAPTOP-14', requestedPrice: 1260, historicalAvg: 1125, catalogPrice: 1200, comment: '5% above catalog' })
    assert.ok(!out.summary.includes('@'))
    assert.deepEqual(out.complianceHints, ['Obtain a second quote'])
    assert.equal(out.confidence, 'low')
    assert.equal(out.grounded, true)
  })

  test('keeps eligible vendor with name taken from context', () => {
    const out = guardRecommendation({ vendorRecommendation: { vendorID: 'V1002', vendorName: 'Fake Name', reason: 'Used before' }, confidence: 'high' }, ctx)
    assert.deepEqual(out.vendorRecommendation, { vendorID: 'V1002', vendorName: 'Fabrikam Hardware', reason: 'Used before' })
    assert.equal(guardRecommendation({ vendorRecommendation: { vendorID: 'V1004' } }, ctx).vendorRecommendation, null)
  })

  test('invalid JSON -> fallback payload', () => {
    const out = guardRecommendation('Sorry, I cannot help', ctx)
    assert.equal(out.summary, 'AI response could not be validated')
    assert.equal(out.confidence, 'low')
    assert.equal(guardRecommendation('```json\n{"summary":"ok","confidence":"medium"}\n```', ctx).summary, 'ok')
  })

  test('redaction keeps dates and amounts', () => {
    assert.equal(redact('Due 2026-10-10, total 250000.00 USD'), 'Due 2026-10-10, total 250000.00 USD')
    assert.equal(redact('Call +91 98765 43210 or x@y.com'), 'Call [redacted] or [redacted]')
    assert.equal(guardBrief('{"brief":"' + 'a'.repeat(900) + '"}').length, 800)
  })
})

describe('recommendations', () => {
  test('calls Groq once, then serves the cache', async () => {
    resetRateLimit()
    groqCalls = 0
    groqReply = reply({ summary: 'Laptop price is above catalog and history.', vendorRecommendation: { vendorID: 'V1002', reason: 'Lower historical price' }, priceInsights: [{ itemNo: 10, materialID: 'M-LAPTOP-14', comment: 'Above catalog' }], confidence: 'medium' })
    const first = await asAlice(() => getPRRecommendations(PR))
    const second = await asAlice(() => getPRRecommendations(PR))
    assert.equal(groqCalls, 1)
    assert.equal(second.ID, first.ID)
    assert.equal(first.type, 'PR_ADVICE')
    assert.equal(first.model, 'stub-model')
    assert.match(first.inputHash, /^[0-9a-f]{64}$/)
    const payload = JSON.parse(first.payload)
    assert.equal(payload.vendorRecommendation.vendorName, 'Fabrikam Hardware')
    assert.equal(payload.priceInsights[0].historicalAvg, 1125)
    assert.equal(payload.grounded, true)
  })

  test('approval brief is short plain text', async () => {
    groqReply = reply({ brief: 'Three laptops for onboarding, 5% above catalog. Budget is sufficient. Contact a@b.co.' })
    const brief = await asAlice(() => getApprovalBrief(PR))
    assert.equal(typeof brief, 'string')
    assert.ok(brief.length <= 800 && !brief.includes('@'))
  })

  test('disabled / not configured -> 503', async () => {
    const { AIRecommendations } = cds.entities('pr')
    await DELETE.from(AIRecommendations) // force a live call
    cds.env.pr.ai.enabled = false
    await assert.rejects(asAlice(() => getPRRecommendations(PR)), { status: 503, code: 'AI_DISABLED' })
    cds.env.pr.ai.enabled = true
    const creds = groq.options.credentials
    groq.options.credentials = undefined
    await assert.rejects(asAlice(() => getPRRecommendations(PR)), { status: 503, code: 'AI_NOT_CONFIGURED' })
    groq.options.credentials = creds
  })

  test('provider errors map to friendly statuses', async () => {
    const send = groq.send
    groq.send = async () => { throw Object.assign(new Error('remote'), { statusCode: 502, reason: { response: { status: 429 } } }) }
    resetRateLimit()
    await assert.rejects(asAlice(() => getPRRecommendations(PR)), { status: 429 })
    groq.send = send
  })

  test('per-user rate limit', () => {
    resetRateLimit()
    const max = cds.env.pr.ai.maxPerMinute
    cds.env.pr.ai.maxPerMinute = 2
    checkRateLimit('u1'), checkRateLimit('u1'), checkRateLimit('u2')
    assert.throws(() => checkRateLimit('u1'), { status: 429 })
    cds.env.pr.ai.maxPerMinute = max
  })
})
