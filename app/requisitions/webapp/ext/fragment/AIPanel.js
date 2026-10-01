sap.ui.define([
	"sap/ui/model/json/JSONModel",
	"sap/ui/model/Sorter",
	"sap/ui/model/Filter",
	"sap/m/MessageToast",
	"sap/base/Log"
], function (JSONModel, Sorter, Filter, MessageToast, Log) {
	"use strict";

	const MODEL = "ai";

	function getBox(oControl) {
		let oBox = oControl;
		while (oBox && !(oBox.isA("sap.m.VBox") && oBox.getId().endsWith("aiBox"))) {
			oBox = oBox.getParent();
		}
		return oBox;
	}

	function ensureModel(oBox) {
		let oModel = oBox.getModel(MODEL);
		if (!oModel) {
			oModel = new JSONModel({ active: undefined, busy: false, error: "", rec: null, meta: "" });
			oBox.setModel(oModel, MODEL);
		}
		return oModel;
	}

	function text(oBox, sKey, aArgs) {
		const oI18n = oBox.getModel("i18n");
		return oI18n ? oI18n.getResourceBundle().getText(sKey, aArgs) : sKey;
	}

	/** Maps a stored AIRecommendations row to the view model */
	function toViewModel(oRow) {
		let oPayload = {};
		try {
			oPayload = typeof oRow.payload === "string" ? JSON.parse(oRow.payload) : (oRow.payload || {});
		} catch (oError) {
			Log.warning("AI payload is not valid JSON", oError, "pr.requisitions");
		}
		const oRec = Object.assign({ summary: oRow.summary }, oPayload);
		const sWhen = oRow.createdAt ? new Date(oRow.createdAt).toLocaleString() : "";
		return { rec: oRec, meta: [oRow.model, sWhen].filter(Boolean).join(" · ") };
	}

	function errorText(oBox, oError) {
		const iStatus = oError && oError.status;
		if (iStatus === 429) {
			return text(oBox, "aiRateLimited");
		}
		if (iStatus === 502 || iStatus === 503 || iStatus === 504) {
			return text(oBox, "aiUnavailable");
		}
		return (oError && oError.message) || text(oBox, "aiUnavailable");
	}

	async function loadLatest(oBox, oContext) {
		const oModel = ensureModel(oBox);
		const bActive = !!oContext && oContext.getProperty("IsActiveEntity") === true;
		oModel.setProperty("/active", oContext ? bActive : undefined);
		if (!bActive) {
			return; // keep the advice visible while editing (enables "Use vendor")
		}
		const sPath = oContext.getPath();
		if (oBox._aiPath === sPath) {
			return;
		}
		oBox._aiPath = sPath;
		oModel.setData({ active: true, busy: false, error: "", rec: null, meta: "" });
		const oList = oContext.getModel().bindList("recommendations", oContext, [new Sorter("createdAt", true)],
			[new Filter("type", "EQ", "PR_ADVICE")],
			{ $$ownRequest: true, $select: "ID,type,model,summary,payload,createdAt" });
		try {
			const aContexts = await oList.requestContexts(0, 1);
			if (aContexts.length && oBox._aiPath === sPath) {
				const oVM = toViewModel(aContexts[0].getObject());
				oModel.setProperty("/rec", oVM.rec);
				oModel.setProperty("/meta", oVM.meta);
			}
		} catch (oError) {
			Log.warning("Latest AI recommendation could not be read", oError, "pr.requisitions");
		} finally {
			oList.destroy();
		}
	}

	return {
		/** Formatter of the hidden trigger text - always returns an empty text.
		 *  FE templating does not call it with the control as `this`, so it must not do any work. */
		trigger: function () {
			return "";
		},

		/** VBox modelContextChange: loads the latest advice on context change and on any change of the trigger parts */
		onModelContextChange: function (oEvent) {
			const oBox = oEvent.getSource();
			const schedule = () => {
				ensureModel(oBox);
				clearTimeout(oBox._aiTimer);
				oBox._aiTimer = setTimeout(() => loadLatest(oBox, oBox.getBindingContext()), 150);
			};
			const oBinding = oBox.getItems()[0] && oBox.getItems()[0].getBinding("text");
			if (oBinding && oBox._aiBinding !== oBinding) {
				oBox._aiBinding = oBinding;
				oBinding.attachChange(schedule);
			}
			schedule();
		},

		onGetRecommendations: async function (oEvent) {
			const oButton = oEvent.getSource();
			const oBox = getBox(oButton);
			const oContext = oButton.getBindingContext();
			if (!oBox || !oContext || oContext.getProperty("IsActiveEntity") !== true) {
				return;
			}
			const oModel = ensureModel(oBox);
			oModel.setProperty("/busy", true);
			oModel.setProperty("/error", "");
			const oOperation = oContext.getModel().bindContext("RequisitionService.getRecommendations(...)", oContext,
				{ $select: "ID,type,model,summary,payload,createdAt" });
			try {
				await (oOperation.invoke ? oOperation.invoke() : oOperation.execute());
				const oVM = toViewModel(await oOperation.getBoundContext().requestObject());
				oModel.setProperty("/rec", oVM.rec);
				oModel.setProperty("/meta", oVM.meta);
				MessageToast.show(text(oBox, "aiReceived"));
			} catch (oError) {
				oModel.setProperty("/error", errorText(oBox, oError));
			} finally {
				oModel.setProperty("/busy", false);
				oOperation.destroy();
			}
		},

		/** Draft mode only: copies the suggested vendor into the PR (the user still saves) */
		onApplyVendor: function (oEvent) {
			const oButton = oEvent.getSource();
			const oBox = getBox(oButton);
			const oContext = oButton.getBindingContext();
			const sVendor = oBox && oBox.getModel(MODEL).getProperty("/rec/vendorRecommendation/vendorID");
			if (oContext && sVendor && oContext.getProperty("IsActiveEntity") === false) {
				oContext.setProperty("vendor_ID", sVendor);
				MessageToast.show(text(oBox, "aiVendorApplied", [sVendor]));
			}
		}
	};
});
