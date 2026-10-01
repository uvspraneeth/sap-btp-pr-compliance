namespace pr;

using {
  cuid,
  managed,
  Currency
} from '@sap/cds/common';
using {
  pr.master.Employees,
  pr.master.CostCenters,
  pr.master.Categories,
  pr.master.Vendors,
  pr.master.Materials,
  pr.master.CompanyCodes,
  pr.master.ApproverGroups
} from './master';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type PRStatus         : String(12) enum {
  Draft;
  Submitted;
  Blocked;
  InApproval;
  Approved;
  Rejected;
  Withdrawn;
  Ordered;
  Closed;
}

type CheckType        : String(12) enum {
  BUDGET;
  VENDOR;
  POLICY;
  DUPLICATE;
}

type CheckResult      : String(4) enum {
  PASS;
  WARN;
  FAIL;
}

type ComplianceResult : String(5) enum {
  PASS;
  WARN;
  BLOCK;
}

type ApprovalMode     : String(6) enum {
  ![ALL];
  ![ANY];
  QUORUM;
}

type ApproverSource   : String(20) enum {
  MANAGER;
  COST_CENTER_OWNER;
  GROUP;
}

type LevelStatus      : String(10) enum {
  Waiting;
  Active;
  Approved;
  Rejected;
  Skipped;
  Cancelled;
}

type TaskStatus       : String(10) enum {
  Pending;
  Approved;
  Rejected;
  Cancelled;
}

type ApprovalKind     : String(10) enum {
  PR;
  VARIANCE;
}

type ReconStatus      : String(10) enum {
  PENDING;
  MATCHED;
  TOLERANCE;
  VARIANCE;
}

type VarianceApproval : String(10) enum {
  NONE;
  PENDING;
  APPROVED;
  REJECTED;
}

type S4Status         : String(10) enum {
  NotPosted;
  Queued;
  Posted;
  Failed;
}

type Amount           : Decimal(15, 2);
type Quantity         : Decimal(13, 3);

// ---------------------------------------------------------------------------
// Purchase Requisition
// ---------------------------------------------------------------------------
entity PurchaseRequisitions : cuid, managed {
  prNumber           : String(20);
  title              : String(120);
  justification      : String(1000);
  requester          : Association to Employees;
  costCenter         : Association to CostCenters;
  category           : Association to Categories;
  vendor             : Association to Vendors;
  currency           : Currency;
  totalAmount        : Amount default 0;
  needByDate         : Date;
  quotesObtained     : Integer default 0;
  status             : PRStatus default 'Draft';
  currentLevel       : Integer default 0;
  complianceOutcome  : ComplianceResult;
  revision           : Integer default 0;
  submittedAt        : Timestamp;
  decidedAt          : Timestamp;
  budgetCommitted    : Amount default 0;
  statusCriticality  : Integer = (
    case status
      when 'Approved'
           then 3
      when 'Ordered'
           then 3
      when 'Closed'
           then 3
      when 'Rejected'
           then 1
      when 'Blocked'
           then 1
      when 'InApproval'
           then 2
      when 'Submitted'
           then 2
      else 0
    end
  );
  complianceCriticality : Integer = (
    case complianceOutcome
      when 'PASS'
           then 3
      when 'WARN'
           then 2
      when 'BLOCK'
           then 1
      else 0
    end
  );
  items              : Composition of many PRItems
                         on items.parent = $self;
  checks             : Association to many ComplianceChecks
                         on checks.pr = $self;
  levels             : Association to many ApprovalLevels
                         on levels.pr = $self;
  tasks              : Association to many ApprovalTasks
                         on tasks.pr = $self;
  events             : Association to many WorkflowEvents
                         on events.pr = $self;
  purchaseOrders     : Association to many PurchaseOrders
                         on purchaseOrders.pr = $self;
  recommendations    : Association to many AIRecommendations
                         on recommendations.pr = $self;
}

entity PRItems : cuid {
  parent       : Association to PurchaseRequisitions;
  itemNo       : Integer;
  material     : Association to Materials;
  description  : String(120);
  quantity     : Quantity;
  uom          : String(3);
  unitPrice    : Amount;
  netAmount    : Amount default 0;
  deliveryDate : Date;
  orderedQty   : Quantity default 0;
}

// ---------------------------------------------------------------------------
// Parallel compliance checks (fork/join) - one row per check per revision
// ---------------------------------------------------------------------------
entity ComplianceChecks : cuid {
  pr          : Association to PurchaseRequisitions;
  revision    : Integer;
  checkType   : CheckType;
  result      : CheckResult;
  message     : String(500);
  durationMs  : Integer;
  checkedAt   : Timestamp @cds.on.insert: $now;
  criticality : Integer = (
    case result
      when 'PASS'
           then 3
      when 'WARN'
           then 2
      else 1
    end
  );
}

// ---------------------------------------------------------------------------
// Data-driven approval workflow
// ---------------------------------------------------------------------------
entity ApprovalRules : cuid, managed {
  name      : String(80);
  kind      : ApprovalKind default 'PR';
  category  : Association to Categories; // null = any category
  minAmount : Amount default 0;
  maxAmount : Amount;                    // null = no upper bound
  priority  : Integer default 100;       // lower wins
  active    : Boolean default true;
  levels    : Composition of many ApprovalLevelDefs
                on levels.rule = $self;
}

