using {pr as db} from '../db/schema';

/**
 * Approver worklist. Decisions from the app and from Outlook e-mail links
 * both end up in the same workflow engine (idempotent, race-safe).
 */
@path    : 'approval'
@requires: ['Approver', 'Admin']
service ApprovalService {

  @readonly
  @restrict: [
    { grant: ['READ', 'approve', 'decline', 'getApprovalBrief'], to: 'Approver', where: 'approver_userId = $user' },
    { grant: ['READ'], to: 'Admin' }
  ]
  entity MyTasks as select from db.ApprovalTasks
    mixin {
      items  : Association to many PRItems on items.parent.ID = $projection.prID;
      checks : Association to many ComplianceChecks on checks.pr.ID = $projection.prID;
    }
    into {
    ID,
    kind,
    level,
    status,
    criticality,
    comment,
    decidedAt,
    decidedVia,
    createdAt,
    approver.userId           as approver_userId,
    approver.name             as approverName,
    levelInst.name            as levelName,
    levelInst.mode            as levelMode,
    levelInst.dueAt           as dueAt,
    pr.ID                     as prID,
    pr.prNumber               as prNumber,
    pr.title                  as title,
    pr.justification          as justification,
    pr.totalAmount            as totalAmount,
    pr.currency.code          as currency,
    pr.requester.name         as requesterName,
    pr.vendor.name            as vendorName,
    pr.costCenter.code        as costCenter,
    pr.costCenter.name        as costCenterName,
    pr.category.name          as categoryName,
    pr.complianceOutcome      as complianceOutcome,
    pr.complianceCriticality  as complianceCriticality,
    pr.status                 as prStatus,
    po.poNumber               as poNumber,
    items,
    checks
  }
  actions {
    @(
      Common.SideEffects     : {TargetProperties: ['in/status', 'in/decidedAt', 'in/comment', 'in/prStatus']},
      Core.OperationAvailable: {$edmJson: {$Eq: [{$Path: 'in/status'}, 'Pending']}}
    )
    action approve(comment : String(500))                   returns MyTasks;

    @(
      Common.SideEffects     : {TargetProperties: ['in/status', 'in/decidedAt', 'in/comment', 'in/prStatus']},
      Core.OperationAvailable: {$edmJson: {$Eq: [{$Path: 'in/status'}, 'Pending']}}
    )
    action decline(comment : String(500) @mandatory)         returns MyTasks;

    function getApprovalBrief()                             returns LargeString;
  };

  // parent (the PR) is not exposed here, so the currency is flattened for @Measures.ISOCurrency
  @readonly entity PRItems          as projection on db.PRItems { *, parent.currency.code as currency_code };
  @readonly entity ComplianceChecks as projection on db.ComplianceChecks;
}
