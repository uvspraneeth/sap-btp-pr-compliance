using AdminService as service from '../../srv/admin-service';

// ---------------------------------------------------------------------------
// Approval rules (main entity) + level definitions
// ---------------------------------------------------------------------------
annotate service.ApprovalRules with @(
  UI.HeaderInfo                        : {
    TypeName      : 'Approval Rule',
    TypeNamePlural: 'Approval Rules',
    TypeImageUrl  : 'sap-icon://process',
    Title         : {Value: name},
    Description   : {Value: kind}
  },
  UI.SelectionFields                   : [kind, category_code, active],
  UI.LineItem                          : [
    {Value: name},
    {Value: kind},
    {Value: category_code},
    {Value: minAmount},
    {Value: maxAmount},
    {Value: priority},
    {Value: active}
  ],
  UI.SelectionPresentationVariant #Rules: {
    Text               : 'Approval Rules',
    SelectionVariant   : {SelectOptions: []},
    PresentationVariant: {
      SortOrder     : [{Property: kind}, {Property: priority}],
      Visualizations: ['@UI.LineItem']
    }
  },
  UI.Facets                            : [
    {$Type: 'UI.ReferenceFacet', ID: 'Rule', Label: 'Rule', Target: '@UI.FieldGroup#Rule'},
    {$Type: 'UI.ReferenceFacet', ID: 'Levels', Label: 'Approval Levels', Target: 'levels/@UI.PresentationVariant'}
  ],
  UI.FieldGroup #Rule                  : {Data: [
    {Value: name},
    {Value: kind},
    {Value: category_code},
    {Value: minAmount},
    {Value: maxAmount},
    {Value: priority},
    {Value: active}
  ]}
) {
  category @Common.ValueListWithFixedValues
           @Common.ValueList: {
    CollectionPath: 'Categories',
    Parameters    : [
      {$Type: 'Common.ValueListParameterInOut', LocalDataProperty: category_code, ValueListProperty: 'code'},
      {$Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'name'}
    ]
  };
}

annotate service.ApprovalLevelDefs with @(
  UI.HeaderInfo         : {TypeName: 'Approval Level', TypeNamePlural: 'Approval Levels', Title: {Value: name}},
  UI.LineItem           : [
    {Value: level},
    {Value: name},
    {Value: mode},
    {Value: quorum},
    {Value: approverSource},
    {Value: group_code},
    {Value: minAmount},
    {Value: slaHours}
  ],
  UI.PresentationVariant: {
    SortOrder     : [{Property: level}],
    Visualizations: ['@UI.LineItem']
  },
  UI.Facets             : [{$Type: 'UI.ReferenceFacet', ID: 'LevelDef', Label: 'Level', Target: '@UI.FieldGroup#Level'}],
  UI.FieldGroup #Level  : {Data: [
    {Value: level},
    {Value: name},
    {Value: mode},
    {Value: quorum},
    {Value: approverSource},
    {Value: group_code},
    {Value: minAmount},
    {Value: slaHours}
  ]}
) {
  group @Common.ValueListWithFixedValues
        @Common.ValueList: {
    CollectionPath: 'ApproverGroups',
    Parameters    : [
      {$Type: 'Common.ValueListParameterInOut', LocalDataProperty: group_code, ValueListProperty: 'code'},
      {$Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'name'}
    ]
  };
}

// ---------------------------------------------------------------------------
// Additional tabs (multi-view list report, one entity set per tab)
// ---------------------------------------------------------------------------
annotate service.Vendors with @(
  UI.HeaderInfo                           : {TypeName: 'Vendor', TypeNamePlural: 'Vendors', TypeImageUrl: 'sap-icon://supplier', Title: {Value: name}, Description: {Value: ID}},
  UI.LineItem                             : [
    {Value: ID},
    {Value: name},
    {Value: category_code},
    {Value: status, Criticality: criticality, CriticalityRepresentation: #WithIcon},
    {Value: certExpiry},
    {Value: rating},
    {Value: s4Supplier}
  ],
  UI.SelectionPresentationVariant #Vendors: {
    Text               : 'Vendors',
    SelectionVariant   : {SelectOptions: []},
    PresentationVariant: {SortOrder: [{Property: name}], Visualizations: ['@UI.LineItem']}
  },
  UI.Facets                               : [{$Type: 'UI.ReferenceFacet', ID: 'Vendor', Label: 'Vendor', Target: '@UI.FieldGroup#Vendor'}],
  UI.FieldGroup #Vendor                   : {Data: [
    {Value: ID},
    {Value: name},
    {Value: category_code},
    {Value: status},
    {Value: certExpiry},
    {Value: rating},
    {Value: country},
    {Value: email},
    {Value: s4Supplier}
  ]}
);

