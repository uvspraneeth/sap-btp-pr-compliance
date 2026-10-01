import cds from '@sap/cds'
import fs from 'node:fs'
import path from 'node:path'
process.env.PR_DISABLE_JOBS = '1'

const root = path.join(import.meta.dirname, '..')
// Mount the e-mail routes ourselves if srv/server.js doesn't (yet)
const serverJs = path.join(root, 'srv', 'server.js')
if (!fs.existsSync(serverJs) || !fs.readFileSync(serverJs, 'utf8').includes('mountEmailActions')) {
  const { mountEmailActions } = await import('../srv/lib/mail/email-action.js')
  cds.on('bootstrap', app => mountEmailActions(app))
}

const { axios } = cds.test(root)
const { describe, it, before } = await import('node:test')
const { default: assert } = await import('node:assert/strict')
const { signActionToken, verifyActionToken } = await import('../srv/lib/security/tokens.js')
const { esc, approvalRequestMail } = await import('../srv/lib/mail/templates.js')
const { sentMails } = await import('../srv/lib/mail/MailService.js')
const { runReminderJob } = await import('../srv/lib/workflow/reminders.js')

const future = () => new Date(Date.now() + 3600e3).toISOString()
const IDS = { pr: 'f0000000-0000-4000-8000-000000000001', lvl: 'f0000000-0000-4000-8000-000000000002', task: 'f0000000-0000-4000-8000-000000000003', po: 'f0000000-0000-4000-8000-000000000004' }
const NONCE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const tokenFor = (action, over = {}) => signActionToken({ taskID: IDS.task, action, nonce: NONCE, expiresAt: future(), ...over })
const as = user => ({ auth: { username: user, password: user }, validateStatus: () => true })

describe('action tokens', () => {
  it('signs and verifies', () => {
    const t = tokenFor('approve')
    assert.deepEqual({ ...verifyActionToken(t), exp: undefined }, { taskID: IDS.task, action: 'approve', nonce: NONCE, exp: undefined })
  })
  it('rejects tampered payload and signature', () => {
    const t = tokenFor('reject')
    const [body, sig] = t.split('.')
    const forged = Buffer.from(Buffer.from(body, 'base64url').toString().replace('reject', 'approve')).toString('base64url')
    assert.throws(() => verifyActionToken(`${forged}.${sig}`), { code: 'TOKEN_INVALID' })
    assert.throws(() => verifyActionToken(`${body}.${sig.slice(0, -2)}xx`), { code: 'TOKEN_INVALID' })
    assert.throws(() => verifyActionToken('garbage'), { code: 'TOKEN_INVALID' })
    assert.throws(() => verifyActionToken(`${t}.extra`), { code: 'TOKEN_INVALID' })
  })
  it('rejects expired tokens', () => {
    const t = tokenFor('approve', { expiresAt: new Date(Date.now() - 1000).toISOString() })
    assert.throws(() => verifyActionToken(t), { code: 'TOKEN_EXPIRED' })
  })
  it('rejects unknown actions', () => {
    assert.throws(() => signActionToken({ taskID: IDS.task, action: 'delete', nonce: NONCE, expiresAt: future() }))
  })
})

describe('templates', () => {
  it('escapes HTML in all dynamic values', () => {
    assert.equal(esc(`<img src=x onerror="alert('1')">&`), '&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;&amp;')
    const { html, text, subject } = approvalRequestMail({
      task: { kind: 'PR', level: 1, levelName: '<b>L1</b>', levelMode: 'ANY' },
      pr: { prNumber: 'PR-26-1', title: '<script>alert(1)</script>', totalAmount: 10, currency_code: 'USD', complianceOutcome: 'PASS' },
      checks: [], links: { approve: 'https://x/a?t=1&u=2', reject: 'https://x/r', view: 'https://x/v' }
    })
    assert.ok(!html.includes('<script>'))
    assert.ok(html.includes('&lt;script&gt;'))
    assert.ok(html.includes('https://x/a?t=1&amp;u=2'))
    assert.ok(html.includes('v:roundrect'), 'VML fallback for Outlook desktop')
    assert.ok(text.includes('Approve: https://x/a?t=1&u=2'))
    assert.ok(subject.startsWith('Approval required: PR-26-1'))
  })
})

