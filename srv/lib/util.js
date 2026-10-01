import cds from '@sap/cds'

export const num = v => (v === null || v === undefined || v === '' ? 0 : Number(v))
export const round2 = n => Math.round((num(n) + Number.EPSILON) * 100) / 100
export const now = () => new Date().toISOString()
export const today = () => now().slice(0, 10)
export const addHours = (hours, from = Date.now()) => new Date(from + hours * 3600e3).toISOString()
export const daysAgo = days => new Date(Date.now() - days * 864e5).toISOString()
export const fmtAmount = (amount, currency) =>
  `${num(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency ?? ''}`.trim()

export const dbEntities = () => cds.entities('pr')
export const mdEntities = () => cds.entities('pr.master')

/** Current user id, 'system' for background (queue) processing */
export const userId = () => cds.context?.user?.id ?? 'system'

// ---------------------------------------------------------------------------
// Settings (thresholds) - tiny per-instance cache, 60s TTL
// ---------------------------------------------------------------------------
let _settings, _settingsAt = 0
export async function settings() {
  if (_settings && Date.now() - _settingsAt < 60e3) return _settings
  const { Settings } = mdEntities()
  const rows = await SELECT.from(Settings).columns('name', 'value')
  _settings = Object.fromEntries(rows.map(r => [r.name, num(r.value)]))
  _settingsAt = Date.now()
  return _settings
}
export const invalidateSettings = () => (_settings = null)

// ---------------------------------------------------------------------------
// Atomic document numbers: PR-26-000001 (12 chars = fits S/4 external reference)
// The UPDATE row-locks the counter until commit, so concurrent callers serialize.
// ---------------------------------------------------------------------------
export async function nextNumber(object, prefix) {
  const { NumberRanges } = mdEntities()
  const year = new Date().getFullYear()
  const where = { object, year }
  const bumped = await UPDATE(NumberRanges).where(where).with({ current: { '+=': 1 } })
  if (!bumped) {
    try {
      await INSERT.into(NumberRanges).entries({ ...where, prefix, current: 1 })
    } catch {
      await UPDATE(NumberRanges).where(where).with({ current: { '+=': 1 } }) // lost the race for the first insert
    }
  }
  const { current } = await SELECT.one.from(NumberRanges).columns('current').where(where)
  return `${prefix}-${String(year).slice(2)}-${String(current).padStart(6, '0')}`
}

// ---------------------------------------------------------------------------
// Audit trail (feeds the Process Flow)
// ---------------------------------------------------------------------------
export async function logEvent(event) {
  const { WorkflowEvents } = dbEntities()
  await INSERT.into(WorkflowEvents).entries({ actor: userId(), ...event })
}
