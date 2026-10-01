import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import cds from '@sap/cds'

process.env.PR_DISABLE_JOBS = '1'
const { GET, POST, PATCH } = cds.test(import.meta.dirname + '/..', '--with-mocks')
const { sentMails } = await import('../srv/lib/mail/transport.js')

const as = user => ({ auth: { username: user, password: user } })
const PR = '/odata/v4/requisition/PurchaseRequisitions'
const PO = '/odata/v4/purchasing/PurchaseOrders'
const TASKS = '/odata/v4/approval/MyTasks'
const until = async (fn, ms = 8000) => {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await new Promise(r => setTimeout(r, 100))) { const v = await fn(); if (v) return v }
  assert.fail('condition not reached in time')
}

async function approvedPR({ quantity = 2 } = {}) {
  const { data: d } = await POST(PR, { title: 'Monitors for design team', category_code: 'IT', vendor_ID: 'V1002', justification: 'Second screens for the new UX team members' }, as('alice'))
  await POST(`${PR}(ID=${d.ID},IsActiveEntity=false)/items`, { material_ID: 'M-MONITOR-27', quantity }, as('alice'))
  await POST(`${PR}(ID=${d.ID},IsActiveEntity=false)/RequisitionService.draftActivate`, {}, as('alice'))
  await POST(`${PR}(ID=${d.ID},IsActiveEntity=true)/RequisitionService.submit`, {}, as('alice'))
  for (const u of ['bob', 'carol', 'dan', 'erin'])
    for (const t of (await GET(`${TASKS}?$filter=status eq 'Pending' and prID eq ${d.ID}`, as(u))).data.value)
      await POST(`${TASKS}(${t.ID})/ApprovalService.approve`, {}, as(u))
  return d.ID
}
const readPO = async ID => (await GET(`${PO}(ID=${ID},IsActiveEntity=true)?$expand=reconResults`, as('alice'))).data

describe('end-to-end', () => {
  test('Outlook link: GET confirms without side effects, POST decides once', async () => {
    const { data: d } = await POST(PR, { title: 'Docking stations', category_code: 'IT', vendor_ID: 'V1001', justification: 'Hot-desking setup for the new floor' }, as('alice'))
    await POST(`${PR}(ID=${d.ID},IsActiveEntity=false)/items`, { material_ID: 'M-DOCK', quantity: 3 }, as('alice'))
    await POST(`${PR}(ID=${d.ID},IsActiveEntity=false)/RequisitionService.draftActivate`, {}, as('alice'))
    const { data: pr } = await POST(`${PR}(ID=${d.ID},IsActiveEntity=true)/RequisitionService.submit`, {}, as('alice'))

    const mail = await until(() => sentMails.find(m => m.to === 'bob@example.com' && m.subject.includes(pr.prNumber)))
    const approveLink = mail.links.find(l => l.includes('/email-action?t=') && mail.html.includes('Approve'))
    const path = approveLink.slice(approveLink.indexOf('/email-action'))

    const page = await GET(path, as('bob'))
    assert.equal(page.status, 200)
    const [, f] = page.data.match(/name="f" value="([^"]+)"/)
    const [, t] = page.data.match(/name="t" value="([^"]+)"/)
    const pending = (await GET(`${TASKS}?$filter=prID eq ${d.ID}`, as('bob'))).data.value[0]
    assert.equal(pending.status, 'Pending', 'GET (e.g. Safe Links prefetch) must not decide')

    const form = new URLSearchParams({ t, f, comment: 'Approved from Outlook' }).toString()
    const cfg = { ...as('bob'), headers: { 'content-type': 'application/x-www-form-urlencoded' } }
    const done = await POST('/email-action', form, cfg)
    assert.equal(done.status, 200)
    const task = (await GET(`${TASKS}(${pending.ID})`, as('bob'))).data
    assert.equal(task.status, 'Approved')
    assert.equal(task.decidedVia, 'EMAIL')

    await assert.rejects(POST('/email-action', form, cfg), e => e.response?.status === 409, 'link is single-use')
    await assert.rejects(GET(path, as('carol')), e => [403, 409].includes(e.response?.status), 'only the assigned approver')
  })

  test('approved PR -> PO (MATCHED) -> posted to S/4 mock; budget moves from committed to consumed', async () => {
    const prID = await approvedPR()
    const budget = () => SELECT.one.from('pr.master.Budgets').where({ costCenter_code: 'CC-IT-100' })
    const b0 = await budget()

    const { data: po } = await POST(`${PR}(ID=${prID},IsActiveEntity=true)/RequisitionService.createPurchaseOrder`, {}, as('alice'))
    assert.match(po.poNumber, /^PO-\d{2}-\d{6}$/)
    assert.equal(po.reconStatus, 'MATCHED')
    assert.equal((await GET(`${PR}(ID=${prID},IsActiveEntity=true)`, as('alice'))).data.status, 'Ordered')

    const { data: queued } = await POST(`${PO}(ID=${po.ID},IsActiveEntity=true)/PurchasingService.postToS4`, {}, as('alice'))
    assert.equal(queued.s4Status, 'Queued')
    const posted = await until(async () => { const p = await readPO(po.ID); return p.s4Status === 'Posted' && p })
    assert.match(posted.s4PONumber, /^45\d{8}$/)

    const b1 = await budget()
    assert.equal(Number(b1.consumed) - Number(b0.consumed), 640)
    assert.equal(Number(b0.committed) - Number(b1.committed), 640)
  })

  test('price variance blocks posting until the variance approval (same engine) approves it', async () => {
    const prID = await approvedPR({ quantity: 1 })
    const { data: po } = await POST(`${PR}(ID=${prID},IsActiveEntity=true)/RequisitionService.createPurchaseOrder`, {}, as('alice'))

    // Buyer edits the PO: +20% unit price (tolerance is 5%)
    await POST(`${PO}(ID=${po.ID},IsActiveEntity=true)/PurchasingService.draftEdit`, { PreserveChanges: true }, as('alice'))
    const { data: items } = await GET(`${PO}(ID=${po.ID},IsActiveEntity=false)/items`, as('alice'))
    await PATCH(`/odata/v4/purchasing/POItems(ID=${items.value[0].ID},IsActiveEntity=false)`, { unitPrice: 384 }, as('alice'))
    await POST(`${PO}(ID=${po.ID},IsActiveEntity=false)/PurchasingService.draftActivate`, {}, as('alice'))
    let current = await readPO(po.ID)
    assert.equal(current.reconStatus, 'VARIANCE')
    assert.ok(current.reconResults.some(r => r.checkType === 'PRICE' && r.result === 'VARIANCE'))

    await assert.rejects(POST(`${PO}(ID=${po.ID},IsActiveEntity=true)/PurchasingService.postToS4`, {}, as('alice')), e => e.response?.status === 409)

    await POST(`${PO}(ID=${po.ID},IsActiveEntity=true)/PurchasingService.requestVarianceApproval`, { reason: 'Supplier price increase' }, as('alice'))
    const [task] = (await GET(`${TASKS}?$filter=status eq 'Pending' and kind eq 'VARIANCE'`, as('carol'))).data.value
    assert.ok(task, 'variance review routed to Finance & Procurement')
    await POST(`${TASKS}(${task.ID})/ApprovalService.approve`, { comment: 'Accepted' }, as('carol'))
    current = await readPO(po.ID)
    assert.equal(current.varianceApproval, 'APPROVED')

    await POST(`${PO}(ID=${po.ID},IsActiveEntity=true)/PurchasingService.postToS4`, {}, as('alice'))
    await until(async () => (await readPO(po.ID)).s4Status === 'Posted')
  })
})
