import { deepRetrieveContext } from "../../services/retrieval/deepRetriever.js";
import type { ReportGraphStateType } from "../state.js";

export async function hmrsExpansionNode(
  state: ReportGraphStateType,
): Promise<Partial<ReportGraphStateType>> {
  if (!state.taskRequest || !state.executionPlan || !state.candidateResources) {
    throw new Error("hmrs_expansion 缺少前置状态");
  }
  const detailedContext = await deepRetrieveContext({
    request: state.taskRequest.userRequest,
    plan: state.executionPlan,
    screened: state.candidateResources,
  });
  return {
    detailedContext,
    debugTrace: [
      `[hmrs_expansion] facts=${detailedContext.facts.length}`,
    ],
  };
}
