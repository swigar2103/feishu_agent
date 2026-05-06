import { updateMemoryFromRun } from "../../services/agent/memoryUpdater.js";
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
  return {
    memoryUpdate,
    debugTrace: [
      `[hmrs_memory_update] updated=${memoryUpdate.updated}`,
    ],
  };
}
