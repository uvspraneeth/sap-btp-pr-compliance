sap.ui.define([
	"sap/m/MessageToast",
	"sap/m/MessageBox",
	"sap/ui/core/BusyIndicator"
], function (MessageToast, MessageBox, BusyIndicator) {
	"use strict";

	/** Cross-app navigation to the new PO (semantic key poNumber -> object page) */
	async function navigateToPO(sPONumber) {
		const Container = sap.ui.require("sap/ushell/Container");
		if (!Container) {
			return false; // standalone (no launchpad)
		}
		const oTarget = { target: { semanticObject: "PurchaseOrder", action: "manage" }, params: { poNumber: sPONumber } };
		try {
			const oNavigation = await Container.getServiceAsync("Navigation");
			await oNavigation.navigate(oTarget);
		} catch (oError) {
			const oCrossAppNav = await Container.getServiceAsync("CrossApplicationNavigation");
			oCrossAppNav.toExternal(oTarget);
		}
		return true;
	}

	return {
		/**
		 * Object page header action (enabled when status = Approved): creates the
		 * Purchase Order from the approved PR and opens it. `this` is the FE ExtensionAPI.
		 */
		createPurchaseOrder: async function (oContext) {
			const oExtensionAPI = this;
			const oOperation = oContext.getModel().bindContext("RequisitionService.createPurchaseOrder(...)", oContext,
				{ $select: "ID,poNumber" });
			BusyIndicator.show(200);
			try {
				await (oOperation.invoke ? oOperation.invoke() : oOperation.execute());
				const oPO = await oOperation.getBoundContext().requestObject();
				MessageToast.show(`Purchase order ${oPO.poNumber} created`);
				await oExtensionAPI.refresh();
				await navigateToPO(oPO.poNumber);
			} catch (oError) {
				MessageBox.error(oError.message || String(oError));
			} finally {
				BusyIndicator.hide();
				oOperation.destroy();
			}
		}
	};
});
