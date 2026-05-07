import { generateExecutionPlan } from "../../services/agent/plannerAgent.js";
import { publishPipelineProgress } from "../../services/progress/pipelineProgress.js";
import { BlueprintPlanSchema } from "../../schemas/agentContracts.js";
import { TaskPlanSchema } from "../../schemas/index.js";
import { readStyleProfileSoft } from "../../services/hmrs/styleDistillationService.js";
import type { ReportGraphStateType } from "../state.js";

export async function plannerAgentNode(
  state: ReportGraphStateType,
): Promise<Partial<ReportGraphStateType>> {
  if (!state.taskRequest || !state.intentResult || !state.skillMatch || !state.candidateResources) {
    throw new Error("planner_agent 缺少前置状态");
  }

  const styleProfile = await readStyleProfileSoft({ userId: state.taskRequest.userRequest.userId });
  const executionPlan = await generateExecutionPlan({
    userRequest: state.taskRequest.userRequest,
    intent: state.intentResult,
    skillMatch: state.skillMatch,
    screened: state.candidateResources,
  });
  publishPipelineProgress({
    sessionId: state.taskRequest.userRequest.sessionId,
    stage: "planner",
    message: "计划生成完成",
    meta: {
      sectionCount: executionPlan.targetSections.length,
      expansionCount: executionPlan.expansionDecision?.finalResourceIds.length ?? 0,
    },
  });
  const styleGuardrails: string[] = [];
  if (styleProfile) {
    if (styleProfile.preferredSectionOrder.length > 0) {
      styleGuardrails.push(
        `用户偏好的章节顺序：${styleProfile.preferredSectionOrder.slice(0, 6).join(" -> ")}；如与模板不冲突请优先采用。`,
      );
    }
    if (styleProfile.preferredVisualKinds.length > 0) {
      styleGuardrails.push(
        `用户偏好的可视化形式：${styleProfile.preferredVisualKinds.join("、")}；规划 visualSlots 时优先选择这些类型。`,
      );
    }
    if (styleProfile.toneTags.length > 0) {
      styleGuardrails.push(
        `targetTone 调整方向：${styleProfile.toneTags.slice(0, 4).join("、")}。`,
      );
    }
  }

  const blueprintPlan = BlueprintPlanSchema.parse({
    sectionBlueprint: executionPlan.targetSections,
    visualSlots: executionPlan.targetSections
      .filter((heading) => /时间线|里程碑|timeline|甘特|gantt|图表|指标|表格|对比/i.test(heading))
      .map((heading) => ({
        slotType: /时间线|里程碑|timeline/i.test(heading)
          ? "timeline"
          : /甘特|gantt|排期|计划/i.test(heading)
            ? "gantt"
            : /表格|对比/i.test(heading)
              ? "table"
              : "chart",
        sectionHeading: heading,
        intent: "用于在线编辑工作台补全结构化可视化内容",
      })),
    templateGuardrails: [
      "优先按 sectionBlueprint 的顺序和命名生成。",
      "若缺事实，保留结构化占位，不得编造数据。",
      "图表/时间线/甘特相关章节需产出可编辑槽位提示。",
      ...styleGuardrails,
    ],
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
    blueprintPlan,
    followUpQuestions: executionPlan.followUpQuestions,
    debugTrace: [
      `[planner_agent] plan ready sections=${executionPlan.targetSections.length} missing=${executionPlan.missingFields.length}`,
      `[planner_agent] expansion=${executionPlan.expansionDecision?.finalResourceIds.length ?? 0} budget_items=${executionPlan.recallBudgetHint?.maxItems ?? 0}`,
      `[planner_agent] blueprint sections=${blueprintPlan.sectionBlueprint.length} visual_slots=${blueprintPlan.visualSlots.length}`,
      `[planner_agent] style_profile loaded=${Boolean(styleProfile)} sample_count=${styleProfile?.observedSampleCount ?? 0}`,
    ],
  };
}