describe('mail service + e-mail actions', () => {
  before(async () => {
    const { PurchaseRequisitions, ApprovalLevels, ApprovalTasks, ComplianceChecks } = cds.entities('pr')
    await INSERT.into(PurchaseRequisitions).entries({
      ID: IDS.pr, prNumber: 'PR-26-900001', title: 'Laptops <for> team', status: 'InApproval', requester_userId: 'alice',
      vendor_ID: 'V1001', costCenter_code: 'CC-IT-100', currency_code: 'USD', totalAmount: 2400, revision: 1, complianceOutcome: 'WARN', currentLevel: 1
    })
    await INSERT.into(ComplianceChecks).entries([
      { pr_ID: IDS.pr, revision: 1, checkType: 'POLICY', result: 'WARN', message: 'Item 10: price <12%> above catalog' },
      { pr_ID: IDS.pr, revision: 1, checkType: 'BUDGET', result: 'PASS', message: 'ok' }
    ])
    await INSERT.into(ApprovalLevels).entries({ ID: IDS.lvl, pr_ID: IDS.pr, kind: 'PR', revision: 1, level: 1, name: 'Line Manager', mode: 'ANY', quorum: 1, status: 'Active', dueAt: future() })
    await INSERT.into(ApprovalTasks).entries({ ID: IDS.task, pr_ID: IDS.pr, levelInst_ID: IDS.lvl, kind: 'PR', level: 1, approver_userId: 'bob', status: 'Pending', tokenNonce: NONCE, tokenExpires: future() })
  })

  it('renders and "sends" the approval request via console transport', async () => {
    const mail = cds.unqueued(await cds.connect.to('mail'))
    const before = sentMails.length
    await mail.send('approvalRequest', { taskID: IDS.task })
    assert.equal(sentMails.length, before + 1)
    const m = sentMails.at(-1)
    assert.equal(m.to, 'bob@example.com')
    assert.match(m.subject, /PR-26-900001/)
    assert.ok(m.html.includes('Laptops &lt;for&gt; team'))
    assert.ok(m.html.includes('price &lt;12%&gt; above catalog'), 'WARN findings are listed')
    const approve = m.links.find(l => l.includes('/email-action?t='))
    assert.ok(approve, 'approve link present')
    const claims = verifyActionToken(decodeURIComponent(new URL(approve).searchParams.get('t')))
    assert.equal(claims.taskID, IDS.task)
    assert.ok(m.links.some(l => l.includes('PurchaseRequisitions(ID=' + IDS.pr)))
    assert.ok(m.text.includes('Compliance: Passed with warnings'))
  })

  it('skips mails for tasks that are no longer pending', async () => {
    const { ApprovalTasks } = cds.entities('pr')
    const ID = cds.utils.uuid()
    await INSERT.into(ApprovalTasks).entries({ ID, pr_ID: IDS.pr, levelInst_ID: IDS.lvl, level: 1, approver_userId: 'bob', status: 'Approved' })
    const mail = cds.unqueued(await cds.connect.to('mail'))
    const before = sentMails.length
    await mail.send('approvalRequest', { taskID: ID })
    assert.equal(sentMails.length, before)
  })

  it('GET shows a confirmation page only (no state change)', async () => {
    const res = await axios.get(`/email-action?t=${encodeURIComponent(tokenFor('approve'))}`, as('bob'))
    assert.equal(res.status, 200)
    assert.match(res.data, /Approve this request\?/)
    assert.match(res.headers['content-security-policy'], /frame-ancestors 'none'/)
    assert.equal(res.headers['cache-control'], 'no-store')
    const { ApprovalTasks } = cds.entities('pr')
    assert.equal((await SELECT.one.from(ApprovalTasks, IDS.task)).status, 'Pending')
  })

  it('requires sign-in and the assigned approver', async () => {
    const t = encodeURIComponent(tokenFor('approve'))
    assert.equal((await axios.get(`/email-action?t=${t}`, { validateStatus: () => true })).status, 401)
    assert.equal((await axios.get(`/email-action?t=${t}`, as('carol'))).status, 403)
  })

  it('rejects forged, expired and superseded links', async () => {
    assert.equal((await axios.get('/email-action?t=abc.def', as('bob'))).status, 400)
    const expired = encodeURIComponent(tokenFor('approve', { expiresAt: new Date(Date.now() - 1000).toISOString() }))
    assert.equal((await axios.get(`/email-action?t=${expired}`, as('bob'))).status, 410)
    const superseded = encodeURIComponent(tokenFor('approve', { nonce: 'ffffffffffffffffffffffffffffffff' }))
    assert.equal((await axios.get(`/email-action?t=${superseded}`, as('bob'))).status, 410)
  })

  it('POST without valid form token is refused', async () => {
    const body = new URLSearchParams({ t: tokenFor('approve'), f: 'forged', comment: '' }).toString()
    const res = await axios.post('/email-action', body, { ...as('bob'), headers: { 'content-type': 'application/x-www-form-urlencoded' } })
    assert.equal(res.status, 403)
  })

  it('reminder job re-notifies overdue tasks once', async () => {
    const { ApprovalTasks } = cds.entities('pr')
    const old = new Date(Date.now() - 48 * 3600e3).toISOString()
    await UPDATE(ApprovalTasks, IDS.task).with({ createdAt: old })
    const r1 = await cds.tx({ user: new cds.User.Privileged() }, () => runReminderJob())
    assert.ok(r1.reminded >= 1)
    const t = await SELECT.one.from(ApprovalTasks, IDS.task)
    assert.equal(t.reminderCount, 1)
    assert.ok(t.remindedAt)
    const r2 = await cds.tx({ user: new cds.User.Privileged() }, () => runReminderJob())
    assert.equal(r2.reminded, 0, 'not reminded again within the period')
  })
})
