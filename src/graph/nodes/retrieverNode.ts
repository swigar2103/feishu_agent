import { RetrievalContextSchema } from "../../schemas/index.js";
import { getContextForReport } from "../../services/retrievalClient.js";
import type { ReportGraphStateType } from "../state.js";

export async function retrieverNode(
  state: ReportGraphStateType,
): Promise<Partial<ReportGraphStateType>> {
  if (!state.userRequest) {
    throw new Error("retriever_node 缺少 userRequest");
  }

  const retrievalContext = RetrievalContextSchema.parse(
    await getContextForReport(state.userRequest, state.taskPlan ?? undefined, {
      taskIntent: state.taskIntent ?? undefined,
    }),
  );

  const poolDebugHints = retrievalContext.styleHints.filter(
    (line) =>
      line.startsWith("B2_") ||
      line.startsWith("B3_POOL") ||
      line.startsWith("RESOURCE_POOL"),
  );

  return {
    retrievalContext,
    debugTrace: [
      `[retriever_node] loaded contexts=${retrievalContext.projectContext.length}`,
      `[retriever_node] matched skill=${retrievalContext.matchedSkill.skillId}`,
      ...poolDebugHints,
    ],
  };
}
