import cds from '@sap/cds'
import { mountEmailActions } from './lib/mail/email-action.js'
import { scheduleJobs } from './lib/workflow/reminders.js'

const LOG = cds.log('server')

// Local dev: Groq credentials from GROQ_API_KEY (production uses the GROQ_API destination,
// hybrid.js passes them via CDS_CONFIG). Skipped under `node --test` so tests stay offline.
if (process.env.GROQ_API_KEY && !cds.env.requires.groq?.credentials && !process.env.NODE_TEST_CONTEXT) {
  cds.env.requires.groq.credentials = {
    url: (process.env.GROQ_BASE_URL ?? 'https://api.groq.com/openai/v1').replace(/\/$/, ''),
    headers: { authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    requestTimeout: 15000
  }
  LOG.info('Groq configured from GROQ_API_KEY')
}

cds.on('bootstrap', app => {
  // Lightweight health endpoint for CF http health checks (no auth, no DB round trip)
  app.get('/health', (_, res) => res.json({ status: 'UP' }))
  mountEmailActions(app)
})

cds.on('served', async () => {
  if (process.env.PR_DISABLE_JOBS) return
  try {
    await scheduleJobs()
  } catch (e) {
    LOG.error('Could not schedule background jobs', e)
  }
})

export default cds.server
