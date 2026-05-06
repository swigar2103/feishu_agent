import { generateExecutionPlan } from "../../services/agent/plannerAgent.js";
import { TaskPlanSchema } from "../../schemas/index.js";
import type { ReportGraphStateType } from "../state.js";

export async function plannerAgentNode(
  state: ReportGraphStateType,
): Promise<Partial<ReportGraphStateType>> {
  if (!state.taskRequest || !state.intentResult || !state.skillMatch || !state.candidateResources) {
    throw new Error("planner_agent 缺少前置状态");
  }

  const executionPlan = await generateExecutionPlan({
    userRequest: state.taskRequest.userRequest,
    intent: state.intentResult,
    skillMatch: state.skillMatch,
    screened: state.candidateResources,
  });

  return {
    executionPlan,
    taskPlan: TaskPlanSchema.parse({
      reportType: executionPlan.reportType,
      selectedSkillId: executionPlan.selectedSkillId,
      missingFields: executionPlan.missingFields,
      targetSections: executionPlan.targetSections,
      targetTone: executionPlan.targetTone,
      useSources: executionPlan.prioritizedResourceIds,
    }),
    followUpQuestions: executionPlan.followUpQuestions,
    debugTrace: [
      `[planner_agent] plan ready sections=${executionPlan.targetSections.length} missing=${executionPlan.missingFields.length}`,
      `[planner_agent] expansion=${executionPlan.expansionDecision?.finalResourceIds.length ?? 0} budget_items=${executionPlan.recallBudgetHint?.maxItems ?? 0}`,
    ],
  };
}
