using {pr as db} from '../db/schema';
using {pr.master as md} from '../db/master';

/**
 * Requester-facing service: create PRs, submit, track the process flow,
 * get AI advice and create the Purchase Order once approved.
 */
@path    : 'requisition'
@requires: 'authenticated-user'
service RequisitionService {

  @odata.draft.enabled
  @restrict: [
    { grant: ['CREATE'], to: 'Requester' },
    { grant: ['READ', 'UPDATE', 'DELETE', 'submit', 'withdraw', 'getRecommendations', 'getProcessFlow', 'createPurchaseOrder'],
      to   : 'Requester', where: 'createdBy = $user' },
    { grant: ['READ', 'getProcessFlow', 'getRecommendations'],
      to   : 'Approver', where: 'exists tasks[approver_userId = $user]' },
    { grant: ['READ', 'getProcessFlow', 'createPurchaseOrder'], to: 'Buyer' },
    { grant: '*', to: 'Admin' }
  ]
  entity PurchaseRequisitions as projection on db.PurchaseRequisitions
    actions {
      @(
        Common.SideEffects             : {TargetProperties: ['in/status', 'in/currentLevel', 'in/complianceOutcome', 'in/prNumber'],
                                          TargetEntities  : ['in/checks', 'in/levels', 'in/tasks', 'in/events']},
        // actions are only implemented for saved PRs - disabled while editing (save first)
        Core.OperationAvailable        : {$edmJson: {$And: [
          {$Eq: [{$Path: 'in/IsActiveEntity'}, true]},
          {$Or: [
            {$Eq: [{$Path: 'in/status'}, 'Draft']},
            {$Eq: [{$Path: 'in/status'}, 'Rejected']},
            {$Eq: [{$Path: 'in/status'}, 'Blocked']},
            {$Eq: [{$Path: 'in/status'}, 'Withdrawn']}
          ]}
        ]}}
      )
      action submit()                             returns PurchaseRequisitions;

      @(
        Common.SideEffects             : {TargetProperties: ['in/status', 'in/currentLevel'],
                                          TargetEntities  : ['in/levels', 'in/tasks', 'in/events']},
        Core.OperationAvailable        : {$edmJson: {$And: [
          {$Eq: [{$Path: 'in/IsActiveEntity'}, true]},
          {$Eq: [{$Path: 'in/status'}, 'InApproval']}
        ]}}
      )
      action withdraw(reason : String(500))       returns PurchaseRequisitions;

      @(
        Common.SideEffects             : {TargetEntities: ['in/recommendations']}
      )
      action getRecommendations()                 returns AIRecommendations;

      function getProcessFlow()                   returns LargeString;

      @(
        Common.SideEffects             : {TargetProperties: ['in/status'],
                                          TargetEntities  : ['in/purchaseOrders', 'in/events']},
        Core.OperationAvailable        : {$edmJson: {$And: [
          {$Eq: [{$Path: 'in/IsActiveEntity'}, true]},
          {$Eq: [{$Path: 'in/status'}, 'Approved']}
        ]}}
      )
      action createPurchaseOrder()                returns PurchaseOrders;
    };

  entity PRItems                as projection on db.PRItems;

  @readonly
  entity ComplianceChecks       as projection on db.ComplianceChecks;

  @readonly
  entity ApprovalLevels         as projection on db.ApprovalLevels;

  @readonly
  entity ApprovalTasks          as projection on db.ApprovalTasks {
    *,
    approver.name as approverName
  } excluding {
    tokenNonce,
    tokenExpires
  };

  @readonly
  entity WorkflowEvents         as projection on db.WorkflowEvents;

  @readonly
  entity AIRecommendations      as projection on db.AIRecommendations;

  @readonly
  entity PurchaseOrders         as projection on db.PurchaseOrders {
    ID,
    poNumber,
    pr,
    vendor,
    totalAmount,
    currency,
    reconStatus,
    reconCriticality,
    s4Status,
    s4Criticality,
    s4PONumber,
    createdAt
  };

  // ---- value helps (read-only master data) --------------------------------
  @readonly entity Vendors     as projection on md.Vendors;
  @readonly entity Materials   as projection on md.Materials;
  @readonly entity CostCenters as projection on md.CostCenters;
  @readonly entity Categories  as projection on md.Categories;
  @readonly entity Employees   as projection on md.Employees { userId, name, jobTitle, costCenter };
  @readonly entity Budgets     as projection on md.Budgets;
}

// Draft side effects: server recalculates item/total amounts on every change
annotate RequisitionService.PurchaseRequisitions with @Common.SideEffects #Items: {
  SourceEntities  : [items],
  TargetProperties: ['totalAmount']
};

annotate RequisitionService.PRItems with @Common.SideEffects #Amounts: {
  SourceProperties: [material_ID, quantity, unitPrice],
  TargetProperties: ['description', 'uom', 'unitPrice', 'netAmount', 'parent/totalAmount']
};
