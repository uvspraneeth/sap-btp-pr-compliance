// PO creation, PR<->PO reconciliation and S/4 posting (in-process S/4 mock, no network).
process.env.PR_DISABLE_JOBS = '1'
import cds from '@sap/cds'
import { describe, test, before } from 'node:test'
import assert from 'node:assert/strict'
import { toS4Payload, toV2Date } from '../srv/lib/s4/po-mapper.js'
import { createPurchaseOrderFromPR } from '../srv/lib/po/create-po.js'
import { reconcilePO } from '../srv/lib/reconcile/pr-po.js'

const { POST, GET, PATCH } = cds.test(import.meta.dirname + '/..', '--with-mocks')
const grace = { auth: { username: 'grace', password: 'grace' } }
const PR = 'bbbbbbbb-0000-4000-8000-000000000001'
const PR_ITEM_1 = 'bbbbbbbb-0000-4000-8000-000000000011'
const PR_ITEM_2 = 'bbbbbbbb-0000-4000-8000-000000000012'
const system = fn => cds.tx({ user: new cds.User.Privileged('grace') }, fn)
const e = () => cds.entities('pr')

async function freshPR(ID = PR, items = [[PR_ITEM_1, 'M-LAPTOP-14', 3, 1200], [PR_ITEM_2, 'M-MONITOR-27', 2, 320]]) {
  const { PurchaseRequisitions } = e()
  const total = items.reduce((s, [, , q, p]) => s + q * p, 0)
  await system(() => INSERT.into(PurchaseRequisitions).entries({
    ID, prNumber: 'PR-26-9' + ID.slice(-5), title: 'Laptops for onboarding', requester_userId: 'grace', createdBy: 'grace',
    costCenter_code: 'CC-IT-100', category_code: 'IT', vendor_ID: 'V1001', currency_code: 'USD',
    totalAmount: total, budgetCommitted: total, status: 'Approved', revision: 1,
    items: items.map(([iid, mat, quantity, unitPrice], n) => ({
      ID: iid, itemNo: (n + 1) * 10, material_ID: mat, description: mat, quantity, uom: 'EA', unitPrice,
      netAmount: quantity * unitPrice, deliveryDate: '2026-12-15'
    }))
  }))
  return ID
}
const readPO = ID => system(() => SELECT.one.from(e().PurchaseOrders).where({ ID }))
const setItem = (poID, itemNo, data) => system(async () => {
  const { POItems, PurchaseOrders } = e()
  await UPDATE(POItems).where({ parent_ID: poID, itemNo }).with(data)
  const items = await SELECT.from(POItems).where({ parent_ID: poID })
  await UPDATE(PurchaseOrders, poID).with({ totalAmount: items.reduce((s, i) => s + Number(i.quantity) * Number(i.unitPrice), 0) })
})
const s4sync = async () => cds.unqueued(await cds.connect.to('s4sync'))

describe('S/4 payload mapper', () => {
  const po = { poNumber: 'PO-26-000001', companyCode_code: '1710', purchasingOrg: '1710', purchasingGroup: '001', plant: '1710', currency_code: 'USD', s4Supplier: '0017300001' }
  const items = [
    { itemNo: 10, description: 'Laptop 14 inch business with a very long description text', quantity: 3, uom: 'EA', unitPrice: 1200, deliveryDate: '2026-12-15', s4Material: 'TG10' },
    { itemNo: 20, description: 'Consulting', quantity: 2, uom: 'EA', unitPrice: 950.5 }
  ]
  const p = toS4Payload({ po, items, costCenter: { s4CostCenter: '0017101501', glAccount: '0050300000' } }, { dateFormat: 'v2' })

  test('header uses verified API fields and the external reference', () => {
    assert.deepEqual(
      { ...p, to_PurchaseOrderItem: undefined },
      { CompanyCode: '1710', PurchaseOrderType: 'NB', Supplier: '0017300001', PurchasingOrganization: '1710', PurchasingGroup: '001', DocumentCurrency: 'USD', CorrespncExternalReference: 'PO-26-000001', Language: 'EN', to_PurchaseOrderItem: undefined })
  })
  test('material item: decimals as strings, derived unit, schedule line with V2 date', () => {
    const [i] = p.to_PurchaseOrderItem
    assert.equal(i.PurchaseOrderItem, '00010')
    assert.equal(i.Material, 'TG10')
    assert.equal(i.OrderQuantity, '3')
    assert.equal(i.NetPriceAmount, '1200')
    assert.equal(i.PurchaseOrderItemText.length, 40)
    assert.equal(i.PurchaseOrderQuantityUnit, undefined)
    assert.equal(i.AccountAssignmentCategory, undefined)
    assert.deepEqual(i.to_ScheduleLine, [{ ScheduleLine: '0001', ScheduleLineDeliveryDate: toV2Date('2026-12-15'), ScheduleLineOrderQuantity: '3' }])
    assert.match(i.to_ScheduleLine[0].ScheduleLineDeliveryDate, /^\/Date\(\d+\)\/$/)
  })
  test('free-text item is account-assigned to the cost center', () => {
    const i = p.to_PurchaseOrderItem[1]
    assert.equal(i.Material, undefined)
    assert.equal(i.AccountAssignmentCategory, 'K')
    assert.equal(i.PurchaseOrderQuantityUnit, 'EA')
    assert.deepEqual(i.to_AccountAssignment, [{ AccountAssignmentNumber: '01', CostCenter: '0017101501', GLAccount: '0050300000', Quantity: '2' }])
    assert.equal(i.to_ScheduleLine, undefined)
  })
  test('iso date format for the local mock', () => {
    const iso = toS4Payload({ po, items: [items[0]] }, { dateFormat: 'iso' })
    assert.equal(iso.to_PurchaseOrderItem[0].to_ScheduleLine[0].ScheduleLineDeliveryDate, '2026-12-15T00:00:00Z')
  })
})

