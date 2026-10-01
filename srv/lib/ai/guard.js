import { round2 } from '../util.js'

const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g
const PHONE = /\+?\(?\d[\d\s().-]{7,}\d/g

/** Removes e-mail addresses and phone-like numbers (keeps dates and amounts) */
export function redact(text) {
  if (typeof text !== 'string') return ''
  return text
    .replace(EMAIL, '[redacted]')
    .replace(PHONE, m => {
      const digits = m.replace(/\D/g, '')
      if (digits.length < 10) return m // amounts, short codes
      if (/^\d{4}-\d{2}-\d{2}$/.test(m.trim())) return m // ISO dates
      return '[redacted]'
    })
}

const clean = (v, max) => (typeof v === 'string' && v.trim() ? redact(v.trim()).slice(0, max) : null)
const cleanList = (v, max = 6, len = 200) => (Array.isArray(v) ? v.map(s => clean(s, len)).filter(Boolean).slice(0, max) : [])

export const fallbackPayload = (summary = 'AI response could not be validated') => ({
  summary, vendorRecommendation: null, priceInsights: [], complianceHints: [], justificationSuggestion: null,
  risks: [], confidence: 'low', grounded: true
})

function parse(raw) {
  if (raw && typeof raw === 'object') return raw
  if (typeof raw !== 'string') return null
  try {
    return JSON.parse(raw)
  } catch {
    const m = raw.match(/\{[\s\S]*\}/) // tolerate prose / code fences around the JSON
    try { return m ? JSON.parse(m[0]) : null } catch { return null }
  }
}

/**
 * Validates model output against the grounding context. Anything that is not
 * backed by CONTEXT is dropped; all numbers are recomputed from CONTEXT.
 */
export function guardRecommendation(raw, context) {
  const out = parse(raw)
  if (!out || typeof out !== 'object' || Array.isArray(out)) return fallbackPayload()

  const vendors = new Map(context.eligibleVendors.map(v => [v.vendorID, v]))
  const items = new Map(context.items.map(i => [Number(i.itemNo), i]))
  const catalog = new Map(context.catalog.map(m => [m.materialID, m]))
  const history = new Map(context.priceHistory12m.map(h => [h.materialID, h]))

  let vendorRecommendation = null
  const vr = out.vendorRecommendation
  if (vr && typeof vr === 'object' && vendors.has(vr.vendorID)) {
    const v = vendors.get(vr.vendorID)
    vendorRecommendation = { vendorID: v.vendorID, vendorName: v.name, reason: clean(vr.reason, 300) ?? '' }
  }

  const seen = new Set()
  const priceInsights = (Array.isArray(out.priceInsights) ? out.priceInsights : [])
    .map(p => {
      const item = items.get(Number(p?.itemNo))
      if (!item || seen.has(item.itemNo)) return null
      if (p.materialID && p.materialID !== item.materialID) return null // foreign / hallucinated material
      seen.add(item.itemNo)
      return {
        itemNo: item.itemNo,
        materialID: item.materialID,
        requestedPrice: round2(item.unitPrice),
        historicalAvg: history.has(item.materialID) ? history.get(item.materialID).avgPrice : null,
        catalogPrice: catalog.has(item.materialID) ? catalog.get(item.materialID).standardPrice : null,
        comment: clean(p.comment, 300) ?? ''
      }
    })
    .filter(Boolean)
    .slice(0, 20)

  return {
    summary: clean(out.summary, 600) ?? 'No summary provided',
    vendorRecommendation,
    priceInsights,
    complianceHints: cleanList(out.complianceHints),
    justificationSuggestion: clean(out.justificationSuggestion, 1000),
    risks: cleanList(out.risks),
    confidence: ['low', 'medium', 'high'].includes(out.confidence) ? out.confidence : 'low',
    grounded: true
  }
}

/** Approval brief: { brief } JSON or plain text -> sanitized text (<= 800 chars) */
export function guardBrief(raw) {
  const out = parse(raw)
  const text = typeof out?.brief === 'string' ? out.brief : typeof raw === 'string' && !out ? raw : null
  return clean(text, 800) ?? 'AI brief could not be validated'
}
