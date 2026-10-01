import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import cds from '@sap/cds'

process.env.PR_DISABLE_JOBS = '1'
const { GET, POST } = cds.test(import.meta.dirname + '/..')
const { levelOutcome } = await import('../srv/lib/workflow/engine.js')

const as = user => ({ auth: { username: user, password: user } })
const PR = '/odata/v4/requisition/PurchaseRequisitions'
const TASKS = '/odata/v4/approval/MyTasks'

async function createPR(user = 'alice', { items = [{ material_ID: 'M-LAPTOP-14', quantity: 2 }], ...header } = {}) {
  const { data: draft } = await POST(PR, {
    title: 'Laptops for new joiners', category_code: 'IT', vendor_ID: 'V1001',
    justification: 'Replacement of three-year-old devices for the onboarding wave', ...header
  }, as(user))
  for (const item of items) await POST(`${PR}(ID=${draft.ID},IsActiveEntity=false)/items`, item, as(user))
  await POST(`${PR}(ID=${draft.ID},IsActiveEntity=false)/RequisitionService.draftActivate`, {}, as(user))
  return draft.ID
}
const submit = (ID, user = 'alice') => POST(`${PR}(ID=${ID},IsActiveEntity=true)/RequisitionService.submit`, {}, as(user))
const readPR = async (ID, user = 'alice') => (await GET(`${PR}(ID=${ID},IsActiveEntity=true)?$expand=checks,tasks`, as(user))).data
const pendingTasks = async (user, prID) => (await GET(`${TASKS}?$filter=status eq 'Pending' and prID eq ${prID}`, as(user))).data.value
const decide = (task, user, action = 'approve', comment = 'ok') => POST(`${TASKS}(${task.ID})/ApprovalService.${action}`, { comment }, as(user))
const budgetOf = async cc => (await SELECT.one.from('pr.master.Budgets').where({ costCenter_code: cc })).committed

const approveLevel = async (users, prID) => {
  for (const u of users) for (const t of await pendingTasks(u, prID)) await decide(t, u)
}

describe('levelOutcome (parallel reconciliation rules)', () => {
  test('ALL needs every approver, any rejection rejects', () => {
    assert.equal(levelOutcome('ALL', 2, { approved: 1, rejected: 0, pending: 1 }), null)
    assert.equal(levelOutcome('ALL', 2, { approved: 2, rejected: 0, pending: 0 }), 'Approved')
    assert.equal(levelOutcome('ALL', 2, { approved: 1, rejected: 1, pending: 0 }), 'Rejected')
  })
  test('ANY: first decision wins', () => {
    assert.equal(levelOutcome('ANY', 1, { approved: 1, rejected: 0, pending: 1 }), 'Approved')
    assert.equal(levelOutcome('ANY', 1, { approved: 0, rejected: 1, pending: 1 }), 'Rejected')
    assert.equal(levelOutcome('ANY', 1, { approved: 0, rejected: 0, pending: 2 }), null)
  })
  test('QUORUM approves at n, rejects once n is unreachable', () => {
    assert.equal(levelOutcome('QUORUM', 2, { approved: 2, rejected: 1, pending: 0 }), 'Approved')
    assert.equal(levelOutcome('QUORUM', 2, { approved: 1, rejected: 1, pending: 1 }), null)
    assert.equal(levelOutcome('QUORUM', 2, { approved: 1, rejected: 2, pending: 0 }), 'Rejected')
  })
})

