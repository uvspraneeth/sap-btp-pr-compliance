import cds from '@sap/cds'
import { createHash } from 'node:crypto'
import { daysAgo, dbEntities } from '../util.js'
import { buildContext } from './context.js'
import { chat, checkRateLimit } from './groq.js'
import { guardRecommendation, guardBrief } from './guard.js'
import { recommendationMessages, briefMessages } from './prompts.js'

const hash = (type, context) =>
  createHash('sha256').update(`${type}|${cds.env.pr?.ai?.model ?? ''}|${JSON.stringify(context)}`).digest('hex')

/** Returns a cached result (same grounding input within 24h) or calls Groq once */
async function recommend(prID, type, messagesFor, guard, maxTokens) {
  const { AIRecommendations } = dbEntities()
  const context = await buildContext(prID)
  const inputHash = hash(type, context)
  const cached = await SELECT.one.from(AIRecommendations)
    .where({ pr_ID: prID, type, inputHash, createdAt: { '>=': daysAgo(1) } })
    .orderBy('createdAt desc')
  if (cached) return cached

  checkRateLimit()
  const t0 = Date.now()
  const { content, model } = await chat(messagesFor(context), { maxTokens })
  const result = guard(content, context)
  const row = {
    ID: cds.utils.uuid(),
    pr_ID: prID,
    type,
    inputHash,
    model,
    summary: (typeof result === 'string' ? result : result.summary).slice(0, 1000),
    payload: JSON.stringify(typeof result === 'string' ? { brief: result } : result),
    latencyMs: Date.now() - t0
  }
  await INSERT.into(AIRecommendations).entries(row)
  return SELECT.one.from(AIRecommendations).where({ ID: row.ID })
}

/** Advisory recommendations for the requester (vendor, prices, compliance, justification) */
export const getPRRecommendations = prID =>
  recommend(prID, 'PR_ADVICE', recommendationMessages, guardRecommendation, 700)

/** Short plain-text brief for approvers (advisory only) */
export const getApprovalBrief = async prID =>
  (await recommend(prID, 'APPROVAL_BRIEF', briefMessages, raw => guardBrief(raw), 350)).summary
