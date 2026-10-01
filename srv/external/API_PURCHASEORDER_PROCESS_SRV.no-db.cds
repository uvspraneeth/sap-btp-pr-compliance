// Production only (see package.json): the S/4 API is remote there, so its
// entities must not become HANA tables. In development they back the local mock.
using from './API_PURCHASEORDER_PROCESS_SRV';

annotate API_PURCHASEORDER_PROCESS_SRV.A_PurchaseOrder with @cds.persistence.skip;
annotate API_PURCHASEORDER_PROCESS_SRV.A_PurchaseOrderItem with @cds.persistence.skip;
annotate API_PURCHASEORDER_PROCESS_SRV.A_PurOrdAccountAssignment with @cds.persistence.skip;
annotate API_PURCHASEORDER_PROCESS_SRV.A_PurchaseOrderScheduleLine with @cds.persistence.skip;
