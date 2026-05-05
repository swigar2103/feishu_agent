import { WriterInputSchema } from "../../schemas/index.js";
import { slimRetrievalContextForWriter } from "../../services/writerContextSlim.js";
import type { ReportGraphStateType } from "../state.js";

export async function buildWriterInput(
  state: ReportGraphStateType,
): Promise<Partial<ReportGraphStateType>> {
  if (!state.userRequest || !state.taskPlan || !state.retrievalContext) {
    throw new Error("build_writer_input 缺少必要状态");
  }

  const retrievalForWriter = slimRetrievalContextForWriter(
    state.retrievalContext,
    state.userRequest,
  );

  const writerInput = WriterInputSchema.parse({
    userRequest: state.userRequest,
    taskPlan: state.taskPlan,
    retrievalContext: retrievalForWriter,
  });

  return {
    writerInput,
    debugTrace: [
      `[build_writer_input] writer input assembled sections=${writerInput.taskPlan.targetSections.length}`,
    ],
  };
}
