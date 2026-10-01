import cds from '@sap/cds'
import { invalidateSettings } from './lib/util.js'

export default class AdminService extends cds.ApplicationService {
  init() {
    // Threshold changes take effect immediately on this instance (others within 60s)
    this.after(['CREATE', 'UPDATE', 'DELETE'], 'Settings', () => invalidateSettings())

    this.before('SAVE', 'ApprovalRules', req => {
      const levels = req.data.levels ?? []
      const seen = new Set()
      for (const l of levels) {
        if (seen.has(l.level)) req.error(400, `Level ${l.level} is defined twice`, 'in/levels')
        seen.add(l.level)
        if (l.approverSource === 'GROUP' && !l.group_code) req.error(400, `Level ${l.level}: select an approver group`, 'in/levels')
        if (l.mode === 'QUORUM' && !(l.quorum > 0)) req.error(400, `Level ${l.level}: quorum must be at least 1`, 'in/levels')
      }
    })
    return super.init()
  }
}
