import cds from '@sap/cds'
import { runComplianceChecks, reconcileChecks } from './lib/compliance/checks.js'
import { startApproval, withdraw } from './lib/workflow/engine.js'
import { buildProcessFlow } from './lib/workflow/process-flow.js'
import { num, round2, now, nextNumber, logEvent, dbEntities, mdEntities } from './lib/util.js'

const EDITABLE = ['Draft', 'Rejected', 'Blocked', 'Withdrawn']
const keyOf = req => { const p = req.params.at(-1); return typeof p === 'object' ? p.ID : p }

export default class RequisitionService extends cds.ApplicationService {
  init() {
    const { PurchaseRequisitions, PRItems, PurchaseOrders } = this.entities
    const db = dbEntities()

    // ---- Draft defaults ---------------------------------------------------
    this.before('NEW', PurchaseRequisitions.drafts, async req => {
      const { Employees } = mdEntities()
      const emp = await SELECT.one.from(Employees)
        .columns('costCenter_code', 'costCenter.companyCode.currency_code as currency')
        .where({ userId: req.user.id })
      Object.assign(req.data, {
        requester_userId: req.user.id,
        costCenter_code: req.data.costCenter_code ?? emp?.costCenter_code,
        currency_code: req.data.currency_code ?? emp?.currency ?? 'USD',
        status: 'Draft', revision: 0, totalAmount: 0
      })
    })

    this.before('NEW', PRItems.drafts, async req => {
      const parent_ID = req.data.parent_ID ?? keyOf(req)
      const last = await SELECT.one.from(PRItems.drafts).columns('max(itemNo) as max').where({ parent_ID })
      Object.assign(req.data, { itemNo: num(last?.max) + 10, quantity: req.data.quantity ?? 1 })
    })

    // Catalog defaults when a material is picked
    this.before(['NEW', 'PATCH'], PRItems.drafts, async req => {
      if (!req.data.material_ID) return
      const m = await SELECT.one.from(mdEntities().Materials).where({ ID: req.data.material_ID })
      if (m) Object.assign(req.data, { description: m.description, uom: m.uom, unitPrice: req.data.unitPrice ?? m.standardPrice })
    })

    // Running totals on the draft (side effects refresh the UI)
    this.after(['PATCH', 'NEW'], PRItems.drafts, async (result, req) => {
      const ID = result?.ID ?? req.data.ID
      const item = ID && await SELECT.one.from(PRItems.drafts).columns('ID', 'parent_ID', 'quantity', 'unitPrice').where({ ID })
      if (!item) return
      await UPDATE(PRItems.drafts, { ID: item.ID }).with({ netAmount: round2(num(item.quantity) * num(item.unitPrice)) })
      await recalcDraftTotal(item.parent_ID)
    })
    this.before('DELETE', PRItems.drafts, async req => {
      const item = await SELECT.one.from(PRItems.drafts).columns('parent_ID').where({ ID: keyOf(req) })
      req.context._prDraft = item?.parent_ID
    })
    this.after('DELETE', PRItems.drafts, (_, req) => req.context._prDraft && recalcDraftTotal(req.context._prDraft))

    const recalcDraftTotal = async parent_ID => {
      const sum = await SELECT.one.from(PRItems.drafts).columns('sum(netAmount) as total').where({ parent_ID })
      await UPDATE(PurchaseRequisitions.drafts, { ID: parent_ID }).with({ totalAmount: round2(sum?.total) })
    }

    // ---- Edit / save / delete guards ---------------------------------------
    this.before('EDIT', PurchaseRequisitions, async req => {
      const pr = await SELECT.one.from(db.PurchaseRequisitions).columns('status').where({ ID: keyOf(req) })
      if (pr && !EDITABLE.includes(pr.status)) req.reject(409, `A requisition in status "${pr.status}" can't be edited`)
    })

    this.before('SAVE', PurchaseRequisitions, req => {
      const d = req.data
      if (!d.title?.trim()) req.error(400, 'Enter a title', 'in/title')
      if (!d.costCenter_code) req.error(400, 'Select a cost center', 'in/costCenter_code')
      if (!d.category_code) req.error(400, 'Select a category', 'in/category_code')
      if (!d.vendor_ID) req.error(400, 'Select a vendor', 'in/vendor_ID')
      const items = d.items ?? []
      if (!items.length) req.error(400, 'Add at least one item', 'in/items')
      let total = 0
      for (const [i, it] of items.entries()) {
        const target = `in/items(ID=${it.ID},IsActiveEntity=false)`
        if (!(num(it.quantity) > 0)) req.error(400, 'Quantity must be greater than zero', `${target}/quantity`)
        if (num(it.unitPrice) < 0) req.error(400, 'Unit price must not be negative', `${target}/unitPrice`)
        if (!it.material_ID && !it.description?.trim()) req.error(400, 'Pick a material or describe the item', `${target}/description`)
        it.itemNo ??= (i + 1) * 10
        it.netAmount = round2(num(it.quantity) * num(it.unitPrice))
        total += it.netAmount
      }
      d.totalAmount = round2(total)
    })

    this.before('DELETE', PurchaseRequisitions, async req => {
      const pr = await SELECT.one.from(db.PurchaseRequisitions).columns('status', 'prNumber').where({ ID: keyOf(req) })
      if (pr && (pr.prNumber || pr.status !== 'Draft')) req.reject(409, 'Submitted requisitions are kept for audit and cannot be deleted')
    })

    // ---- Actions ----------------------------------------------------------
    this.on('submit', PurchaseRequisitions, async req => {
      const ID = keyOf(req)
      const pr = await SELECT.one.from(db.PurchaseRequisitions).where({ ID }).forUpdate()
      if (!pr) return req.reject(404, 'Requisition not found')
      if (!EDITABLE.includes(pr.status)) return req.reject(409, `A requisition in status "${pr.status}" can't be submitted`)
      if (await SELECT.one.from(PurchaseRequisitions.drafts).columns('ID').where({ ID }))
        return req.reject(409, 'Save or discard your pending changes before submitting')
      const items = await SELECT.from(db.PRItems).where({ parent_ID: ID }).orderBy('itemNo')
      if (!items.length) return req.reject(400, 'Add at least one item before submitting')

      Object.assign(pr, { revision: num(pr.revision) + 1, prNumber: pr.prNumber ?? await nextNumber('PR', 'PR'), submittedAt: now() })
      await UPDATE(db.PurchaseRequisitions, ID).with({
        revision: pr.revision, prNumber: pr.prNumber, submittedAt: pr.submittedAt,
        status: 'Submitted', currentLevel: 0, complianceOutcome: null, decidedAt: null
      })
      await logEvent({ pr_ID: ID, type: 'SUBMITTED', message: `Revision ${pr.revision}` })

      // Parallel compliance checks (fork) -> reconciliation (join)
      const results = await runComplianceChecks(pr, items)
      await INSERT.into(db.ComplianceChecks).entries(results.map(r => ({ ...r, pr_ID: ID, revision: pr.revision })))
      const outcome = reconcileChecks(results)
      await UPDATE(db.PurchaseRequisitions, ID).with({ complianceOutcome: outcome })
      await logEvent({ pr_ID: ID, type: 'CHECKS_RECONCILED', message: `${outcome}: ${results.map(r => `${r.checkType}=${r.result}`).join(', ')}` })

      if (outcome === 'BLOCK') {
        await UPDATE(db.PurchaseRequisitions, ID).with({ status: 'Blocked' })
        await logEvent({ pr_ID: ID, type: 'BLOCKED', message: 'Compliance checks failed' })
        for (const r of results.filter(r => r.result === 'FAIL')) req.warn(`${r.checkType}: ${r.message}`)
      } else {
        for (const r of results.filter(r => r.result === 'WARN')) req.info(`${r.checkType}: ${r.message}`)
        await startApproval({ prID: ID })
      }
      return this._readPR(ID)
    })

    this.on('withdraw', PurchaseRequisitions, async req => {
      const ID = keyOf(req)
      await withdraw({ prID: ID, reason: req.data.reason })
      return this._readPR(ID)
    })

    this.on('createPurchaseOrder', PurchaseRequisitions, async req => {
      const { createPurchaseOrderFromPR } = await import('./lib/po/create-po.js')
      const poID = await createPurchaseOrderFromPR(keyOf(req))
      return SELECT.one.from(PurchaseOrders).where({ ID: poID })
    })

    this.on('getRecommendations', PurchaseRequisitions, async req => {
      const { getPRRecommendations } = await import('./lib/ai/index.js')
      return getPRRecommendations(keyOf(req))
    })

    this.on('getProcessFlow', PurchaseRequisitions, req => buildProcessFlow(keyOf(req)))

    return super.init()
  }

  _readPR(ID) { // through the service so lean draft adds IsActiveEntity & co.
    return this.run(SELECT.one.from(this.entities.PurchaseRequisitions).where({ ID, IsActiveEntity: true }))
  }
}