describe('PR lifecycle', () => {
  test('draft totals are computed from catalog prices', async () => {
    const ID = await createPR()
    const pr = await readPR(ID)
    assert.equal(Number(pr.totalAmount), 2400)
    assert.equal(pr.status, 'Draft')
    assert.equal(pr.requester_userId, 'alice')
  })

  test('happy path: checks -> L1 -> L2 parallel (ALL) -> L3 (ANY) -> Approved + budget committed', async () => {
    const before = Number(await budgetOf('CC-IT-100'))
    const ID = await createPR()
    const { data } = await submit(ID)
    assert.equal(data.status, 'InApproval')
    assert.match(data.prNumber, /^PR-\d{2}-\d{6}$/)

    let pr = await readPR(ID)
    assert.equal(pr.checks.length, 4, 'four parallel checks joined')
    assert.ok(['PASS', 'WARN'].includes(pr.complianceOutcome))
    assert.equal(pr.currentLevel, 1)

    await approveLevel(['bob'], ID)
    assert.equal((await readPR(ID)).currentLevel, 2)
    assert.equal((await pendingTasks('carol', ID)).length, 1)
    assert.equal((await pendingTasks('dan', ID)).length, 1)

    await approveLevel(['carol'], ID)
    assert.equal((await readPR(ID)).currentLevel, 2, 'ALL mode waits for the second parallel approver')
    await approveLevel(['dan'], ID)
    assert.equal((await readPR(ID)).currentLevel, 3)

    const [erinTask] = await pendingTasks('erin', ID)
    await decide(erinTask, 'erin')
    pr = await readPR(ID)
    assert.equal(pr.status, 'Approved')
    assert.equal(pr.tasks.filter(t => t.status === 'Cancelled').length, 1, "frank's parallel task is no longer needed")
    assert.equal(Number(await budgetOf('CC-IT-100')), before + 2400)
  })

  test('parallel approvals racing on the same level advance it exactly once', async () => {
    const ID = await createPR()
    await submit(ID)
    await approveLevel(['bob'], ID)
    const [c] = await pendingTasks('carol', ID), [d] = await pendingTasks('dan', ID)
    await Promise.all([decide(c, 'carol'), decide(d, 'dan')])
    const pr = await readPR(ID)
    assert.equal(pr.currentLevel, 3)
    assert.equal(pr.tasks.filter(t => t.level === 3).length, 2, 'level 3 activated once (2 directors), not twice')
  })

  test('double decision is idempotent (409)', async () => {
    const ID = await createPR()
    await submit(ID)
    const [t] = await pendingTasks('bob', ID)
    await decide(t, 'bob')
    await assert.rejects(decide(t, 'bob'), e => e.response?.status === 409 || /409/.test(e.message))
  })

  test('rejection needs a comment, rejects the PR and cancels parallel tasks', async () => {
    const ID = await createPR()
    await submit(ID)
    await approveLevel(['bob'], ID)
    const [c] = await pendingTasks('carol', ID)
    await assert.rejects(decide(c, 'carol', 'decline', ''), e => e.response?.status === 400 || /400/.test(e.message))
    await decide(c, 'carol', 'decline', 'Please get a second quote')
    const pr = await readPR(ID)
    assert.equal(pr.status, 'Rejected')
    assert.equal(pr.tasks.find(t => t.approver_userId === 'dan' && t.level === 2).status, 'Cancelled')
  })

  test('segregation of duties: requester never approves, nobody approves twice', async () => {
    const ID = await createPR('bob') // bob is also an approver; his manager is erin
    await submit(ID, 'bob')
    const [l1] = await pendingTasks('erin', ID)
    assert.ok(l1, 'L1 goes to the requester\'s manager')
    await decide(l1, 'erin')
    await approveLevel(['carol', 'dan'], ID)
    const pr = await readPR(ID, 'bob')
    const l3 = pr.tasks.filter(t => t.level === 3)
    assert.deepEqual(l3.map(t => t.approver_userId), ['frank'], 'erin already approved L1 -> excluded at L3')
    assert.ok(!pr.tasks.some(t => t.approver_userId === 'bob'))
  })

  test('requester without a manager: L1 falls back to the cost center owner', async () => {
    const ID = await createPR('admin') // admin has no manager; CC-IT-100 is owned by carol
    const { data } = await submit(ID, 'admin')
    assert.equal(data.status, 'InApproval')
    assert.equal((await pendingTasks('carol', ID)).length, 1, 'L1 goes to the cost center owner')
  })

  test('compliance FAIL blocks: blocked vendor and insufficient budget', async () => {
    const blocked = await createPR('alice', { vendor_ID: 'V1004' })
    let { data } = await submit(blocked)
    assert.equal(data.status, 'Blocked')
    let pr = await readPR(blocked)
    assert.equal(pr.checks.find(c => c.checkType === 'VENDOR').result, 'FAIL')
    assert.equal(pr.tasks.length, 0)

    const noBudget = await createPR('alice', { costCenter_code: 'CC-OPS-300', items: [{ material_ID: 'M-LAPTOP-14', quantity: 5 }] })
    ;({ data } = await submit(noBudget))
    assert.equal(data.status, 'Blocked')
    pr = await readPR(noBudget)
    assert.equal(pr.checks.find(c => c.checkType === 'BUDGET').result, 'FAIL')
  })

  test('withdraw cancels open approvals', async () => {
    const ID = await createPR()
    await submit(ID)
    await POST(`${PR}(ID=${ID},IsActiveEntity=true)/RequisitionService.withdraw`, { reason: 'No longer needed' }, as('alice'))
    const pr = await readPR(ID)
    assert.equal(pr.status, 'Withdrawn')
    assert.ok(pr.tasks.every(t => t.status !== 'Pending'))
  })

  test('authorization: other users cannot see or decide', async () => {
    const ID = await createPR()
    await submit(ID)
    // carol approves only at L2 -> no task yet -> must not see the PR (grace would: Buyers read all PRs)
    await assert.rejects(GET(`${PR}(ID=${ID},IsActiveEntity=true)`, as('carol')), e => [403, 404].includes(e.response?.status))
    const other = await createPR('bob')
    await assert.rejects(GET(`${PR}(ID=${other},IsActiveEntity=true)`, as('alice')), e => [403, 404].includes(e.response?.status))
    const [t] = await pendingTasks('bob', ID)
    await assert.rejects(decide(t, 'carol'), e => [403, 404].includes(e.response?.status))
  })

  test('AI recommendations degrade gracefully while Groq is not configured', async () => {
    const ID = await createPR()
    await assert.rejects(POST(`${PR}(ID=${ID},IsActiveEntity=true)/RequisitionService.getRecommendations`, {}, as('alice')),
      e => e.response?.status === 503)
  })

  test('process flow: lanes and parallel nodes', async () => {
    const ID = await createPR()
    await submit(ID)
    const { data } = await GET(`${PR}(ID=${ID},IsActiveEntity=true)/RequisitionService.getProcessFlow()`, as('alice'))
    const flow = JSON.parse(data.value)
    assert.deepEqual(flow.lanes.map(l => l.id), ['REQ', 'CHK', 'L1', 'L2', 'L3', 'PO', 'S4'])
    assert.equal(flow.nodes.filter(n => n.lane === 'CHK').length, 4)
    const req = flow.nodes.find(n => n.id === 'req')
    assert.equal(req.children.length, 4, 'fork into 4 parallel checks')
    assert.ok(flow.nodes.filter(n => n.lane === 'CHK').every(n => n.children.length === 1), 'join into L1')
  })
})
