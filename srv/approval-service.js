import cds from '@sap/cds'
import { decide } from './lib/workflow/engine.js'
import { dbEntities } from './lib/util.js'

const keyOf = req => { const p = req.params.at(-1); return typeof p === 'object' ? p.ID : p }

export default class ApprovalService extends cds.ApplicationService {
  init() {
    const { MyTasks } = this.entities

    const onDecision = decision => async req => {
      const ID = keyOf(req)
      await decide({ taskID: ID, decision, comment: req.data.comment, via: 'APP' })
      return SELECT.one.from(MyTasks).where({ ID })
    }
    this.on('approve', MyTasks, onDecision('Approved'))
    this.on('decline', MyTasks, onDecision('Rejected'))

    this.on('getApprovalBrief', MyTasks, async req => {
      const task = await SELECT.one.from(dbEntities().ApprovalTasks).columns('pr_ID').where({ ID: keyOf(req) })
      if (!task) return req.reject(404, 'Approval task not found')
      const { getApprovalBrief } = await import('./lib/ai/index.js')
      return getApprovalBrief(task.pr_ID)
    })

    return super.init()
  }
}
