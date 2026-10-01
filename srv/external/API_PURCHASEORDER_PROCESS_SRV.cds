/*
 * Lean subset of the S/4HANA "Purchase Order (A2X)" OData V2 API
 * (API_PURCHASEORDER_PROCESS_SRV) - only what this app posts/reads.
 * Names, keys, lengths and creatability were verified against the live
 * $metadata of the connected system (client 900). Importing the full EDMX
 * (~140 KB, 12 entities) would bloat the runtime model for no benefit.
 * Edm.DateTime fields are modelled as DateTime (see lib/s4/po-mapper.js).
 */
@cds.external: true
service API_PURCHASEORDER_PROCESS_SRV {

  entity A_PurchaseOrder {
    key PurchaseOrder              : String(10);
        CompanyCode                : String(4);
        PurchaseOrderType          : String(4);
        PurchaseOrderDate          : DateTime;
        Supplier                   : String(10);
        PurchasingOrganization     : String(4);
        PurchasingGroup            : String(3);
        DocumentCurrency           : String(5);
        Language                   : String(2);
        CorrespncExternalReference : String(12); // = our PO number, used for idempotent retries
        to_PurchaseOrderItem       : Composition of many A_PurchaseOrderItem
                                       on to_PurchaseOrderItem.PurchaseOrder = PurchaseOrder;
  }

  entity A_PurchaseOrderItem {
    key PurchaseOrder             : String(10);
    key PurchaseOrderItem         : String(5);
        Material                  : String(40);
        PurchaseOrderItemText     : String(40);
        MaterialGroup             : String(9);
        Plant                     : String(4);
        OrderQuantity             : Decimal(13, 3);
        PurchaseOrderQuantityUnit : String(3);
        NetPriceAmount            : Decimal(16, 3);
        NetPriceQuantity          : Decimal(5, 0);
        AccountAssignmentCategory : String(1);
        to_AccountAssignment      : Composition of many A_PurOrdAccountAssignment
                                      on  to_AccountAssignment.PurchaseOrder     = PurchaseOrder
                                      and to_AccountAssignment.PurchaseOrderItem = PurchaseOrderItem;
        to_ScheduleLine           : Composition of many A_PurchaseOrderScheduleLine
                                      on  to_ScheduleLine.PurchasingDocument     = PurchaseOrder
                                      and to_ScheduleLine.PurchasingDocumentItem = PurchaseOrderItem;
  }

  entity A_PurOrdAccountAssignment {
    key PurchaseOrder           : String(10);
    key PurchaseOrderItem       : String(5);
    key AccountAssignmentNumber : String(2);
        CostCenter              : String(10);
        GLAccount               : String(10);
        Quantity                : Decimal(13, 3);
  }

  entity A_PurchaseOrderScheduleLine {
    key PurchasingDocument        : String(10);
    key PurchasingDocumentItem    : String(5);
    key ScheduleLine              : String(4);
        ScheduleLineDeliveryDate  : DateTime;
        ScheduleLineOrderQuantity : Decimal(13, 3);
  }
}
