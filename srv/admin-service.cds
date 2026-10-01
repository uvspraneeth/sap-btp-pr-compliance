using {pr as db} from '../db/schema';
using {pr.master as md} from '../db/master';

/** Master data and approval-rule maintenance */
@path    : 'admin'
@requires: 'Admin'
service AdminService {
  @odata.draft.enabled entity ApprovalRules  as projection on db.ApprovalRules;
  entity ApprovalLevelDefs                   as projection on db.ApprovalLevelDefs;
  @odata.draft.enabled entity Vendors        as projection on md.Vendors;
  @odata.draft.enabled entity Materials      as projection on md.Materials;
  @odata.draft.enabled entity Budgets        as projection on md.Budgets;
  @odata.draft.enabled entity Employees      as projection on md.Employees;
  @odata.draft.enabled entity ApproverGroups as projection on md.ApproverGroups;
  entity ApproverGroupMembers                as projection on md.ApproverGroupMembers;
  entity CostCenters                         as projection on md.CostCenters;
  entity Categories                          as projection on md.Categories;
  entity CompanyCodes                        as projection on md.CompanyCodes;
  entity Settings                            as projection on md.Settings;

  @readonly entity WorkflowEvents            as projection on db.WorkflowEvents;
}
