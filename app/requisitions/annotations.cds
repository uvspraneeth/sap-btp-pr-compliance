using RequisitionService as service from '../../srv/requisition-service';

// ---------------------------------------------------------------------------
// Purchase Requisitions - List Report / Object Page
// ---------------------------------------------------------------------------
annotate service.PurchaseRequisitions with @(
  // mirror the server guards (requisition-service.js EDITABLE / delete rule): no Edit/Delete button that only fails
  UI.UpdateHidden             : {$edmJson: {$Not: {$Or: [
    {$Eq: [{$Path: 'status'}, 'Draft']},
    {$Eq: [{$Path: 'status'}, 'Rejected']},
    {$Eq: [{$Path: 'status'}, 'Blocked']},
    {$Eq: [{$Path: 'status'}, 'Withdrawn']}
  ]}}},
  UI.DeleteHidden             : {$edmJson: {$Ne: [{$Path: 'status'}, 'Draft']}},
  Common.SemanticKey          : [prNumber],
  UI.HeaderInfo               : {
    TypeName      : 'Purchase Requisition',
    TypeNamePlural: 'Purchase Requisitions',
    TypeImageUrl  : 'sap-icon://request',
    Title         : {Value: title},
    Description   : {Value: prNumber}
  },
  UI.SelectionFields          : [
    status,
    category_code,
    costCenter_code,
    vendor_ID
  ],
  UI.PresentationVariant      : {
    SortOrder     : [{Property: createdAt, Descending: true}],
    Visualizations: ['@UI.LineItem']
  },
  UI.LineItem                 : [
    {Value: prNumber},
    {Value: title},
    {Value: status, Criticality: statusCriticality, CriticalityRepresentation: #WithIcon},
    {Value: totalAmount},
    {Value: complianceOutcome, Criticality: complianceCriticality, CriticalityRepresentation: #WithIcon},
    {Value: currentLevel},
    {Value: vendor_ID},
    {Value: createdAt, Label: 'Created On'}
  ],

  // ---- header
  UI.HeaderFacets             : [
    {$Type: 'UI.ReferenceFacet', ID: 'HdrStatus', Target: '@UI.DataPoint#status'},
    {$Type: 'UI.ReferenceFacet', ID: 'HdrTotal', Target: '@UI.DataPoint#total'},
    {$Type: 'UI.ReferenceFacet', ID: 'HdrCompliance', Target: '@UI.DataPoint#compliance'},
    {$Type: 'UI.ReferenceFacet', ID: 'HdrLevel', Target: '@UI.DataPoint#level'}
  ],
  UI.DataPoint #status        : {Value: status, Title: 'Status', Criticality: statusCriticality},
  UI.DataPoint #total         : {Value: totalAmount, Title: 'Total Amount'},
  UI.DataPoint #compliance    : {Value: complianceOutcome, Title: 'Compliance', Criticality: complianceCriticality},
  UI.DataPoint #level         : {Value: currentLevel, Title: 'Approval Level'},

  // ---- actions (object page header); createPurchaseOrder is a custom action (navigates to the PO)
  UI.Identification           : [
    {$Type: 'UI.DataFieldForAction', Action: 'RequisitionService.submit', Label: 'Submit'},
    {$Type: 'UI.DataFieldForAction', Action: 'RequisitionService.withdraw', Label: 'Withdraw'}
  ],

  // ---- sections (custom sections Process Flow / AI are added in manifest.json)
  UI.Facets                   : [
    {
      $Type : 'UI.CollectionFacet',
      ID    : 'General',
      Label : 'General Information',
      Facets: [
        {$Type: 'UI.ReferenceFacet', ID: 'Details', Label: 'Request', Target: '@UI.FieldGroup#Details'},
        {$Type: 'UI.ReferenceFacet', ID: 'Sourcing', Label: 'Sourcing', Target: '@UI.FieldGroup#Sourcing'},
        {$Type: 'UI.ReferenceFacet', ID: 'Admin', Label: 'Tracking', Target: '@UI.FieldGroup#Admin'}
      ]
    },
    {$Type: 'UI.ReferenceFacet', ID: 'Items', Label: 'Items', Target: 'items/@UI.LineItem'},
    {$Type: 'UI.ReferenceFacet', ID: 'Compliance', Label: 'Compliance Checks', Target: 'checks/@UI.PresentationVariant'},
    {$Type: 'UI.ReferenceFacet', ID: 'Approvals', Label: 'Approvals', Target: 'tasks/@UI.PresentationVariant'},
    {$Type: 'UI.ReferenceFacet', ID: 'PurchaseOrders', Label: 'Purchase Orders', Target: 'purchaseOrders/@UI.LineItem'},
    {$Type: 'UI.ReferenceFacet', ID: 'History', Label: 'History', Target: 'events/@UI.PresentationVariant'}
  ],
  UI.FieldGroup #Details      : {Data: [
    {Value: title},
    {Value: justification},
    {Value: category_code},
    {Value: costCenter_code},
    {Value: needByDate}
  ]},
  UI.FieldGroup #Sourcing     : {Data: [
    {Value: vendor_ID},
    {Value: currency_code},
    {Value: quotesObtained},
    {Value: totalAmount}
  ]},
  UI.FieldGroup #Admin        : {Data: [
    {Value: prNumber},
    {Value: requester_userId},
    {Value: revision},
    {Value: submittedAt},
    {Value: decidedAt},
    {Value: budgetCommitted}
  ]}
);

