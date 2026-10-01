/*
 * Shared UI semantics on the domain model (labels, texts, units, hidden
 * technical fields). Inherited by every service projection and app.
 * App-specific layouts live in app/<app>/annotations.cds.
 */
using {pr as db} from '../db/schema';
using {pr.master as md} from '../db/master';

// ---------------------------------------------------------------------------
// Purchase Requisition
// ---------------------------------------------------------------------------
annotate db.PurchaseRequisitions with {
  ID                    @UI.Hidden;
  prNumber              @title: 'PR Number';
  title                 @title: 'Title';
  justification         @title: 'Business Justification'  @UI.MultiLineText;
  requester             @title: 'Requester'               @Common: {Text: requester.name, TextArrangement: #TextOnly};
  costCenter            @title: 'Cost Center'             @Common: {Text: costCenter.name, TextArrangement: #TextFirst};
  category              @title: 'Category'                @Common: {Text: category.name, TextArrangement: #TextOnly};
  vendor                @title: 'Vendor'                  @Common: {Text: vendor.name, TextArrangement: #TextFirst};
  currency              @title: 'Currency';
  totalAmount           @title: 'Total Amount'            @Measures.ISOCurrency: currency_code;
  needByDate            @title: 'Need-by Date';
  quotesObtained        @title: 'Quotes Obtained';
  status                @title: 'Status';
  currentLevel          @title: 'Approval Level';
  complianceOutcome     @title: 'Compliance';
  revision              @title: 'Revision';
  submittedAt           @title: 'Submitted On';
  decidedAt             @title: 'Decided On';
  budgetCommitted       @title: 'Committed Budget'        @Measures.ISOCurrency: currency_code;
  statusCriticality     @UI.Hidden;
  complianceCriticality @UI.Hidden;
}

annotate db.PRItems with {
  ID           @UI.Hidden;
  parent       @UI.Hidden;
  itemNo       @title: 'Item';
  material     @title: 'Material'      @Common: {Text: material.description, TextArrangement: #TextFirst};
  description  @title: 'Description';
  quantity     @title: 'Quantity'      @Measures.Unit: uom;
  uom          @title: 'Unit';
  unitPrice    @title: 'Unit Price'    @Measures.ISOCurrency: parent.currency_code;
  netAmount    @title: 'Net Amount'    @Measures.ISOCurrency: parent.currency_code;
  deliveryDate @title: 'Delivery Date';
  orderedQty   @title: 'Ordered Qty'   @Measures.Unit: uom;
}

annotate db.ComplianceChecks with {
  ID          @UI.Hidden;
  pr          @UI.Hidden;
  revision    @title: 'Revision';
  checkType   @title: 'Check';
  result      @title: 'Result';
  message     @title: 'Details';
  durationMs  @title: 'Duration (ms)';
  checkedAt   @title: 'Checked On';
  criticality @UI.Hidden;
}

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------
annotate db.ApprovalRules with {
  ID        @UI.Hidden;
  name      @title: 'Rule';
  kind      @title: 'Applies To';
  category  @title: 'Category'     @Common: {Text: category.name, TextArrangement: #TextOnly};
  minAmount @title: 'From Amount';
  maxAmount @title: 'To Amount';
  priority  @title: 'Priority';
  active    @title: 'Active';
}

annotate db.ApprovalLevelDefs with {
  ID             @UI.Hidden;
  rule           @UI.Hidden;
  level          @title: 'Level';
  name           @title: 'Level Name';
  mode           @title: 'Decision Mode';
  quorum         @title: 'Quorum';
  approverSource @title: 'Approver Source';
  group          @title: 'Approver Group'  @Common: {Text: group.name, TextArrangement: #TextFirst};
  minAmount      @title: 'Skip Below Amount';
  slaHours       @title: 'SLA (hours)';
}

annotate db.ApprovalLevels with {
  ID          @UI.Hidden;
  level       @title: 'Level';
  name        @title: 'Level';
  mode        @title: 'Mode';
  status      @title: 'Status';
  activatedAt @title: 'Activated On';
  dueAt       @title: 'Due On';
  completedAt @title: 'Completed On';
}

annotate db.ApprovalTasks with {
  ID            @UI.Hidden;
  pr            @UI.Hidden;
  po            @UI.Hidden;
  levelInst     @UI.Hidden;
  kind          @title: 'Type';
  level         @title: 'Level';
  approver      @title: 'Approver'    @Common: {Text: approver.name, TextArrangement: #TextOnly};
  status        @title: 'Decision';
  comment       @title: 'Comment';
  decidedAt     @title: 'Decided On';
  decidedVia    @title: 'Channel';
  reminderCount @title: 'Reminders';
  criticality   @UI.Hidden;
}

annotate db.WorkflowEvents with {
  ID      @UI.Hidden;
  pr      @UI.Hidden;
  po      @UI.Hidden;
  at      @title: 'Time';
  actor   @title: 'By';
  type    @title: 'Event';
  level   @title: 'Level';
  message @title: 'Details';
}

// ---------------------------------------------------------------------------
// Purchase Order
// ---------------------------------------------------------------------------
annotate db.PurchaseOrders with {
  ID               @UI.Hidden;
  poNumber         @title: 'PO Number';
  pr               @title: 'Purchase Requisition'  @Common: {Text: pr.prNumber, TextArrangement: #TextOnly};
  vendor           @title: 'Vendor'                @Common: {Text: vendor.name, TextArrangement: #TextFirst};
  companyCode      @title: 'Company Code';
  purchasingOrg    @title: 'Purchasing Org.';
  purchasingGroup  @title: 'Purchasing Group';
  plant            @title: 'Plant';
  currency         @title: 'Currency';
  totalAmount      @title: 'Total Amount'          @Measures.ISOCurrency: currency_code;
  reconStatus      @title: 'Reconciliation';
  varianceApproval @title: 'Variance Approval';
  s4Status         @title: 'S/4HANA Status';
  s4PONumber       @title: 'S/4HANA PO';
  s4Error          @title: 'S/4HANA Message'       @UI.MultiLineText;
  s4PostedAt       @title: 'Posted On';
  reconCriticality @UI.Hidden;
  s4Criticality    @UI.Hidden;
}

annotate db.POItems with {
  ID           @UI.Hidden;
  parent       @UI.Hidden;
  prItem       @UI.Hidden;
  itemNo       @title: 'Item';
  material     @title: 'Material'      @Common: {Text: material.description, TextArrangement: #TextFirst};
  description  @title: 'Description';
  quantity     @title: 'Quantity'      @Measures.Unit: uom;
  uom          @title: 'Unit';
  unitPrice    @title: 'Unit Price'    @Measures.ISOCurrency: parent.currency_code;
  netAmount    @title: 'Net Amount'    @Measures.ISOCurrency: parent.currency_code;
  deliveryDate @title: 'Delivery Date';
}

annotate db.ReconciliationResults with {
  ID          @UI.Hidden;
  po          @UI.Hidden;
  itemNo      @title: 'Item';
  checkType   @title: 'Check';
  result      @title: 'Result';
  expected    @title: 'Approved (PR)';
  actual      @title: 'Ordered (PO)';
  message     @title: 'Details';
  checkedAt   @title: 'Checked On';
  criticality @UI.Hidden;
}

annotate db.AIRecommendations with {
  ID        @UI.Hidden;
  pr        @UI.Hidden;
  payload   @UI.Hidden;
  inputHash @UI.Hidden;
  type      @title: 'Type';
  model     @title: 'Model';
  summary   @title: 'Summary';
  latencyMs @title: 'Latency (ms)';
}

// ---------------------------------------------------------------------------
// Master data
// ---------------------------------------------------------------------------
annotate md.Vendors with {
  ID          @title: 'Vendor'          @Common: {Text: name, TextArrangement: #TextFirst};
  name        @title: 'Vendor Name';
  category    @title: 'Category'        @Common: {Text: category.name, TextArrangement: #TextOnly};
  status      @title: 'Status';
  certExpiry  @title: 'Certificate Valid To';
  rating      @title: 'Rating';
  country     @title: 'Country';
  email       @title: 'E-Mail';
  s4Supplier  @title: 'S/4HANA Supplier';
  criticality @UI.Hidden;
}

annotate md.Materials with {
  ID              @title: 'Material'        @Common: {Text: description, TextArrangement: #TextFirst};
  description     @title: 'Description';
  category        @title: 'Category'        @Common: {Text: category.name, TextArrangement: #TextOnly};
  uom             @title: 'Unit';
  standardPrice   @title: 'Catalog Price'   @Measures.ISOCurrency: currency_code;
  currency        @title: 'Currency';
  preferredVendor @title: 'Preferred Vendor' @Common: {Text: preferredVendor.name, TextArrangement: #TextFirst};
  s4Material      @title: 'S/4HANA Material';
}

annotate md.CostCenters with {
  code         @title: 'Cost Center'     @Common: {Text: name, TextArrangement: #TextFirst};
  name         @title: 'Name';
  owner        @title: 'Owner'           @Common: {Text: owner.name, TextArrangement: #TextOnly};
  companyCode  @title: 'Company Code';
  glAccount    @title: 'G/L Account';
  s4CostCenter @title: 'S/4HANA Cost Center';
}

annotate md.Budgets with {
  ID         @UI.Hidden;
  costCenter @title: 'Cost Center'   @Common: {Text: costCenter.name, TextArrangement: #TextFirst};
  fiscalYear @title: 'Fiscal Year';
  amount     @title: 'Budget'        @Measures.ISOCurrency: currency_code;
  committed  @title: 'Committed'     @Measures.ISOCurrency: currency_code;
  consumed   @title: 'Consumed'      @Measures.ISOCurrency: currency_code;
  available  @title: 'Available'     @Measures.ISOCurrency: currency_code;
  currency   @title: 'Currency';
}

annotate md.Employees with {
  userId     @title: 'User'          @Common: {Text: name, TextArrangement: #TextFirst};
  name       @title: 'Name';
  email      @title: 'E-Mail';
  jobTitle   @title: 'Job Title';
  manager    @title: 'Manager'       @Common: {Text: manager.name, TextArrangement: #TextOnly};
  costCenter @title: 'Cost Center';
  active     @title: 'Active';
}

annotate md.ApproverGroups with {
  code @title: 'Group'  @Common: {Text: name, TextArrangement: #TextFirst};
  name @title: 'Name';
}

annotate md.Settings with {
  name        @title: 'Setting';
  value       @title: 'Value';
  description @title: 'Description';
}

annotate md.CompanyCodes with {
  code            @title: 'Company Code'  @Common: {Text: name, TextArrangement: #TextFirst};
  name            @title: 'Name';
  purchasingOrg   @title: 'Purchasing Org.';
  purchasingGroup @title: 'Purchasing Group';
  defaultPlant    @title: 'Plant';
}
