import { deepRetrieveContext } from "../../services/retrieval/deepRetriever.js";
import { publishPipelineProgress } from "../../services/progress/pipelineProgress.js";
import { RetrievalContextSchema } from "../../schemas/index.js";
import type { ReportGraphStateType } from "../state.js";

export async function hmrsExpansionNode(
  state: ReportGraphStateType,
): Promise<Partial<ReportGraphStateType>> {
  if (!state.taskRequest || !state.executionPlan || !state.candidateResources || !state.skillMatch) {
    throw new Error("hmrs_expansion 缺少前置状态");
  }
  const detailedContext = await deepRetrieveContext({
    request: state.taskRequest.userRequest,
    plan: state.executionPlan,
    screened: state.candidateResources,
  });
  publishPipelineProgress({
    sessionId: state.taskRequest.userRequest.sessionId,
    stage: "retriever",
    message: "证据检索完成",
    meta: { factCount: detailedContext.facts.length },
  });
  const retrievalContext = RetrievalContextSchema.parse({
    matchedSkill: state.skillMatch.selectedSkill,
    userMemory: {
      preferredTone: state.executionPlan.targetTone,
      preferredStructure: state.executionPlan.targetSections,
      commonTerms: state.skillMatch.selectedSkill.terminology,
      styleNotes: state.skillMatch.selectedSkill.styleRules,
    },
    projectContext: detailedContext.facts.slice(0, 20).map((item) => ({
      sourceId: item.sourceId,
      sourceType: "doc",
      content: item.fact,
    })),
    glossary: state.skillMatch.selectedSkill.terminology,
    styleHints: [
      ...state.skillMatch.selectedSkill.styleRules,
      ...(state.blueprintPlan?.templateGuardrails ?? []),
    ],
    templateDistillation: detailedContext.templateDistillation,
  });
  return {
    detailedContext,
    retrievalContext,
    debugTrace: [
      `[hmrs_expansion] facts=${detailedContext.facts.length} template_profiles=${Object.keys(detailedContext.templateDistillation?.profilesByResourceId ?? {}).length}`,
    ],
  };
}
