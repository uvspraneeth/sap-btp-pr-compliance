import cds from '@sap/cds'
import { reconcilePO } from './lib/reconcile/pr-po.js'
import { num, round2, logEvent, dbEntities } from './lib/util.js'

const keyOf = req => {
  const last = req.params?.at(-1)
  return last?.ID ?? (typeof last === 'string' ? last : req.data?.ID)
}
const LOCKED = { Posted: 'is already posted to S/4HANA', Queued: 'is being posted to S/4HANA' }

export default class PurchasingService extends cds.ApplicationService {
  init() {
    const { PurchaseOrders, POItems } = this.entities
    const db = dbEntities()

    const readPO = async ID => {
      const po = await SELECT.one.from(db.PurchaseOrders).where({ ID })
      return po && { ...po, IsActiveEntity: true, HasActiveEntity: false, HasDraftEntity: false }
    }
    const guardLocked = async (req, ID) => {
      const po = await SELECT.one.from(db.PurchaseOrders).columns('poNumber', 's4Status').where({ ID })
      if (po && LOCKED[po.s4Status]) req.reject(409, `${po.poNumber} ${LOCKED[po.s4Status]} and can no longer be changed`)
    }
    const recalcDraftTotal = async parent_ID => {
      if (!parent_ID) return
      const agg = await SELECT.one.from(POItems.drafts).columns('sum(netAmount) as total').where({ parent_ID })
      await UPDATE(PurchaseOrders.drafts, parent_ID).with({ totalAmount: round2(agg?.total) })
    }

    // ---- draft editing -----------------------------------------------------
    this.before('EDIT', PurchaseOrders, req => guardLocked(req, keyOf(req)))
    this.before('SAVE', PurchaseOrders, async req => {
      await guardLocked(req, req.data.ID) // a draft opened before posting must not be activated afterwards
      const items = req.data.items ?? []
      for (const i of items) i.netAmount = round2(num(i.quantity) * num(i.unitPrice))
      req.data.totalAmount = round2(items.reduce((s, i) => s + i.netAmount, 0))
    })
    this.after('SAVE', PurchaseOrders, async (res, req) => {
      await reconcilePO(res?.ID ?? req.data.ID, { resetVarianceApproval: true }) // edits invalidate a variance approval
    })

    this.before('NEW', POItems.drafts, async req => {
      const agg = await SELECT.one.from(POItems.drafts).columns('max(itemNo) as max').where({ parent_ID: req.data.parent_ID })
      req.data.itemNo ??= num(agg?.max) + 10
    })
    this.before('PATCH', POItems.drafts, async req => {
      if (!('quantity' in req.data) && !('unitPrice' in req.data)) return
      const cur = await SELECT.one.from(POItems.drafts).columns('quantity', 'unitPrice').where({ ID: req.data.ID })
      const qty = 'quantity' in req.data ? req.data.quantity : cur?.quantity
      const price = 'unitPrice' in req.data ? req.data.unitPrice : cur?.unitPrice
      req.data.netAmount = round2(num(qty) * num(price))
    })
    this.after('PATCH', POItems.drafts, async (_, req) => {
      const item = await SELECT.one.from(POItems.drafts).columns('parent_ID').where({ ID: req.data.ID })
      await recalcDraftTotal(item?.parent_ID)
    })
    this.before('DELETE', POItems.drafts, async req => {
      const item = await SELECT.one.from(POItems.drafts).columns('parent_ID').where({ ID: keyOf(req) })
      req._poDraftParent = item?.parent_ID
    })
    this.after('DELETE', POItems.drafts, (_, req) => recalcDraftTotal(req._poDraftParent))

    // ---- actions -------------------------------------------------------------
    this.on('reconcile', PurchaseOrders, async req => {
      const ID = keyOf(req)
      await reconcilePO(ID)
      return readPO(ID)
    })

    this.on('requestVarianceApproval', PurchaseOrders, async req => {
      const ID = keyOf(req)
      const po = await SELECT.one.from(db.PurchaseOrders).where({ ID }).forUpdate()
      if (!po) return req.reject(404, 'Purchase order not found')
      if (po.reconStatus !== 'VARIANCE') return req.reject(409, 'Variance approval is only required when reconciliation reports a variance')
      if (po.varianceApproval === 'PENDING') return req.reject(409, `Variance approval for ${po.poNumber} is already pending`)
      await UPDATE(db.PurchaseOrders, ID).with({ varianceApproval: 'PENDING' })
      await logEvent({ pr_ID: po.pr_ID, po_ID: ID, type: 'VARIANCE_REQUESTED', message: (req.data.reason ?? '').slice(0, 500) })
      const { startApproval } = await import('./lib/workflow/engine.js')
      await startApproval({ kind: 'VARIANCE', poID: ID, prID: po.pr_ID })
      return readPO(ID)
    })

    this.on('postToS4', PurchaseOrders, async req => {
      const ID = keyOf(req)
      const po = await SELECT.one.from(db.PurchaseOrders).where({ ID }).forUpdate()
      if (!po) return req.reject(404, 'Purchase order not found')
      if (LOCKED[po.s4Status]) return req.reject(409, `${po.poNumber} ${LOCKED[po.s4Status]}`)
      const { status } = await reconcilePO(ID)
      const allowed = status === 'MATCHED' || status === 'TOLERANCE' || (status === 'VARIANCE' && po.varianceApproval === 'APPROVED')
      if (!allowed) return req.reject(409, status === 'VARIANCE'
        ? `${po.poNumber} deviates from the approved requisition - adjust the PO or request a variance approval`
        : `${po.poNumber} cannot be posted with reconciliation status ${status}`)
      await UPDATE(db.PurchaseOrders, ID).with({ s4Status: 'Queued', s4Error: null })
      await logEvent({ pr_ID: po.pr_ID, po_ID: ID, type: 'PO_QUEUED', message: `${po.poNumber} queued for S/4HANA posting` })
      await (await cds.connect.to('s4sync')).send('postPO', { poID: ID })
      if (status === 'TOLERANCE') req.info(`${po.poNumber} is within tolerance of the approved requisition`)
      return readPO(ID)
    })

    return super.init()
  }
}
