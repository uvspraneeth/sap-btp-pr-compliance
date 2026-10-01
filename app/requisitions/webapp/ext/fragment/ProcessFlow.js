sap.ui.define([
	"sap/ui/model/json/JSONModel",
	"sap/base/Log"
], function (JSONModel, Log) {
	"use strict";

	const MODEL = "pf";

	function getBox(oControl) {
		let oBox = oControl;
		while (oBox && !(oBox.isA("sap.m.VBox") && oBox.getId().endsWith("pfBox"))) {
			oBox = oBox.getParent();
		}
		return oBox;
	}

	function ensureModel(oBox) {
		let oModel = oBox.getModel(MODEL);
		if (!oModel) {
			oModel = new JSONModel({ active: undefined, busy: false, error: "", lanes: [], nodes: [] });
			oBox.setModel(oModel, MODEL);
		}
		return oModel;
	}

	function getFlow(oBox) {
		return oBox.getItems().find((oItem) => oItem.isA("sap.suite.ui.commons.ProcessFlow"));
	}

	async function invokeFunction(oContext) {
		// Bound function PurchaseRequisitions/getProcessFlow() returns a JSON string
		const oOperation = oContext.getModel().bindContext("RequisitionService.getProcessFlow(...)", oContext);
		try {
			await (oOperation.invoke ? oOperation.invoke() : oOperation.execute());
			const oResult = await oOperation.getBoundContext().requestObject();
			const vValue = oResult && oResult.value;
			return typeof vValue === "string" ? JSON.parse(vValue) : (vValue || {});
		} finally {
			oOperation.destroy();
		}
	}

	async function load(oBox, oContext) {
		const oModel = ensureModel(oBox);
		if (!oContext || oContext.getProperty("IsActiveEntity") !== true) {
			oModel.setData({ active: false, busy: false, error: "", lanes: [], nodes: [] });
			return;
		}
		const sPath = oContext.getPath();
		oBox._pfPath = sPath;
		oModel.setProperty("/active", true);
		oModel.setProperty("/busy", true);
		try {
			const oFlow = await invokeFunction(oContext);
			if (oBox._pfPath !== sPath) {
				return; // user navigated to another PR meanwhile
			}
			oModel.setData({ active: true, busy: false, error: "", lanes: oFlow.lanes || [], nodes: oFlow.nodes || [] });
			const oProcessFlow = getFlow(oBox);
			if (oProcessFlow) {
				oProcessFlow.updateModel();
			}
		} catch (oError) {
			Log.error("Process flow could not be loaded", oError, "pr.requisitions");
			oModel.setProperty("/busy", false);
			oModel.setProperty("/error", oError.message || String(oError));
		}
	}

	function schedule(oControl) {
		const oBox = getBox(oControl);
		if (!oBox) {
			return;
		}
		ensureModel(oBox);
		clearTimeout(oBox._pfTimer);
		// debounce: the formatter fires once per binding part
		oBox._pfTimer = setTimeout(() => load(oBox, oControl.getBindingContext()), 120);
	}

	return {
		/** Formatter of the hidden trigger text - always returns an empty text.
		 *  FE templating does not call it with the control as `this`, so it must not do any work. */
		trigger: function () {
			return "";
		},
		/** VBox modelContextChange: (re)loads on context change and on any change of the trigger parts */
		onModelContextChange: function (oEvent) {
			const oBox = oEvent.getSource();
			const oBinding = oBox.getItems()[0] && oBox.getItems()[0].getBinding("text");
			if (oBinding && oBox._pfBinding !== oBinding) {
				oBox._pfBinding = oBinding;
				oBinding.attachChange(() => schedule(oBox));
			}
			schedule(oBox);
		},
		onRefresh: function (oEvent) {
			const oBox = getBox(oEvent.getSource());
			if (oBox) {
				load(oBox, oEvent.getSource().getBindingContext());
			}
		},
		onZoomIn: function (oEvent) {
			const oFlow = getFlow(getBox(oEvent.getSource()));
			if (oFlow) {
				oFlow.zoomIn();
			}
		},
		onZoomOut: function (oEvent) {
			const oFlow = getFlow(getBox(oEvent.getSource()));
			if (oFlow) {
				oFlow.zoomOut();
			}
		}
	};
});