describe('PO creation and PR<->PO reconciliation', () => {
  let poID
  before(async () => { await freshPR() })

  test('creates an active PO for the open quantities and reconciles it as MATCHED', async () => {
    poID = await system(() => createPurchaseOrderFromPR(PR))
    const po = await readPO(poID)
    assert.match(po.poNumber, /^PO-\d{2}-\d{6}$/)
    assert.equal(po.poNumber.length, 12)
    assert.equal(Number(po.totalAmount), 4240)
    assert.equal(po.companyCode_code, '1710')
    assert.equal(po.purchasingOrg, '1710')
    assert.equal(po.plant, '1710')
    assert.equal(po.reconStatus, 'MATCHED')
    const pr = await system(() => SELECT.one.from(e().PurchaseRequisitions).columns('status').where({ ID: PR }))
    assert.equal(pr.status, 'Ordered')
    const items = await system(() => SELECT.from(e().PRItems).columns('ID', 'orderedQty').where({ parent_ID: PR }))
    assert.deepEqual(items.map(i => Number(i.orderedQty)).sort(), [2, 3])
  })

  test('rejects a second PO when everything is ordered (409)', async () => {
    await assert.rejects(system(() => createPurchaseOrderFromPR(PR)), err => err.status === 409)
  })

  test('small price increase within tolerance -> TOLERANCE', async () => {
    await setItem(poID, 10, { unitPrice: 1212 }) // +1% price, +0.85% total
    const { status, results } = await system(() => reconcilePO(poID))
    assert.equal(status, 'TOLERANCE')
    assert.equal(results.find(r => r.checkType === 'PRICE' && r.itemNo === 10).result, 'TOLERANCE')
  })

  test('quantity above the approved open quantity -> VARIANCE', async () => {
    await setItem(poID, 10, { unitPrice: 1200, quantity: 5 })
    const { status, results } = await system(() => reconcilePO(poID))
    assert.equal(status, 'VARIANCE')
    assert.equal(results.find(r => r.checkType === 'QTY' && r.itemNo === 10).result, 'VARIANCE')
  })

  test('vendor change -> VARIANCE; results are replaced, not appended', async () => {
    await setItem(poID, 10, { quantity: 3 })
    await system(() => UPDATE(e().PurchaseOrders, poID).with({ vendor_ID: 'V1002' }))
    const { status } = await system(() => reconcilePO(poID))
    assert.equal(status, 'VARIANCE')
    await system(() => UPDATE(e().PurchaseOrders, poID).with({ vendor_ID: 'V1001' }))
    const again = await system(() => reconcilePO(poID))
    assert.equal(again.status, 'MATCHED')
    const stored = await system(() => SELECT.from(e().ReconciliationResults).where({ po_ID: poID }))
    assert.equal(stored.length, again.results.length)
  })
})

