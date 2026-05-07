import { reviewCompliance } from "../../services/agent/complianceReviewer.js";
import type { ReportGraphStateType } from "../state.js";

const MAX_COMPLIANCE_RETRY = 2;

export async function complianceReviewerNode(
  state: ReportGraphStateType,
): Promise<Partial<ReportGraphStateType>> {
  if (!state.draft || !state.executionPlan || !state.skillMatch) {
    throw new Error("compliance_reviewer 缺少 draft/executionPlan/skillMatch");
  }

  const result = await reviewCompliance({
    draft: state.draft,
    plan: state.executionPlan,
    requiredInputs: state.skillMatch.selectedSkill.requiredInputs,
    terminology: state.skillMatch.selectedSkill.terminology,
    reviewRules: state.skillMatch.workflowMeta?.reviewRules ?? [],
  });

  const loop = state.complianceLoopCount + 1;
  let route: "to_planner" | "to_analyst" | "to_publish" = "to_publish";
  if (!result.pass && loop <= MAX_COMPLIANCE_RETRY) {
    route = result.issueType === "data_quality" ? "to_analyst" : "to_planner";
  }

  return {
    complianceReviewResult: result,
    complianceLoopCount: loop,
    callbackRoute: route,
    debugTrace: [
      `[compliance_reviewer] pass=${result.pass} issueType=${result.issueType} route=${route}`,
    ],
  };
}
