/**
 * Maps an app PO to the S/4HANA API_PURCHASEORDER_PROCESS_SRV deep-insert payload
 * (field names verified against the live $metadata). Pure function.
 *
 * po:    { poNumber, companyCode_code, purchasingOrg, purchasingGroup, plant, currency_code, s4Supplier }
 * items: [{ itemNo, description, quantity, uom, unitPrice, deliveryDate, s4Material }]
 * costCenter: { s4CostCenter, glAccount } - used for free-text (account-assigned) items
 * dateFormat: 'v2' -> "/Date(ms)/" (OData V2 Edm.DateTime), 'iso' -> ISO date-time (local CAP mock)
 */
const pad = (n, len) => String(n).padStart(len, '0')
const dec = v => String(Number(v ?? 0)) // Edm.Decimal travels as string in OData V2 JSON

export const toV2Date = date => `/Date(${Date.parse(`${date}T00:00:00Z`)})/`
export const toIsoDateTime = date => `${date}T00:00:00Z`

export function toS4Payload({ po, items, costCenter, s4PurchaseOrderType = 'NB' }, { dateFormat = 'v2' } = {}) {
  const fmtDate = d => (dateFormat === 'v2' ? toV2Date(d) : toIsoDateTime(d))
  return {
    CompanyCode: po.companyCode_code,
    PurchaseOrderType: s4PurchaseOrderType,
    Supplier: po.s4Supplier,
    PurchasingOrganization: po.purchasingOrg,
    PurchasingGroup: po.purchasingGroup,
    DocumentCurrency: po.currency_code,
    CorrespncExternalReference: po.poNumber, // idempotency key for retries
    Language: 'EN',
    to_PurchaseOrderItem: items.map((i, n) => {
      const item = {
        PurchaseOrderItem: pad(i.itemNo ?? (n + 1) * 10, 5),
        Plant: po.plant,
        OrderQuantity: dec(i.quantity),
        NetPriceAmount: dec(i.unitPrice),
        NetPriceQuantity: '1',
        PurchaseOrderItemText: (i.description ?? '').slice(0, 40)
      }
      if (i.s4Material) {
        item.Material = i.s4Material // unit + material group derived from the material master
      } else {
        Object.assign(item, {
          MaterialGroup: 'L001',
          PurchaseOrderQuantityUnit: i.uom,
          AccountAssignmentCategory: 'K',
          to_AccountAssignment: [{
            AccountAssignmentNumber: '01',
            CostCenter: costCenter?.s4CostCenter,
            GLAccount: costCenter?.glAccount,
            Quantity: dec(i.quantity)
          }]
        })
      }
      if (i.deliveryDate) item.to_ScheduleLine = [{
        ScheduleLine: '0001',
        ScheduleLineDeliveryDate: fmtDate(i.deliveryDate),
        ScheduleLineOrderQuantity: dec(i.quantity)
      }]
      return item
    })
  }
}