describe('S/4HANA posting', () => {
  const PR2 = 'bbbbbbbb-0000-4000-8000-000000000002'
  let poID
  before(async () => {
    await freshPR(PR2, [['bbbbbbbb-0000-4000-8000-000000000021', 'M-DOCK', 4, 180]])
    poID = await system(() => createPurchaseOrderFromPR(PR2))
  })

  test('mock mode posts through the in-process S/4 mock and moves budget to consumed', async () => {
    const { Budgets } = cds.entities('pr.master')
    const budgetBefore = await system(() => SELECT.one.from(Budgets).where({ costCenter_code: 'CC-IT-100', fiscalYear: new Date().getFullYear() }))
    const number = await system(async () => (await s4sync()).postPO(poID))
    assert.match(number, /^45\d{8}$/)
    const po = await readPO(poID)
    assert.equal(po.s4Status, 'Posted')
    assert.equal(po.s4PONumber, number)
    assert.equal(po.s4Error, null)
    const budget = await system(() => SELECT.one.from(Budgets).where({ ID: budgetBefore.ID }))
    assert.equal(Number(budget.consumed), Number(budgetBefore.consumed) + 720)

    const s4 = await cds.connect.to('API_PURCHASEORDER_PROCESS_SRV')
    const created = await s4.run(SELECT.one.from(s4.entities.A_PurchaseOrder, h => { h('*'), h.to_PurchaseOrderItem(i => { i('*'), i.to_ScheduleLine('*') }) }).where({ PurchaseOrder: number }))
    assert.equal(created.CorrespncExternalReference, po.poNumber)
    assert.equal(created.Supplier, '0017300001')
    assert.equal(created.to_PurchaseOrderItem[0].Material, 'TG10')
    assert.equal(created.to_PurchaseOrderItem[0].to_ScheduleLine[0].PurchasingDocument, number)
  })

  test('posting is idempotent', async () => {
    const po = await readPO(poID)
    const again = await system(async () => (await s4sync()).postPO(poID))
    assert.equal(again, po.s4PONumber)
  })

  test('simulate mode never calls S/4', async () => {
    const PR3 = 'bbbbbbbb-0000-4000-8000-000000000003'
    await freshPR(PR3, [['bbbbbbbb-0000-4000-8000-000000000031', 'M-DOCK', 1, 180]])
    const id = await system(() => createPurchaseOrderFromPR(PR3))
    const mode = cds.env.pr.s4.mode
    cds.env.pr.s4.mode = 'simulate'
    try { await system(async () => (await s4sync()).postPO(id)) } finally { cds.env.pr.s4.mode = mode }
    assert.match((await readPO(id)).s4PONumber, /^SIM\d{7}$/)
  })

  test('supplier without S/4 number fails permanently with a clear message', async () => {
    const PR4 = 'bbbbbbbb-0000-4000-8000-000000000004'
    await freshPR(PR4, [['bbbbbbbb-0000-4000-8000-000000000041', 'M-DOCK', 1, 180]])
    const id = await system(() => createPurchaseOrderFromPR(PR4))
    const { Vendors } = cds.entities('pr.master')
    await system(() => UPDATE(Vendors, 'V1001').with({ s4Supplier: null }))
    try { await system(async () => (await s4sync()).postPO(id)) } finally { await system(() => UPDATE(Vendors, 'V1001').with({ s4Supplier: '0017300001' })) }
    const po = await readPO(id)
    assert.equal(po.s4Status, 'Failed')
    assert.match(po.s4Error, /no S\/4 supplier number/)
  })
})

describe('PurchasingService (OData)', () => {
  const PR5 = 'bbbbbbbb-0000-4000-8000-000000000005'
  let poID
  const action = (id, name, data = {}) => POST(`/odata/v4/purchasing/PurchaseOrders(ID=${id},IsActiveEntity=true)/PurchasingService.${name}`, data, grace)
  before(async () => {
    await freshPR(PR5, [['bbbbbbbb-0000-4000-8000-000000000051', 'M-CHAIR', 2, 450]])
    poID = await system(() => createPurchaseOrderFromPR(PR5))
  })

  test('postToS4 is refused while the PO has an unapproved variance', async () => {
    await setItem(poID, 10, { unitPrice: 600 })
    await assert.rejects(action(poID, 'postToS4'), err => err.response?.status === 409)
    await setItem(poID, 10, { unitPrice: 450 })
  })

  test('postToS4 queues the PO and the queue posts it to S/4', async () => {
    const { data } = await action(poID, 'postToS4')
    assert.equal(data.s4Status, 'Queued')
    let po
    for (let i = 0; i < 50 && (po = await readPO(poID)).s4Status === 'Queued'; i++) await new Promise(r => setTimeout(r, 100))
    assert.equal(po.s4Status, 'Posted', po.s4Error ?? '')
  })

  test('posted POs can no longer be edited or re-posted', async () => {
    await assert.rejects(action(poID, 'postToS4'), err => err.response?.status === 409)
    await assert.rejects(action(poID, 'draftEdit', { PreserveChanges: true }), err => err.response?.status === 409)
  })

  test('draft edit recalculates amounts and re-reconciles on activation', async () => {
    const PR6 = 'bbbbbbbb-0000-4000-8000-000000000006'
    await freshPR(PR6, [['bbbbbbbb-0000-4000-8000-000000000061', 'M-PAPER-A4', 10, 25]])
    const id = await system(() => createPurchaseOrderFromPR(PR6))
    const base = '/odata/v4/purchasing'
    await action(id, 'draftEdit', { PreserveChanges: true })
    const { data: items } = await GET(`${base}/PurchaseOrders(ID=${id},IsActiveEntity=false)/items`, grace)
    await PATCH(`${base}/POItems(ID=${items.value[0].ID},IsActiveEntity=false)`, { quantity: 12 }, grace)
    const { data: draft } = await GET(`${base}/PurchaseOrders(ID=${id},IsActiveEntity=false)`, grace)
    assert.equal(Number(draft.totalAmount), 300)
    await POST(`${base}/PurchaseOrders(ID=${id},IsActiveEntity=false)/PurchasingService.draftActivate`, {}, grace)
    const po = await readPO(id)
    assert.equal(Number(po.totalAmount), 300)
    assert.equal(po.reconStatus, 'VARIANCE') // 12 > 10 approved
  })

  test('reconciliation results are exposed read-only', async () => {
    const { data } = await GET(`/odata/v4/purchasing/PurchaseOrders(ID=${poID},IsActiveEntity=true)/reconResults`, grace)
    assert.ok(data.value.length >= 4)
  })
})
