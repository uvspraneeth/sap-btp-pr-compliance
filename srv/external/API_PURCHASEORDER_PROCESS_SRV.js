import cds from '@sap/cds'

/**
 * Local mock of the S/4HANA Purchase Order API (used by `cds watch` / tests
 * when no S4HANA destination is bound). Mimics S/4 number assignment and
 * key propagation into the deep-insert children.
 */
export default class S4PurchaseOrderMock extends cds.ApplicationService {
  init() {
    let next = 4500000000
    this.before('CREATE', 'A_PurchaseOrder', req => {
      const po = req.data
      if (!po.Supplier) return req.error(400, 'Supplier is required')
      po.PurchaseOrder = String(++next)
      for (const [i, item] of (po.to_PurchaseOrderItem ?? []).entries()) {
        item.PurchaseOrder = po.PurchaseOrder
        item.PurchaseOrderItem ??= String((i + 1) * 10).padStart(5, '0')
        for (const aa of item.to_AccountAssignment ?? []) Object.assign(aa, { PurchaseOrder: po.PurchaseOrder, PurchaseOrderItem: item.PurchaseOrderItem })
        for (const sl of item.to_ScheduleLine ?? []) Object.assign(sl, { PurchasingDocument: po.PurchaseOrder, PurchasingDocumentItem: item.PurchaseOrderItem })
      }
    })
    return super.init()
  }
}