entity ApprovalLevelDefs : cuid {
  rule           : Association to ApprovalRules;
  level          : Integer;
  name           : String(60);
  mode           : ApprovalMode default 'ANY';
  quorum         : Integer default 1;
  approverSource : ApproverSource default 'MANAGER';
  group          : Association to ApproverGroups;
  minAmount      : Amount default 0; // skip level below this PR total
  slaHours       : Integer default 48;
}

/** Runtime level instance per PR revision (or per PO for variance approvals) */
entity ApprovalLevels : cuid {
  pr          : Association to PurchaseRequisitions;
  po          : Association to PurchaseOrders;
  kind        : ApprovalKind default 'PR';
  revision    : Integer;
  level       : Integer;
  name        : String(60);
  mode        : ApprovalMode;
  quorum      : Integer;
  // snapshot of the rule at start -> later rule edits don't change running approvals
  approverSource : ApproverSource;
  group       : Association to ApproverGroups;
  status      : LevelStatus default 'Waiting';
  slaHours    : Integer;
  activatedAt : Timestamp;
  dueAt       : Timestamp;
  completedAt : Timestamp;
  tasks       : Association to many ApprovalTasks
                  on tasks.levelInst = $self;
}

entity ApprovalTasks : cuid, managed {
  pr            : Association to PurchaseRequisitions;
  po            : Association to PurchaseOrders;
  levelInst     : Association to ApprovalLevels;
  kind          : ApprovalKind default 'PR';
  level         : Integer;
  approver      : Association to Employees;
  status        : TaskStatus default 'Pending';
  comment       : String(500);
  decidedAt     : Timestamp;
  decidedVia    : String(5); // APP | EMAIL | SYS
  tokenNonce    : String(64);
  tokenExpires  : Timestamp;
  remindedAt    : Timestamp;
  reminderCount : Integer default 0;
  criticality   : Integer = (
    case status
      when 'Approved'
           then 3
      when 'Rejected'
           then 1
      when 'Pending'
           then 2
      else 0
    end
  );
}

/** Append-only audit trail; also feeds the Process Flow control */
entity WorkflowEvents : cuid {
  pr      : Association to PurchaseRequisitions;
  po      : Association to PurchaseOrders;
  at      : Timestamp @cds.on.insert: $now;
  actor   : String(120);
  type    : String(30);
  level   : Integer;
  message : String(500);
}

// ---------------------------------------------------------------------------
// Purchase Order
// ---------------------------------------------------------------------------
entity PurchaseOrders : cuid, managed {
  poNumber           : String(20);
  pr                 : Association to PurchaseRequisitions;
  vendor             : Association to Vendors;
  companyCode        : Association to CompanyCodes;
  purchasingOrg      : String(4);
  purchasingGroup    : String(3);
  plant              : String(4);
  currency           : Currency;
  totalAmount        : Amount default 0;
  reconStatus        : ReconStatus default 'PENDING';
  varianceApproval   : VarianceApproval default 'NONE';
  s4Status           : S4Status default 'NotPosted';
  s4PONumber         : String(10);
  s4Error            : String(1000);
  s4PostedAt         : Timestamp;
  reconCriticality   : Integer = (
    case reconStatus
      when 'MATCHED'
           then 3
      when 'TOLERANCE'
           then 2
      when 'VARIANCE'
           then 1
      else 0
    end
  );
  s4Criticality      : Integer = (
    case s4Status
      when 'Posted'
           then 3
      when 'Queued'
           then 2
      when 'Failed'
           then 1
      else 0
    end
  );
  items              : Composition of many POItems
                         on items.parent = $self;
  reconResults       : Association to many ReconciliationResults
                         on reconResults.po = $self;
}

entity POItems : cuid {
  parent       : Association to PurchaseOrders;
  itemNo       : Integer;
  prItem       : Association to PRItems;
  material     : Association to Materials;
  description  : String(120);
  quantity     : Quantity;
  uom          : String(3);
  unitPrice    : Amount;
  netAmount    : Amount default 0;
  deliveryDate : Date;
}

entity ReconciliationResults : cuid {
  po          : Association to PurchaseOrders;
  itemNo      : Integer; // null = header level
  checkType   : String(12); // QTY | PRICE | VENDOR | COSTCENTER | TOTAL | BUDGET
  result      : ReconStatus;
  expected    : String(60);
  actual      : String(60);
  message     : String(300);
  checkedAt   : Timestamp @cds.on.insert: $now;
  criticality : Integer = (
    case result
      when 'MATCHED'
           then 3
      when 'TOLERANCE'
           then 2
      else 1
    end
  );
}

// ---------------------------------------------------------------------------
// AI recommendations (advisory only, cached by input hash)
// ---------------------------------------------------------------------------
entity AIRecommendations : cuid, managed {
  pr        : Association to PurchaseRequisitions;
  type      : String(20); // PR_ADVICE | APPROVAL_BRIEF
  inputHash : String(64);
  model     : String(60);
  summary   : String(1000);
  payload   : LargeString;
  latencyMs : Integer;
}
