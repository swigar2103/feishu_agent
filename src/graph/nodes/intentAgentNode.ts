import { detectIntentWithLlm } from "../../services/agent/intentAgent.js";
import { publishPipelineProgress } from "../../services/progress/pipelineProgress.js";
import type { ReportGraphStateType } from "../state.js";

export async function intentAgentNode(
  state: ReportGraphStateType,
): Promise<Partial<ReportGraphStateType>> {
  if (!state.taskRequest || !state.candidateResources) {
    throw new Error("intent_agent 缺少 taskRequest/candidateResources");
  }

  const intentResult = await detectIntentWithLlm({
    userRequest: state.taskRequest.userRequest,
    screened: state.candidateResources,
  });
  publishPipelineProgress({
    sessionId: state.taskRequest.userRequest.sessionId,
    stage: "intent",
    message: "意图识别完成",
    meta: {
      taskIntent: intentResult.taskIntent,
      outputKind: intentResult.outputKind,
    },
  });

  return {
    intentResult,
    taskIntent: intentResult.taskIntent,
    debugTrace: [
      `[intent_agent] intent=${intentResult.taskIntent} output=${intentResult.outputKind}`,
    ],
  };
}
