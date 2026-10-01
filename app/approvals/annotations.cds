using ApprovalService as service from '../../srv/approval-service';

// ---------------------------------------------------------------------------
// My Approvals - worklist (defaults to pending tasks) + read-only object page
// ---------------------------------------------------------------------------
annotate service.MyTasks with @(
  UI.HeaderInfo            : {
    TypeName      : 'Approval Task',
    TypeNamePlural: 'Approval Tasks',
    TypeImageUrl  : 'sap-icon://approvals',
    Title         : {Value: title},
    Description   : {Value: prNumber}
  },
  UI.SelectionFields       : [
    status,
    prNumber,
    levelName,
    complianceOutcome
  ],
  UI.PresentationVariant   : {
    SortOrder     : [{Property: dueAt}],
    Visualizations: ['@UI.LineItem']
  },
  UI.LineItem              : [
    {$Type: 'UI.DataFieldForAction', Action: 'ApprovalService.approve', Label: 'Approve', Inline: true, IconUrl: 'sap-icon://accept'},
    {$Type: 'UI.DataFieldForAction', Action: 'ApprovalService.decline', Label: 'Reject', Inline: true, IconUrl: 'sap-icon://decline'},
    {
      $Type         : 'UI.DataFieldWithIntentBasedNavigation',
      Value         : prNumber,
      SemanticObject: 'PurchaseRequisition',
      Action        : 'manage',
      Mapping       : [{LocalProperty: prNumber, SemanticObjectProperty: 'prNumber'}]
    },
    {Value: title},
    {Value: requesterName},
    {Value: totalAmount},
    {Value: vendorName},
    {Value: levelName},
    {Value: dueAt},
    {Value: complianceOutcome, Criticality: complianceCriticality, CriticalityRepresentation: #WithIcon},
    {Value: status, Criticality: criticality, CriticalityRepresentation: #WithIcon}
  ],

  UI.HeaderFacets          : [
    {$Type: 'UI.ReferenceFacet', ID: 'HdrStatus', Target: '@UI.DataPoint#status'},
    {$Type: 'UI.ReferenceFacet', ID: 'HdrTotal', Target: '@UI.DataPoint#total'},
    {$Type: 'UI.ReferenceFacet', ID: 'HdrCompliance', Target: '@UI.DataPoint#compliance'},
    {$Type: 'UI.ReferenceFacet', ID: 'HdrDue', Target: '@UI.DataPoint#due'}
  ],
  UI.DataPoint #status     : {Value: status, Title: 'Decision', Criticality: criticality},
  UI.DataPoint #total      : {Value: totalAmount, Title: 'Total Amount'},
  UI.DataPoint #compliance : {Value: complianceOutcome, Title: 'Compliance', Criticality: complianceCriticality},
  UI.DataPoint #due        : {Value: dueAt, Title: 'Due On'},

  UI.Identification        : [
    {$Type: 'UI.DataFieldForAction', Action: 'ApprovalService.approve', Label: 'Approve'},
    {$Type: 'UI.DataFieldForAction', Action: 'ApprovalService.decline', Label: 'Reject'},
    {
      $Type         : 'UI.DataFieldForIntentBasedNavigation',
      SemanticObject: 'PurchaseRequisition',
      Action        : 'manage',
      Label         : 'Open PR',
      Mapping       : [{LocalProperty: prNumber, SemanticObjectProperty: 'prNumber'}]
    }
  ],
  UI.Facets                : [
    {$Type: 'UI.ReferenceFacet', ID: 'Request', Label: 'Request', Target: '@UI.FieldGroup#Request'},
    {$Type: 'UI.ReferenceFacet', ID: 'Items', Label: 'Items', Target: 'items/@UI.LineItem'},
    {$Type: 'UI.ReferenceFacet', ID: 'Compliance', Label: 'Compliance Checks', Target: 'checks/@UI.PresentationVariant'},
    {$Type: 'UI.ReferenceFacet', ID: 'Decision', Label: 'Decision', Target: '@UI.FieldGroup#Decision'}
  ],
  UI.FieldGroup #Request   : {Data: [
    {
      $Type         : 'UI.DataFieldWithIntentBasedNavigation',
      Value         : prNumber,
      SemanticObject: 'PurchaseRequisition',
      Action        : 'manage',
      Mapping       : [{LocalProperty: prNumber, SemanticObjectProperty: 'prNumber'}]
    },
    {Value: title},
    {Value: justification},
    {Value: requesterName},
    {Value: vendorName},
    {Value: costCenter},
    {Value: categoryName},
    {Value: totalAmount},
    {Value: prStatus}
  ]},
  UI.FieldGroup #Decision  : {Data: [
    {Value: kind},
    {Value: levelName},
    {Value: levelMode},
    {Value: dueAt},
    {Value: status, Criticality: criticality, CriticalityRepresentation: #WithIcon},
    {Value: comment},
    {Value: decidedAt},
    {Value: decidedVia},
    {Value: poNumber}
  ]}
) {
  ID                    @UI.Hidden;
  prID                  @UI.Hidden;
  // flattened keys inherit Common.Text: name from their target entity - there is no name here
  approver_userId       @UI.Hidden;
  criticality           @UI.Hidden;
  complianceCriticality @UI.Hidden;
  status                @Common.FilterDefaultValue: 'Pending';
  prNumber              @title: 'PR Number';
  title                 @title: 'Title';
  justification         @title: 'Business Justification'  @UI.MultiLineText;
  requesterName         @title: 'Requester';
  vendorName            @title: 'Vendor';
  costCenter            @title: 'Cost Center';
  categoryName          @title: 'Category';
  totalAmount           @title: 'Total Amount'  @Measures.ISOCurrency: currency;
  currency              @title: 'Currency'  @Common.Text: null;
  levelName             @title: 'Approval Level';
  levelMode             @title: 'Decision Mode';
  dueAt                 @title: 'Due On';
  complianceOutcome     @title: 'Compliance';
  prStatus              @title: 'PR Status';
  poNumber              @title: 'PO Number';
}

annotate service.MyTasks actions {
  approve(comment @title: 'Comment (optional)' @UI.MultiLineText);
  decline(comment @title: 'Reason for rejection' @UI.MultiLineText);
};

// Paths inherited from common.cds point to associations this service does not expose
annotate service.PRItems with {
  material      @Common: {Text: description, TextArrangement: #TextFirst}; // Materials isn't exposed here
  unitPrice     @Measures.ISOCurrency: currency_code;
  netAmount     @Measures.ISOCurrency: currency_code;
  currency_code @UI.Hidden  @Common.Text: null;
};

annotate service.PRItems with @(UI.LineItem: [
  {Value: itemNo},
  {Value: material_ID},
  {Value: description},
  {Value: quantity},
  {Value: unitPrice},
  {Value: netAmount},
  {Value: deliveryDate}
]);

annotate service.ComplianceChecks with @(
  UI.LineItem           : [
    {Value: checkType},
    {Value: result, Criticality: criticality, CriticalityRepresentation: #WithIcon},
    {Value: message},
    {Value: revision}
  ],
  UI.PresentationVariant: {
    SortOrder     : [{Property: revision, Descending: true}, {Property: checkType}],
    Visualizations: ['@UI.LineItem']
  }
);

// Flattened columns: texts come from the flattened name columns of the projection
annotate service.MyTasks with {
  approver_userId @Common: {Text: approverName, TextArrangement: #TextOnly};
  costCenter      @Common: {Text: costCenterName, TextArrangement: #TextFirst};
  approverName    @UI.Hidden;
  costCenterName  @UI.Hidden;
};
