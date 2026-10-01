import cds from '@sap/cds'
import { settings, logEvent } from '../util.js'

/**
 * Background housekeeping, cluster-safe:
 *  - SLA reminders for pending approval tasks
 *  - stale S/4 postings (Queued too long) -> Failed so users can retry
 * Uses CAP's DB-backed scheduling: a named recurring task gets a deterministic
 * ID (UPSERT), so restarts and multiple CF instances never multiply the job.
 */
const LOG = cds.log('jobs')
const privileged = () => ({ user: new cds.User.Privileged() })

export class PrJobs extends cds.Service {
  init() {
    this.on('reminders', () => runReminderJob())
    return super.init()
  }
}

export async function runReminderJob() {
  const { ApprovalTasks, PurchaseOrders } = cds.entities('pr')
  const s = await settings()
  const cutoff = new Date(Date.now() - (s.REMINDER_HOURS || 24) * 3600e3).toISOString()

  const due = await SELECT.from(ApprovalTasks).columns('ID', 'pr_ID', 'po_ID', 'level', 'remindedAt', 'reminderCount')
    .where`status = 'Pending' and ((remindedAt is null and createdAt < ${cutoff}) or remindedAt < ${cutoff})`
    .limit(200)

  const mail = due.length ? await cds.connect.to('mail') : null
  let reminded = 0
  for (const t of due) {
    // guarded update: only one instance/run may remind a task per period
    const n = await UPDATE(ApprovalTasks)
      .with({ remindedAt: new Date().toISOString(), reminderCount: { '+=': 1 } })
      .where({ ID: t.ID, status: 'Pending', remindedAt: t.remindedAt ?? null })
    if (!n) continue
    await mail.send('approvalRequest', { taskID: t.ID, reminder: true })
    await logEvent({ pr_ID: t.pr_ID, po_ID: t.po_ID, type: 'REMINDER_SENT', level: t.level, message: `Reminder #${(t.reminderCount ?? 0) + 1} sent` })
    reminded++
  }

  const staleCutoff = new Date(Date.now() - 60 * 60e3).toISOString()
  const timedOut = await UPDATE(PurchaseOrders)
    .with({ s4Status: 'Failed', s4Error: 'Posting timed out - please retry' })
    .where({ s4Status: 'Queued', modifiedAt: { '<': staleCutoff } })

  if (reminded || timedOut) LOG.info(`reminders sent: ${reminded}, stale S/4 postings failed: ${timedOut}`)
  return { reminded, timedOut: Number(timedOut) || 0 }
}

export async function scheduleJobs() {
  if (process.env.PR_DISABLE_JOBS) return
  const every = cds.env.pr?.reminders?.every ?? '1h'
  try {
    if (cds.env.requires.scheduling && cds.env.requires.queue && cds.db) {
      const jobs = await cds.connect.to(PrJobs)
      await cds.tx(privileged(), () => jobs.schedule('reminders').every(every))
      return LOG.info(`reminder job scheduled every ${every}`)
    }
  } catch (e) {
    LOG.warn('CAP scheduling unavailable, falling back to interval timer:', e.message)
  }
  // Fallback: in-process timer on one instance only
  const idx = process.env.CF_INSTANCE_INDEX
  if (idx !== undefined && idx !== '0') return
  const timer = setInterval(
    () => cds.tx(privileged(), () => runReminderJob()).catch(e => LOG.error('reminder job failed', e)),
    cds.utils.ms4(every)
  ).unref()
  cds.on('shutdown', () => clearInterval(timer))
}
