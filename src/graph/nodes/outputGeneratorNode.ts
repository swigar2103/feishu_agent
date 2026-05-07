import { generateFinalOutput } from "../../services/agent/outputGenerator.js";
import { publishPipelineProgress } from "../../services/progress/pipelineProgress.js";
import type { ReportGraphStateType } from "../state.js";

export async function outputGeneratorNode(
  state: ReportGraphStateType,
): Promise<Partial<ReportGraphStateType>> {
  if (!state.taskRequest || !state.intentResult || !state.draft) {
    throw new Error("output_generator 缺少 taskRequest/intentResult/draft");
  }

  const finalDeliverable = await generateFinalOutput({
    request: state.taskRequest.userRequest,
    intent: state.intentResult,
    draft: state.draft,
    renderedArtifacts: state.renderedArtifacts,
  });
  publishPipelineProgress({
    sessionId: state.taskRequest.userRequest.sessionId,
    stage: "output",
    message: "产物发布完成",
    meta: {
      outputKind: finalDeliverable.outputKind,
      targetCount: finalDeliverable.outputTargets.length,
    },
  });

  return {
    finalDeliverable,
    debugTrace: [
      `[output_generator] output=${finalDeliverable.outputKind} targets=${finalDeliverable.outputTargets.join(",")}`,
    ],
  };
}
