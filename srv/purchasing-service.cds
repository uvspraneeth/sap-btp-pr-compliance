using {pr as db} from '../db/schema';
using {pr.master as md} from '../db/master';

/**
 * Purchase Orders created from approved PRs: PR<->PO reconciliation,
 * variance approval and posting to S/4HANA.
 */
@path    : 'purchasing'
@requires: ['Requester', 'Buyer', 'Admin']
service PurchasingService {

  @odata.draft.enabled
  @restrict: [
    { grant: ['READ', 'UPDATE', 'reconcile', 'requestVarianceApproval', 'postToS4'],
      to   : 'Requester', where: 'createdBy = $user' },
    { grant: ['READ', 'UPDATE', 'reconcile', 'requestVarianceApproval', 'postToS4'], to: 'Buyer' },
    { grant: '*', to: 'Admin' }
  ]
  entity PurchaseOrders as projection on db.PurchaseOrders
    actions {
      @(
        Common.SideEffects     : {TargetProperties: ['in/reconStatus', 'in/reconCriticality'],
                                  TargetEntities  : ['in/reconResults']},
        // actions are only implemented for saved POs - disabled while editing (save first)
        Core.OperationAvailable: {$edmJson: {$And: [
          {$Eq: [{$Path: 'in/IsActiveEntity'}, true]},
          {$Ne: [{$Path: 'in/s4Status'}, 'Posted']}
        ]}}
      )
      action reconcile()                                  returns PurchaseOrders;

      @(
        Common.SideEffects     : {TargetProperties: ['in/varianceApproval']},
        Core.OperationAvailable: {$edmJson: {$And: [
          {$Eq: [{$Path: 'in/IsActiveEntity'}, true]},
          {$Eq: [{$Path: 'in/reconStatus'}, 'VARIANCE']},
          {$Ne: [{$Path: 'in/varianceApproval'}, 'PENDING']}
        ]}}
      )
      action requestVarianceApproval(reason : String(500) @mandatory) returns PurchaseOrders;

      @(
        Common.SideEffects     : {TargetProperties: ['in/s4Status', 'in/s4Criticality', 'in/s4PONumber', 'in/s4Error']},
        Core.OperationAvailable: {$edmJson: {$And: [
          {$Eq: [{$Path: 'in/IsActiveEntity'}, true]},
          {$Ne: [{$Path: 'in/s4Status'}, 'Posted']},
          {$Ne: [{$Path: 'in/s4Status'}, 'Queued']}
        ]}}
      )
      action postToS4()                                   returns PurchaseOrders;
    };

  entity POItems as projection on db.POItems;

  @readonly
  entity ReconciliationResults as projection on db.ReconciliationResults;

  @readonly
  entity PurchaseRequisitions as projection on db.PurchaseRequisitions {
    ID, prNumber, title, status, totalAmount, currency, costCenter, vendor, requester
  };

  @readonly entity Vendors      as projection on md.Vendors;
  @readonly entity Materials    as projection on md.Materials;
  @readonly entity CompanyCodes as projection on md.CompanyCodes;
}
