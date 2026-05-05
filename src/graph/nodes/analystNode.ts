import { generateTaskPlan } from "../../llm/orchestratorModel.js";
import type { ReportGraphStateType } from "../state.js";

export async function analystNode(
  state: ReportGraphStateType,
): Promise<Partial<ReportGraphStateType>> {
  if (!state.userRequest || !state.retrievalContext) {
    throw new Error("analyst_node 缺少 userRequest/retrievalContext");
  }

  const taskPlan = await generateTaskPlan(state.userRequest, state.retrievalContext);
  const followUpQuestions = taskPlan.missingFields.map(
    (field) => `待补充信息：${field}`,
  );

  return {
    taskPlan,
    followUpQuestions,
    debugTrace: [
      `[analyst_node] normalized metrics and planned sections=${taskPlan.targetSections.length}`,
      `[analyst_node] follow-up questions=${followUpQuestions.length}`,
    ],
  };
}
