import cds from '@sap/cds'
import { num, round2, now, logEvent, dbEntities, mdEntities } from '../util.js'
import { toS4Payload } from './po-mapper.js'

const LOG = cds.log('s4sync')
const S4 = 'API_PURCHASEORDER_PROCESS_SRV'

/**
 * Queued (outboxed) S/4HANA posting worker. Runs after the requesting
 * transaction commits; transient failures are retried by the CAP queue with
 * exponential backoff, business (4xx) failures end the task as 'Failed'.
 *
 * cds.pr.s4.mode:
 *   mock     - post to the in-process mock (dev/test); refuses real credentials
 *   simulate - no remote call, simulated S/4 number (production default)
 *   live     - post to the S4HANA destination (explicit opt-in only)
 *   off      - integration disabled
 */
export default class S4SyncService extends cds.Service {
  init() {
    this.on('postPO', req => this.postPO(req.data.poID))
    // after the queue gave up (maxAttempts reached)
    this.on('postPO/#failed', async req => {
      const poID = req.data?.poID
      const reason = req.results?.message ?? 'unknown error'
      if (poID) await markFailed(poID, `Posting failed after retries: ${reason}`)
    })
    return super.init()
  }

  async postPO(poID) {
    const { PurchaseOrders } = dbEntities()
    const po = await SELECT.one.from(PurchaseOrders).where({ ID: poID }).forUpdate()
    if (!po) return LOG.warn('PO not found, skipping', poID)
    if (po.s4Status === 'Posted') return po.s4PONumber // idempotent

    const mode = cds.env.pr?.s4?.mode ?? 'mock'
    try {
      if (mode === 'off') return await markFailed(poID, 'S/4HANA integration is disabled (cds.pr.s4.mode = off)')
      if (mode === 'simulate') return await markPosted(po, 'SIM' + String(Date.now() % 1e7).padStart(7, '0'), 'simulated')

      const s4 = await cds.connect.to(S4)
      const remote = s4 instanceof cds.RemoteService
      if (remote && mode !== 'live')
        return await markFailed(poID, `Live S/4 posting disabled (cds.pr.s4.mode = ${mode}, set 'live' to enable)`)

      if (remote) { // retries must not create duplicates: look up by our external reference
        const existing = await s4.run(SELECT.one.from(s4.entities.A_PurchaseOrder).columns('PurchaseOrder')
          .where({ CorrespncExternalReference: po.poNumber }))
        if (existing?.PurchaseOrder) return await markPosted(po, existing.PurchaseOrder, 'found existing')
      }

      const payload = toS4Payload(await loadMappingInput(po), { dateFormat: remote ? 'v2' : 'iso' })
      const created = remote // raw V2 deep insert for S/4; CQN for the in-process mock
        ? await s4.send({ method: 'POST', path: '/A_PurchaseOrder', data: payload })
        : await s4.run(INSERT.into(s4.entities.A_PurchaseOrder).entries(payload))
      const number = created?.PurchaseOrder ?? created?.d?.PurchaseOrder ?? payload.PurchaseOrder
      if (!number) throw Object.assign(new Error('S/4HANA response did not contain a purchase order number'), { unrecoverable: true })
      return await markPosted(po, number, remote ? 'live' : 'mock')
    } catch (e) {
      if (isTransient(e)) {
        LOG.warn(`Posting ${po.poNumber} failed transiently, queue will retry:`, e.message)
        throw e // rollback + retry with backoff; 'postPO/#failed' fires after maxAttempts
      }
      LOG.error(`Posting ${po.poNumber} failed:`, e)
      await markFailed(poID, s4ErrorMessage(e))
    }
  }
}