annotate service.Materials with @(
  UI.HeaderInfo                             : {TypeName: 'Material', TypeNamePlural: 'Materials', TypeImageUrl: 'sap-icon://product', Title: {Value: description}, Description: {Value: ID}},
  UI.LineItem                               : [
    {Value: ID},
    {Value: description},
    {Value: category_code},
    {Value: uom},
    {Value: standardPrice},
    {Value: preferredVendor_ID},
    {Value: s4Material}
  ],
  UI.SelectionPresentationVariant #Materials: {
    Text               : 'Materials',
    SelectionVariant   : {SelectOptions: []},
    PresentationVariant: {SortOrder: [{Property: ID}], Visualizations: ['@UI.LineItem']}
  },
  UI.Facets                                 : [{$Type: 'UI.ReferenceFacet', ID: 'Material', Label: 'Material', Target: '@UI.FieldGroup#Material'}],
  UI.FieldGroup #Material                   : {Data: [
    {Value: ID},
    {Value: description},
    {Value: category_code},
    {Value: uom},
    {Value: standardPrice},
    {Value: currency_code},
    {Value: preferredVendor_ID},
    {Value: s4Material}
  ]}
);

annotate service.Budgets with @(
  UI.HeaderInfo                           : {TypeName: 'Budget', TypeNamePlural: 'Budgets', TypeImageUrl: 'sap-icon://money-bills', Title: {Value: costCenter_code}, Description: {Value: fiscalYear}},
  UI.LineItem                             : [
    {Value: costCenter_code},
    {Value: fiscalYear},
    {Value: amount},
    {Value: committed},
    {Value: consumed},
    {Value: available}
  ],
  UI.SelectionPresentationVariant #Budgets: {
    Text               : 'Budgets',
    SelectionVariant   : {SelectOptions: []},
    PresentationVariant: {SortOrder: [{Property: fiscalYear, Descending: true}], Visualizations: ['@UI.LineItem']}
  },
  UI.Facets                               : [{$Type: 'UI.ReferenceFacet', ID: 'Budget', Label: 'Budget', Target: '@UI.FieldGroup#Budget'}],
  UI.FieldGroup #Budget                   : {Data: [
    {Value: costCenter_code},
    {Value: fiscalYear},
    {Value: amount},
    {Value: currency_code},
    {Value: committed},
    {Value: consumed},
    {Value: available}
  ]}
) {
  committed @readonly;
  consumed  @readonly;
  available @readonly;
}

annotate service.Employees with @(
  UI.HeaderInfo                             : {TypeName: 'Employee', TypeNamePlural: 'Employees', TypeImageUrl: 'sap-icon://employee', Title: {Value: name}, Description: {Value: userId}},
  UI.LineItem                               : [
    {Value: userId},
    {Value: name},
    {Value: jobTitle},
    {Value: manager_userId},
    {Value: costCenter_code},
    {Value: active}
  ],
  UI.SelectionPresentationVariant #Employees: {
    Text               : 'Employees',
    SelectionVariant   : {SelectOptions: []},
    PresentationVariant: {SortOrder: [{Property: name}], Visualizations: ['@UI.LineItem']}
  },
  UI.Facets                                 : [{$Type: 'UI.ReferenceFacet', ID: 'Employee', Label: 'Employee', Target: '@UI.FieldGroup#Employee'}],
  UI.FieldGroup #Employee                   : {Data: [
    {Value: userId},
    {Value: name},
    {Value: email},
    {Value: jobTitle},
    {Value: manager_userId},
    {Value: costCenter_code},
    {Value: active}
  ]}
);

annotate service.Settings with @(
  UI.HeaderInfo                            : {TypeName: 'Setting', TypeNamePlural: 'Settings', TypeImageUrl: 'sap-icon://action-settings', Title: {Value: name}, Description: {Value: description}},
  UI.LineItem                              : [
    {Value: name},
    {Value: value},
    {Value: description}
  ],
  UI.SelectionPresentationVariant #Settings: {
    Text               : 'Settings',
    SelectionVariant   : {SelectOptions: []},
    PresentationVariant: {SortOrder: [{Property: name}], Visualizations: ['@UI.LineItem']}
  },
  UI.Facets                                : [{$Type: 'UI.ReferenceFacet', ID: 'Setting', Label: 'Setting', Target: '@UI.FieldGroup#Setting'}],
  UI.FieldGroup #Setting                   : {Data: [
    {Value: name},
    {Value: value},
    {Value: description}
  ]}
);
