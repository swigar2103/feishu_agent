import { buildWriterSourceEvidence, writeDraft } from "../../services/agent/writerAgent.js";
import { WriterOutputSchema } from "../../schemas/index.js";
import type { ReportGraphStateType } from "../state.js";

export async function writerAgentNode(
  state: ReportGraphStateType,
): Promise<Partial<ReportGraphStateType>> {
  if (!state.taskRequest || !state.executionPlan || !state.analysisResult || !state.skillMatch) {
    throw new Error("writer_agent 缺少前置状态");
  }

  const sourceEvidence = buildWriterSourceEvidence(state.detailedContext);

  const draft = await writeDraft({
    userRequest: state.taskRequest.userRequest,
    plan: state.executionPlan,
    analysis: state.analysisResult,
    skillMatch: state.skillMatch,
    rewriteHints: state.styleRewriteHints,
    sourceEvidence: sourceEvidence || undefined,
  });

  return {
    draft,
    writerOutput: WriterOutputSchema.parse(draft),
    debugTrace: [`[writer_agent] draft title=${draft.title}`],
  };
}
