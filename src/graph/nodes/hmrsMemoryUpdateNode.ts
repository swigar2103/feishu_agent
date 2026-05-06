import { updateMemoryFromRun } from "../../services/agent/memoryUpdater.js";
import { publishPipelineProgress } from "../../services/progress/pipelineProgress.js";
import type { ReportGraphStateType } from "../state.js";

export async function hmrsMemoryUpdateNode(
  state: ReportGraphStateType,
): Promise<Partial<ReportGraphStateType>> {
  if (!state.taskRequest || !state.draft) {
    throw new Error("hmrs_memory_update 缺少 taskRequest/draft");
  }
  const memoryUpdate = await updateMemoryFromRun({
    request: state.taskRequest.userRequest,
    draft: state.draft,
  });
  publishPipelineProgress({
    sessionId: state.taskRequest.userRequest.sessionId,
    stage: "memory_update",
    message: "记忆写回完成",
    meta: {
      updated: memoryUpdate.updated,
      learnedPreferenceCount: memoryUpdate.learnedPreferences.length,
    },
  });
  return {
    memoryUpdate,
    debugTrace: [
      `[hmrs_memory_update] updated=${memoryUpdate.updated}`,
    ],
  };
}
