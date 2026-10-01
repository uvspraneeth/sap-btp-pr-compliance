import cds from '@sap/cds'
import { num, round2, fmtAmount, nextNumber, logEvent, dbEntities, mdEntities } from '../util.js'
import { reconcilePO, orderedQtyByPRItem, fail } from '../reconcile/pr-po.js'

/**
 * Creates an ACTIVE Purchase Order for the open quantities of an approved PR
 * (partial POs supported) and reconciles it immediately. Returns the PO ID.
 */
export async function createPurchaseOrderFromPR(prID) {
  const { PurchaseRequisitions, PRItems, PurchaseOrders } = dbEntities()
  const { CostCenters, CompanyCodes } = mdEntities()

  const pr = await SELECT.one.from(PurchaseRequisitions).where({ ID: prID }).forUpdate()
  if (!pr) fail(404, `Purchase requisition ${prID} not found`)
  if (!['Approved', 'Ordered'].includes(pr.status))
    fail(409, `A purchase order can only be created for an approved requisition (${pr.prNumber} is ${pr.status})`)

  const [items, ordered, cc] = await Promise.all([
    SELECT.from(PRItems).where({ parent_ID: prID }).orderBy('itemNo'),
    orderedQtyByPRItem(prID),
    SELECT.one.from(CostCenters).where({ code: pr.costCenter_code })
  ])
  const company = cc?.companyCode_code && await SELECT.one.from(CompanyCodes).where({ code: cc.companyCode_code })
  if (!company) fail(422, `No company code maintained for cost center ${pr.costCenter_code}`)

  const open = items
    .map(i => ({ i, qty: round2(num(i.quantity) - (ordered[i.ID] ?? 0)) }))
    .filter(l => l.qty > 0)
  if (!open.length) fail(409, `All items of ${pr.prNumber} are already fully ordered`)

  const ID = cds.utils.uuid()
  const poItems = open.map(({ i, qty }, n) => ({
    itemNo: (n + 1) * 10,
    prItem_ID: i.ID,
    material_ID: i.material_ID,
    description: i.description,
    quantity: qty,
    uom: i.uom,
    unitPrice: i.unitPrice,
    netAmount: round2(qty * num(i.unitPrice)),
    deliveryDate: i.deliveryDate
  }))
  const totalAmount = round2(poItems.reduce((s, i) => s + i.netAmount, 0))
  const poNumber = await nextNumber('PO', 'PO')
  const currency_code = pr.currency_code ?? company.currency_code

  await INSERT.into(PurchaseOrders).entries({
    ID, poNumber, pr_ID: prID, vendor_ID: pr.vendor_ID,
    companyCode_code: company.code, purchasingOrg: company.purchasingOrg, purchasingGroup: company.purchasingGroup,
    plant: company.defaultPlant, currency_code, totalAmount,
    reconStatus: 'PENDING', varianceApproval: 'NONE', s4Status: 'NotPosted',
    items: poItems
  })
  if (pr.status !== 'Ordered') await UPDATE(PurchaseRequisitions, prID).with({ status: 'Ordered' })
  await logEvent({ pr_ID: prID, po_ID: ID, type: 'PO_CREATED', message: `${poNumber} created (${fmtAmount(totalAmount, currency_code)})` })
  await reconcilePO(ID) // also syncs PRItems.orderedQty
  return ID
}
