import cds from '@sap/cds'
import { mdEntities } from '../util.js'

/**
 * Resolve the approvers of one level definition for a PR, applying
 * segregation of duties: the requester never approves their own request,
 * and nobody approves twice within the same revision (four-eyes).
 * Falls back to the requester's manager chain when a level ends up empty.
 */
export async function resolveApprovers(def, pr, { alreadyApproved = [] } = {}) {
  const { Employees, CostCenters, ApproverGroupMembers } = mdEntities()
  const requester = pr.requester_userId
  let candidates = []

  switch (def.approverSource) {
    case 'MANAGER': {
      const emp = await SELECT.one.from(Employees).columns('manager_userId').where({ userId: requester })
      if (emp?.manager_userId) { candidates = [emp.manager_userId]; break }
      // top of the hierarchy (no manager, e.g. CFO / admin): the cost center owner approves instead
      const cc = await SELECT.one.from(CostCenters).columns('owner_userId').where({ code: pr.costCenter_code })
      if (cc?.owner_userId) candidates = [cc.owner_userId]
      break
    }
    case 'COST_CENTER_OWNER': {
      const cc = await SELECT.one.from(CostCenters).columns('owner_userId').where({ code: pr.costCenter_code })
      if (cc?.owner_userId) candidates = [cc.owner_userId]
      break
    }
    case 'GROUP': {
      const rows = await SELECT.from(ApproverGroupMembers).columns('employee_userId')
        .where`group_code = ${def.group_code} and employee.active = true`
      candidates = rows.map(r => r.employee_userId)
      break
    }
  }

  const exclude = new Set([requester, ...alreadyApproved])
  let approvers = [...new Set(candidates)].filter(u => u && !exclude.has(u))

  // Four-eyes exclusion must not leave a level without approvers - relax it first
  if (!approvers.length) approvers = [...new Set(candidates)].filter(u => u && u !== requester)
  // Still empty (e.g. requester is the manager/owner) -> escalate along the manager chain
  if (!approvers.length) {
    const escalated = await escalate(requester, exclude)
    if (escalated) approvers = [escalated]
  }
  if (!approvers.length)
    cds.error(422, `No eligible approver for level ${def.level} (${def.name}). Please maintain the approval rules.`)
  return approvers
}

async function escalate(requester, exclude) {
  const { Employees } = mdEntities()
  let current = requester
  for (let hop = 0; hop < 6 && current; hop++) {
    const emp = await SELECT.one.from(Employees).columns('manager_userId').where({ userId: current })
    current = emp?.manager_userId
    if (current && !exclude.has(current)) return current
  }
}

/** Most specific active rule: category match beats "any", then priority */
export async function findRule(kind, { category_code, totalAmount }) {
  const { ApprovalRules } = cds.entities('pr')
  const rules = await SELECT.from(ApprovalRules, r => {
    r`.*`, r.levels(l => l`.*`)
  }).where`active = true and kind = ${kind} and (category_code = ${category_code ?? null} or category_code is null)
           and minAmount <= ${totalAmount} and (maxAmount is null or maxAmount >= ${totalAmount})`
    .orderBy('priority')
  rules.sort((a, b) => (b.category_code ? 1 : 0) - (a.category_code ? 1 : 0) || a.priority - b.priority)
  return rules[0]
}