async function loadMappingInput(po) {
  const { POItems, PurchaseRequisitions } = dbEntities()
  const { Vendors, Materials, CostCenters } = mdEntities()
  const [items, vendor, pr] = await Promise.all([
    SELECT.from(POItems).where({ parent_ID: po.ID }).orderBy('itemNo'),
    SELECT.one.from(Vendors).columns('s4Supplier').where({ ID: po.vendor_ID }),
    SELECT.one.from(PurchaseRequisitions).columns('costCenter_code').where({ ID: po.pr_ID })
  ])
  const matIds = [...new Set(items.map(i => i.material_ID).filter(Boolean))]
  const [materials, costCenter] = await Promise.all([
    matIds.length ? SELECT.from(Materials).columns('ID', 's4Material').where({ ID: { in: matIds } }) : [],
    pr?.costCenter_code ? SELECT.one.from(CostCenters).columns('s4CostCenter', 'glAccount').where({ code: pr.costCenter_code }) : null
  ])
  if (!vendor?.s4Supplier) throw Object.assign(new Error(`Vendor ${po.vendor_ID} has no S/4 supplier number`), { status: 422 })
  const s4Mat = Object.fromEntries(materials.map(m => [m.ID, m.s4Material]))
  return {
    po: { ...po, s4Supplier: vendor.s4Supplier },
    items: items.map(i => ({ ...i, s4Material: s4Mat[i.material_ID] })),
    costCenter,
    s4PurchaseOrderType: cds.env.pr?.s4?.purchaseOrderType ?? 'NB'
  }
}

async function markPosted(po, s4PONumber, how) {
  const { PurchaseOrders, PurchaseRequisitions } = dbEntities()
  const { Budgets } = mdEntities()
  await UPDATE(PurchaseOrders, po.ID).with({ s4Status: 'Posted', s4PONumber, s4PostedAt: now(), s4Error: null })

  // commitment -> actual consumption
  const pr = await SELECT.one.from(PurchaseRequisitions).columns('costCenter_code').where({ ID: po.pr_ID })
  const budget = pr && await SELECT.one.from(Budgets)
    .where({ costCenter_code: pr.costCenter_code, fiscalYear: new Date().getFullYear() }).forUpdate()
  if (budget) {
    const total = num(po.totalAmount)
    await UPDATE(Budgets, budget.ID).with({
      committed: round2(Math.max(0, num(budget.committed) - total)),
      consumed: round2(num(budget.consumed) + total)
    })
  }
  await logEvent({ pr_ID: po.pr_ID, po_ID: po.ID, type: 'PO_POSTED', actor: 'system', message: `${po.poNumber} posted to S/4HANA as ${s4PONumber} (${how})` })
  await notify('poPosted', po.ID)
  return s4PONumber
}

async function markFailed(poID, message) {
  const { PurchaseOrders } = dbEntities()
  const po = await SELECT.one.from(PurchaseOrders).columns('pr_ID', 'poNumber', 's4Status').where({ ID: poID })
  if (!po || po.s4Status === 'Posted') return
  await UPDATE(PurchaseOrders, poID).with({ s4Status: 'Failed', s4Error: message.slice(0, 1000) })
  await logEvent({ pr_ID: po.pr_ID, po_ID: poID, type: 'PO_POST_FAILED', actor: 'system', message: `${po.poNumber}: ${message}`.slice(0, 500) })
  await notify('poPostFailed', poID)
}

async function notify(event, poID) {
  try {
    await (await cds.connect.to('mail')).send(event, { poID })
  } catch (e) {
    LOG.warn(`Could not queue '${event}' mail:`, e.message) // never fail the posting because of mail
  }
}

/** HTTP status of the failed call: remote errors carry it in reason.response */
function httpStatus(e) {
  if (e.reason) return e.reason.response?.status // undefined = network error
  return e.status ?? e.statusCode ?? (Number(e.code) || undefined)
}

function isTransient(e) {
  if (e.unrecoverable) return false
  if (e.reason) { const s = httpStatus(e); return s === undefined || s >= 500 || s === 429 }
  return ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'].includes(e.code ?? e.cause?.code)
}

function s4ErrorMessage(e) {
  const body = e.reason?.response?.body
  const main = body?.error?.message?.value ?? body?.error?.message ?? e.message
  const details = (body?.error?.innererror?.errordetails ?? []).map(d => d.message).filter(m => m && m !== main)
  const status = httpStatus(e)
  return `${status ? `[${status}] ` : ''}${[main, ...new Set(details)].join(' | ')}`.slice(0, 1000)
}
