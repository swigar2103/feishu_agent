import { generateTaskPlan } from "../../llm/orchestratorModel.js";
import { TaskPlanSchema } from "../../schemas/index.js";
import type { ReportGraphStateType } from "../state.js";

export async function plannerNode(
  state: ReportGraphStateType,
): Promise<Partial<ReportGraphStateType>> {
  if (!state.userRequest) {
    throw new Error("planner_node 缺少 userRequest");
  }
  if (!state.retrievalContext) {
    throw new Error("planner_node 缺少 retrievalContext（请确认 retriever_node 在 planner_node 之前执行）");
  }

  const matchedSkillId = state.retrievalContext.matchedSkill.skillId;

  // LLM 做真正的规划决策，产出 TaskPlan
  const rawPlan = await generateTaskPlan(
    state.userRequest,
    state.retrievalContext,
  );

  // 强约束：selectedSkillId 必须来自已匹配的 skill，不允许 LLM 乱填
  const taskPlan = TaskPlanSchema.parse({
    ...rawPlan,
    selectedSkillId: matchedSkillId,
  });

  return {
    taskPlan,
    debugTrace: [
      `[planner_node] intent=${state.taskIntent ?? "unknown"} skillId=${matchedSkillId}`,
      `[planner_node] plan: sections=${taskPlan.targetSections.length} missing=${taskPlan.missingFields.length} sources=${taskPlan.useSources.length}`,
    ],
  };
}
