import cds from '@sap/cds'

const LOG = cds.log('ai')

/** Error carrying an HTTP status (CAP maps `status` to the response code) */
export const httpError = (status, code, message) => Object.assign(new Error(message), { status, code })

const conf = () => ({ enabled: true, model: 'llama-3.3-70b-versatile', timeoutMs: 10000, maxPerMinute: 10, ...cds.env.pr?.ai })

// ---------------------------------------------------------------------------
// Per-user sliding-window rate limit (per instance; good enough for 1-3 instances)
// ---------------------------------------------------------------------------
const calls = new Map()
export function checkRateLimit(user = cds.context?.user?.id ?? 'anonymous') {
  const limit = conf().maxPerMinute, t = Date.now()
  const recent = (calls.get(user) ?? []).filter(ts => t - ts < 60e3)
  if (recent.length >= limit) throw httpError(429, 'AI_RATE_LIMIT', `AI request limit reached (${limit}/min). Please try again shortly.`)
  recent.push(t)
  calls.set(user, recent)
  if (calls.size > 5000) calls.clear() // bound memory
}
export const resetRateLimit = () => calls.clear()

/**
 * Calls Groq's OpenAI-compatible chat completions via the CAP remote service
 * `groq` (BTP destination GROQ_API in production). Returns { content, model }.
 */
export async function chat(messages, { json = true, maxTokens = 700 } = {}) {
  const c = conf()
  if (!c.enabled) throw httpError(503, 'AI_DISABLED', 'AI recommendations are disabled')
  // Fail fast: connecting a remote service without credentials throws a generic 500
  const notConfigured = () => httpError(503, 'AI_NOT_CONFIGURED', 'AI service is not configured')
  if (!cds.env.requires.groq?.credentials && !cds.services.groq) throw notConfigured()
  const groq = await cds.connect.to('groq')
  if (!groq.options?.credentials) throw notConfigured()

  const data = {
    model: c.model,
    temperature: 0.1,
    max_tokens: maxTokens,
    messages,
    ...(json && { response_format: { type: 'json_object' } })
  }
  const t0 = Date.now()
  let res
  try {
    res = await Promise.race([
      groq.send({ method: 'POST', path: '/chat/completions', data, headers: { 'content-type': 'application/json' } }),
      new Promise((_, rej) => setTimeout(() => rej(httpError(504, 'AI_TIMEOUT', 'AI service timed out')), c.timeoutMs).unref?.())
    ])
  } catch (e) {
    if (e.code?.startsWith?.('AI_')) throw e
    const status = e.reason?.response?.status
    LOG.warn('Groq call failed', status ?? '', e.message)
    if (status === 429) throw httpError(429, 'AI_RATE_LIMIT', 'AI provider rate limit reached. Please try again shortly.')
    if (status === 401 || status === 403) throw httpError(503, 'AI_NOT_CONFIGURED', 'AI service credentials are invalid')
    throw httpError(503, 'AI_UNAVAILABLE', 'AI service is currently unavailable')
  }
  const content = res?.choices?.[0]?.message?.content
  if (typeof content !== 'string') throw httpError(502, 'AI_BAD_RESPONSE', 'AI service returned an unexpected response')
  LOG.debug('Groq call', { model: res.model, ms: Date.now() - t0, usage: res.usage })
  return { content, model: res.model ?? c.model }
}