annotate service.PurchaseRequisitions with {
  prNumber          @readonly;
  requester         @readonly;
  totalAmount       @readonly;
  status            @readonly;
  currentLevel      @readonly;
  complianceOutcome @readonly;
  revision          @readonly;
  submittedAt       @readonly;
  decidedAt         @readonly;
  budgetCommitted   @readonly;
  vendor            @Common.ValueList: {
    CollectionPath: 'Vendors',
    Parameters    : [
      {$Type: 'Common.ValueListParameterInOut', LocalDataProperty: vendor_ID, ValueListProperty: 'ID'},
      {$Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'name'},
      {$Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'category_code'},
      {$Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'rating'},
      {$Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'status'}
    ]
  };
  costCenter        @Common.ValueList: {
    CollectionPath: 'CostCenters',
    Parameters    : [
      {$Type: 'Common.ValueListParameterInOut', LocalDataProperty: costCenter_code, ValueListProperty: 'code'},
      {$Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'name'}
    ]
  };
  category          @Common.ValueListWithFixedValues
                    @Common.ValueList: {
    CollectionPath: 'Categories',
    Parameters    : [
      {$Type: 'Common.ValueListParameterInOut', LocalDataProperty: category_code, ValueListProperty: 'code'},
      {$Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'name'}
    ]
  };
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------
annotate service.PRItems with @(
  UI.HeaderInfo: {TypeName: 'Item', TypeNamePlural: 'Items', Title: {Value: description}},
  UI.LineItem  : [
    {Value: itemNo},
    {Value: material_ID},
    {Value: description},
    {Value: quantity},
    {Value: unitPrice},
    {Value: netAmount},
    {Value: deliveryDate}
  ],
  UI.Facets    : [{$Type: 'UI.ReferenceFacet', ID: 'ItemDetails', Label: 'Item', Target: '@UI.FieldGroup#Item'}],
  UI.FieldGroup #Item: {Data: [
    {Value: itemNo},
    {Value: material_ID},
    {Value: description},
    {Value: quantity},
    {Value: uom},
    {Value: unitPrice},
    {Value: netAmount},
    {Value: deliveryDate},
    {Value: orderedQty}
  ]}
) {
  itemNo     @readonly;
  netAmount  @readonly;
  orderedQty @readonly;
  material   @Common.ValueList: {
    CollectionPath: 'Materials',
    Parameters    : [
      {$Type: 'Common.ValueListParameterInOut', LocalDataProperty: material_ID, ValueListProperty: 'ID'},
      {$Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'description'},
      {$Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'category_code'},
      {$Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'standardPrice'},
      {$Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'uom'}
    ]
  };
}

// ---------------------------------------------------------------------------
// Read-only sub-lists
// ---------------------------------------------------------------------------
annotate service.ComplianceChecks with @(
  UI.LineItem           : [
    {Value: checkType},
    {Value: result, Criticality: criticality, CriticalityRepresentation: #WithIcon},
    {Value: message},
    {Value: revision},
    {Value: durationMs}
  ],
  UI.PresentationVariant: {
    SortOrder     : [{Property: revision, Descending: true}, {Property: checkType}],
    Visualizations: ['@UI.LineItem']
  }
);

annotate service.ApprovalTasks with @(
  UI.LineItem           : [
    {Value: level},
    {Value: approverName, Label: 'Approver'},
    {Value: status, Criticality: criticality, CriticalityRepresentation: #WithIcon},
    {Value: decidedAt},
    {Value: decidedVia},
    {Value: comment}
  ],
  UI.PresentationVariant: {
    SortOrder     : [{Property: createdAt, Descending: true}, {Property: level}],
    Visualizations: ['@UI.LineItem']
  }
);

annotate service.PurchaseOrders with @(
  UI.LineItem: [
    {
      $Type         : 'UI.DataFieldWithIntentBasedNavigation',
      Value         : poNumber,
      SemanticObject: 'PurchaseOrder',
      Action        : 'manage',
      Mapping       : [{LocalProperty: poNumber, SemanticObjectProperty: 'poNumber'}]
    },
    {Value: totalAmount},
    {Value: reconStatus, Criticality: reconCriticality, CriticalityRepresentation: #WithIcon},
    {Value: s4Status, Criticality: s4Criticality, CriticalityRepresentation: #WithIcon},
    {Value: s4PONumber},
    {Value: createdAt, Label: 'Created On'}
  ]
);

annotate service.WorkflowEvents with @(
  UI.LineItem           : [
    {Value: at},
    {Value: type},
    {Value: level},
    {Value: actor},
    {Value: message}
  ],
  UI.PresentationVariant: {
    SortOrder     : [{Property: at, Descending: true}],
    Visualizations: ['@UI.LineItem']
  }
);
