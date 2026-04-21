import { WriterInputSchema } from "../../schemas/index.js";
import type { ReportGraphStateType } from "../state.js";

export async function buildWriterInput(
  state: ReportGraphStateType,
): Promise<Partial<ReportGraphStateType>> {
  if (!state.userRequest || !state.taskPlan || !state.retrievalContext) {
    throw new Error("build_writer_input 缺少必要状态");
  }

  const writerInput = WriterInputSchema.parse({
    userRequest: state.userRequest,
    taskPlan: state.taskPlan,
    retrievalContext: state.retrievalContext,
    analystOutput: state.analystOutput ?? undefined,
  });

  const kpiCount = writerInput.analystOutput?.kpis.length ?? 0;
  const chartCount = writerInput.analystOutput?.chartCandidates.length ?? 0;

  return {
    writerInput,
    debugTrace: [
      `[build_writer_input] sections=${writerInput.taskPlan.targetSections.length} kpis=${kpiCount} charts=${chartCount}`,
    ],
  };
}
