namespace pr.master;

using {
  managed,
  cuid,
  Currency,
  sap.common.CodeList
} from '@sap/cds/common';

/** Procurement categories (IT, OFFICE, SERVICES, ...) */
entity Categories : CodeList {
  key code : String(20);
}

entity CompanyCodes : managed {
  key code              : String(4);
      name              : String(80);
      currency          : Currency;
      purchasingOrg     : String(4);
      purchasingGroup   : String(3);
      defaultPlant      : String(4);
}

entity CostCenters : managed {
  key code        : String(10);
      name        : String(80);
      owner       : Association to Employees;
      companyCode : Association to CompanyCodes;
      glAccount   : String(10);
      s4CostCenter: String(10);
}

/** Drives approver resolution (manager chain) - no IAS dependency */
entity Employees : managed {
  key userId     : String(120); // login name as delivered by XSUAA ($user)
      name       : String(100);
      email      : String(241);
      jobTitle   : String(80);
      manager    : Association to Employees;
      costCenter : Association to CostCenters;
      active     : Boolean default true;
}

entity ApproverGroups : managed {
  key code    : String(30);
      name    : String(80);
      members : Composition of many ApproverGroupMembers
                  on members.group = $self;
}

entity ApproverGroupMembers : cuid {
  group    : Association to ApproverGroups;
  employee : Association to Employees;
}

type VendorStatus : String(10) enum {
  Active;
  Blocked;
  Inactive;
}

entity Vendors : managed {
  key ID            : String(10);
      name          : String(120);
      category      : Association to Categories;
      status        : VendorStatus default 'Active';
      certExpiry    : Date;
      rating        : Decimal(2, 1);
      country       : String(3);
      email         : String(241);
      s4Supplier    : String(10);
      criticality   : Integer = (
        case
          when status = 'Blocked'
               then 1
          when status = 'Inactive'
               then 2
          else 3
        end
      );
}

entity Materials : managed {
  key ID              : String(18);
      description     : String(120);
      category        : Association to Categories;
      uom             : String(3);
      standardPrice   : Decimal(15, 2);
      currency        : Currency;
      preferredVendor : Association to Vendors;
      s4Material      : String(40);
}

entity Budgets : cuid, managed {
  costCenter : Association to CostCenters;
  fiscalYear : Integer;
  amount     : Decimal(15, 2) default 0;
  committed  : Decimal(15, 2) default 0;
  consumed   : Decimal(15, 2) default 0;
  currency   : Currency;
  available  : Decimal(15, 2) = amount - committed - consumed;
}

/** Tunable compliance / reconciliation thresholds (key -> numeric value) */
entity Settings : managed {
  key name        : String(40);
      value       : Decimal(15, 2);
      description : String(200);
}

/** Atomic document number ranges: PR-2026-000001 */
entity NumberRanges {
  key object  : String(10);
  key year    : Integer;
      prefix  : String(4);
      current : Integer default 0;
}
