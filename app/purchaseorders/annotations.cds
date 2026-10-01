using PurchasingService as service from '../../srv/purchasing-service';

// ---------------------------------------------------------------------------
// Purchase Orders - PR<->PO reconciliation and S/4HANA posting
// ---------------------------------------------------------------------------
annotate service.PurchaseOrders with @(
  // mirror the server guard (purchasing-service.js LOCKED): queued/posted POs can't be changed
  UI.UpdateHidden             : {$edmJson: {$Or: [
    {$Eq: [{$Path: 's4Status'}, 'Posted']},
    {$Eq: [{$Path: 's4Status'}, 'Queued']}
  ]}},
  Common.SemanticKey          : [poNumber],
  UI.HeaderInfo               : {
    TypeName      : 'Purchase Order',
    TypeNamePlural: 'Purchase Orders',
    TypeImageUrl  : 'sap-icon://sales-order',
    Title         : {Value: poNumber},
    Description   : {Value: vendor_ID}
  },
  UI.SelectionFields          : [
    reconStatus,
    s4Status,
    vendor_ID,
    poNumber
  ],
  UI.PresentationVariant      : {
    SortOrder     : [{Property: createdAt, Descending: true}],
    Visualizations: ['@UI.LineItem']
  },
  UI.LineItem                 : [
    {Value: poNumber},
    {
      $Type         : 'UI.DataFieldWithIntentBasedNavigation',
      Value         : pr_ID,
      Label         : 'Purchase Requisition',
      SemanticObject: 'PurchaseRequisition',
      Action        : 'manage',
      Mapping       : [{LocalProperty: pr_ID, SemanticObjectProperty: 'ID'}]
    },
    {Value: vendor_ID},
    {Value: totalAmount},
    {Value: reconStatus, Criticality: reconCriticality, CriticalityRepresentation: #WithIcon},
    {Value: varianceApproval},
    {Value: s4Status, Criticality: s4Criticality, CriticalityRepresentation: #WithIcon},
    {Value: s4PONumber},
    {Value: createdAt, Label: 'Created On'}
  ],

  UI.HeaderFacets             : [
    {$Type: 'UI.ReferenceFacet', ID: 'HdrRecon', Target: '@UI.DataPoint#recon'},
    {$Type: 'UI.ReferenceFacet', ID: 'HdrS4', Target: '@UI.DataPoint#s4'},
    {$Type: 'UI.ReferenceFacet', ID: 'HdrTotal', Target: '@UI.DataPoint#total'},
    {$Type: 'UI.ReferenceFacet', ID: 'HdrS4PO', Target: '@UI.DataPoint#s4po'}
  ],
  UI.DataPoint #recon         : {Value: reconStatus, Title: 'Reconciliation', Criticality: reconCriticality},
  UI.DataPoint #s4            : {Value: s4Status, Title: 'S/4HANA Status', Criticality: s4Criticality},
  UI.DataPoint #total         : {Value: totalAmount, Title: 'Total Amount'},
  UI.DataPoint #s4po          : {Value: s4PONumber, Title: 'S/4HANA PO'},

  UI.Identification           : [
    {$Type: 'UI.DataFieldForAction', Action: 'PurchasingService.reconcile', Label: 'Reconcile'},
    {$Type: 'UI.DataFieldForAction', Action: 'PurchasingService.requestVarianceApproval', Label: 'Request Variance Approval'},
    {$Type: 'UI.DataFieldForAction', Action: 'PurchasingService.postToS4', Label: 'Post to S/4HANA'}
  ],
  UI.Facets                   : [
    {
      $Type : 'UI.CollectionFacet',
      ID    : 'General',
      Label : 'General Information',
      Facets: [
        {$Type: 'UI.ReferenceFacet', ID: 'Order', Label: 'Order', Target: '@UI.FieldGroup#Order'},
        {$Type: 'UI.ReferenceFacet', ID: 'Org', Label: 'Purchasing Organization', Target: '@UI.FieldGroup#Org'}
      ]
    },
    {$Type: 'UI.ReferenceFacet', ID: 'Items', Label: 'Items', Target: 'items/@UI.LineItem'},
    {$Type: 'UI.ReferenceFacet', ID: 'Reconciliation', Label: 'PR / PO Reconciliation', Target: 'reconResults/@UI.PresentationVariant'},
    {$Type: 'UI.ReferenceFacet', ID: 'S4', Label: 'S/4HANA', Target: '@UI.FieldGroup#S4'}
  ],
  UI.FieldGroup #Order        : {Data: [
    {Value: poNumber},
    {Value: pr_ID},
    {Value: vendor_ID},
    {Value: currency_code},
    {Value: totalAmount},
    {Value: reconStatus, Criticality: reconCriticality, CriticalityRepresentation: #WithIcon},
    {Value: varianceApproval}
  ]},
  UI.FieldGroup #Org          : {Data: [
    {Value: companyCode_code},
    {Value: purchasingOrg},
    {Value: purchasingGroup},
    {Value: plant}
  ]},
  UI.FieldGroup #S4           : {Data: [
    {Value: s4Status, Criticality: s4Criticality, CriticalityRepresentation: #WithIcon},
    {Value: s4PONumber},
    {Value: s4PostedAt},
    {Value: s4Error}
  ]}
) {
  poNumber         @readonly;
  pr               @readonly;
  totalAmount      @readonly;
  reconStatus      @readonly;
  varianceApproval @readonly;
  s4Status         @readonly;
  s4PONumber       @readonly;
  s4Error          @readonly;
  s4PostedAt       @readonly;
  currency         @readonly;
  companyCode      @readonly;
  vendor           @Common.ValueList: {
    CollectionPath: 'Vendors',
    Parameters    : [
      {$Type: 'Common.ValueListParameterInOut', LocalDataProperty: vendor_ID, ValueListProperty: 'ID'},
      {$Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'name'},
      {$Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'status'},
      {$Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 's4Supplier'}
    ]
  };
}

annotate service.PurchaseOrders actions {
  requestVarianceApproval(reason @title: 'Reason for the variance' @UI.MultiLineText);
};

annotate service.POItems with @(
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
    {Value: deliveryDate}
  ]}
) {
  itemNo    @readonly;
  material  @readonly;
  netAmount @readonly;
  uom       @readonly;
}

annotate service.ReconciliationResults with @(
  UI.LineItem           : [
    {Value: itemNo},
    {Value: checkType},
    {Value: result, Criticality: criticality, CriticalityRepresentation: #WithIcon},
    {Value: expected},
    {Value: actual},
    {Value: message}
  ],
  UI.PresentationVariant: {
    SortOrder     : [{Property: itemNo}, {Property: checkType}],
    Visualizations: ['@UI.LineItem']
  }
);

annotate service.PurchaseRequisitions with {
  ID @Common: {Text: prNumber, TextArrangement: #TextOnly};
}
