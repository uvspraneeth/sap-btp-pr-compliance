#!/usr/bin/env node
/**
 * Hybrid launcher: `cds watch --profile hybrid` against the real S/4HANA system.
 *
 *   node scripts/hybrid.js                 # S/4 reachable, posting blocked by the mock-mode guard
 *   node scripts/hybrid.js --s4-simulate   # no remote posting, simulated S/4 numbers
 *   node scripts/hybrid.js --s4-live       # REAL purchase orders are created in S/4 (explicit opt-in)
 *
 * Reads S/4 credentials from ./.env (S4_URL, S4_CLIENT, S4_USERNAME, S4_PASSWORD; git-/cf-ignored),
 * falling back to the legacy ./trial.json ({ trial: { url, client, username, password } }).
 * Secrets are handed to the child process via CDS_CONFIG only - never printed.
 * Optional Groq: GROQ_API_KEY (and GROQ_BASE_URL) from .env or your shell.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = f => args.includes(f)
const passthrough = args.filter(a => !['--s4-live', '--s4-simulate'].includes(a))

const fail = msg => { console.error(`[hybrid] ${msg}`); process.exit(1) }

// ---- S/4 credentials ---------------------------------------------------------
// .env first (shell variables win - loadEnvFile never overrides them), legacy trial.json as fallback
const envFile = path.join(root, '.env')
if (fs.existsSync(envFile)) process.loadEnvFile(envFile)
let trial, source = '.env'
const { S4_URL, S4_CLIENT, S4_USERNAME, S4_PASSWORD } = process.env
if (S4_URL || S4_CLIENT || S4_USERNAME || S4_PASSWORD) {
  trial = { url: S4_URL, client: S4_CLIENT, username: S4_USERNAME, password: S4_PASSWORD }
  for (const [k, v] of Object.entries({ S4_URL, S4_CLIENT, S4_USERNAME, S4_PASSWORD })) if (!v) fail(`.env is missing ${k}.`)
} else {
  const trialFile = path.join(root, 'trial.json')
  if (!fs.existsSync(trialFile)) fail('No S/4 credentials: set S4_URL, S4_CLIENT, S4_USERNAME, S4_PASSWORD in .env.')
  try { trial = JSON.parse(fs.readFileSync(trialFile, 'utf8')).trial } catch (e) { fail(`trial.json is not valid JSON: ${e.message}`) }
  for (const k of ['url', 'client', 'username', 'password']) if (!trial?.[k]) fail(`trial.json is missing "trial.${k}".`)
  source = 'trial.json'
}

const config = mergeExisting(process.env.CDS_CONFIG)
config.requires ??= {}
config.requires.API_PURCHASEORDER_PROCESS_SRV = {
  ...config.requires.API_PURCHASEORDER_PROCESS_SRV,
  credentials: {
    url: String(trial.url).replace(/\/$/, ''),
    authentication: 'BasicAuthentication',
    username: String(trial.username),
    password: String(trial.password),
    path: '/sap/opu/odata/sap/API_PURCHASEORDER_PROCESS_SRV',
    queries: { 'sap-client': String(trial.client) },
    requestTimeout: 30000
  }
}

// ---- Optional Groq -------------------------------------------------------------
if (process.env.GROQ_API_KEY) {
  config.requires.groq = {
    ...config.requires.groq,
    credentials: {
      url: (process.env.GROQ_BASE_URL ?? 'https://api.groq.com/openai/v1').replace(/\/$/, ''),
      headers: { authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      requestTimeout: 15000
    }
  }
}

// ---- S/4 posting mode (safe by default) ----------------------------------------
config.pr ??= {}
config.pr.s4 ??= {}
if (flag('--s4-live') && flag('--s4-simulate')) fail('Use either --s4-live or --s4-simulate, not both.')
if (flag('--s4-live')) config.pr.s4.mode = 'live'
else if (flag('--s4-simulate')) config.pr.s4.mode = 'simulate'

const host = new URL(config.requires.API_PURCHASEORDER_PROCESS_SRV.credentials.url).host
console.log(`[hybrid] S/4 target: ${host} (client ${trial.client}) - credentials loaded from ${source}`)
console.log(`[hybrid] Groq: ${process.env.GROQ_API_KEY ? 'configured from GROQ_API_KEY' : 'not configured (AI recommendations disabled)'}`)
if (config.pr.s4.mode === 'live') {
  console.warn('\n  !!! --s4-live: "Post to S/4HANA" will create REAL purchase orders in the connected system !!!\n')
} else {
  console.log(`[hybrid] S/4 posting mode: ${config.pr.s4.mode ?? 'mock (default guard: remote posting refused)'} - pass --s4-live to post for real`)
}

// ---- TLS: S/4 host sends an incomplete Let's Encrypt Gen-Y chain -----------------
const env = { ...process.env, CDS_CONFIG: JSON.stringify(config) }
const pem = path.join(root, 'srv', 'certs', 's4-ca-chain.pem')
if (!env.NODE_EXTRA_CA_CERTS && fs.existsSync(pem)) env.NODE_EXTRA_CA_CERTS = pem

// ---- Launch cds watch ---------------------------------------------------------------
const cdsBin = path.join(root, 'node_modules', '@sap', 'cds-dk', 'bin', 'cds.js')
if (!fs.existsSync(cdsBin)) fail('@sap/cds-dk not installed locally - run "npm install" first.')
const child = spawn(process.execPath, [cdsBin, 'watch', '--profile', 'hybrid', ...passthrough], { cwd: root, env, stdio: 'inherit' })
child.on('exit', code => process.exit(code ?? 0))
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig))

function mergeExisting(raw) {
  if (!raw) return {}
  try { return JSON.parse(raw) } catch { return {} }
}
