import { TaskPlanSchema } from "../../schemas/index.js";
import type { ReportGraphStateType } from "../state.js";

export async function plannerNode(
  state: ReportGraphStateType,
): Promise<Partial<ReportGraphStateType>> {
  if (!state.userRequest) {
    throw new Error("planner_node 缺少 userRequest");
  }

  const fallbackReportType =
    state.userRequest.reportType ??
    (state.taskIntent === "weekly_report" || state.taskIntent?.includes("周报")
      ? "周报"
      : "分析报告");
  const taskPlan = TaskPlanSchema.parse({
    reportType: fallbackReportType,
    selectedSkillId: "pending-skill-selection",
    missingFields: [],
    targetSections: ["执行摘要", "关键分析", "行动建议"],
    targetTone: "专业、清晰、可执行",
    useSources: [],
  });

  return {
    taskPlan,
    debugTrace: [
      `[planner_node] intent=${state.taskIntent ?? "unknown"}`,
      `[planner_node] preliminary plan generated reportType=${taskPlan.reportType}`,
    ],
  };
}
