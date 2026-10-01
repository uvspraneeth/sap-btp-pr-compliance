sap.ui.define([
	"sap/m/MessageBox",
	"sap/ui/core/BusyIndicator"
], function (MessageBox, BusyIndicator) {
	"use strict";

	/** The brief may come back as plain text or as a small JSON document */
	function format(vBrief) {
		let oBrief = vBrief;
		if (typeof vBrief === "string") {
			try {
				oBrief = JSON.parse(vBrief);
			} catch (e) {
				return vBrief;
			}
		}
		if (!oBrief || typeof oBrief !== "object") {
			return String(vBrief ?? "");
		}
		const aLines = [];
		if (oBrief.summary) {
			aLines.push(oBrief.summary, "");
		}
		for (const [sKey, sLabel] of [["risks", "Risks"], ["strengths", "Strengths"], ["questions", "Questions for the requester"], ["complianceHints", "Compliance"]]) {
			if (Array.isArray(oBrief[sKey]) && oBrief[sKey].length) {
				aLines.push(sLabel + ":", ...oBrief[sKey].map((s) => "• " + s), "");
			}
		}
		if (oBrief.recommendation) {
			aLines.push("Recommendation: " + oBrief.recommendation);
		}
		return aLines.join("\n").trim() || JSON.stringify(oBrief, null, 2);
	}

	return {
		/** Object page header action: advisory AI brief for the approver (this = FE ExtensionAPI) */
		showApprovalBrief: async function (oContext) {
			const oI18n = this.getModel("i18n");
			const t = (sKey) => (oI18n ? oI18n.getResourceBundle().getText(sKey) : sKey);
			const oOperation = oContext.getModel().bindContext("ApprovalService.getApprovalBrief(...)", oContext);
			BusyIndicator.show(200);
			try {
				await (oOperation.invoke ? oOperation.invoke() : oOperation.execute());
				const oResult = await oOperation.getBoundContext().requestObject();
				MessageBox.information(format(oResult && oResult.value), { title: t("aiBriefTitle"), contentWidth: "36rem" });
			} catch (oError) {
				MessageBox.warning((oError && oError.message) || t("aiBriefUnavailable"), { title: t("aiBriefTitle") });
			} finally {
				BusyIndicator.hide();
				oOperation.destroy();
			}
		}
	};
});
