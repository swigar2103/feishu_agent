import {
  ExecutionPlanSchema,
  type CandidateResourceList,
  type ExecutionPlan,
  type IntentResult,
  type SkillMatch,
} from "../../schemas/agentContracts.js";
import type { UserRequest } from "../../schemas/index.js";
import { invokeJsonModel } from "../../llm/jsonModel.js";
import { buildPlannerSystemPrompt, buildPlannerUserPrompt } from "../../prompts/agentPrompts.js";

/** 已入选云文档摘要时，放宽 workflow 英文占位缺项（agenda/todo/summary），避免 IM 卡片误导 */
const DOC_BACKFILLED_RELIEVE = new Set(["agenda", "todo", "summary"]);

function screenedHasDocSummary(screened: CandidateResourceList): boolean {
  return screened.candidates.some((c) => c.resourceType === "doc_summary");
}

function relieveMissingForDocBacked(
  missingFields: string[],
  screened: CandidateResourceList,
): string[] {
  if (!screenedHasDocSummary(screened)) return missingFields;
  return missingFields.filter((f) => !DOC_BACKFILLED_RELIEVE.has(f));
}

function syncFollowUps(plan: ExecutionPlan): ExecutionPlan {
  return {
    ...plan,
    followUpQuestions: plan.missingFields.map((field) => `请补充：${field}`),
  };
}

function fallbackPlan(input: {
  userRequest: UserRequest;
  intent: IntentResult;
  skillMatch: SkillMatch;
  screened: CandidateResourceList;
}): ExecutionPlan {
  const missingFields = relieveMissingForDocBacked(
    input.skillMatch.selectedSkill.requiredInputs.filter(
      (field) => !input.userRequest.prompt.includes(field),
    ),
    input.screened,
  );

  return ExecutionPlanSchema.parse({
    reportType: input.intent.reportType,
    selectedSkillId: input.skillMatch.selectedSkill.skillId,
    targetSections: input.skillMatch.selectedSkill.sections,
    targetTone: "专业、清晰",
    prioritizedResourceIds: input.screened.candidates.slice(0, 5).map((r) => r.resourceId),
    missingFields,
    followUpQuestions: missingFields.map((field) => `请补充：${field}`),
    retrievalStrategy: "优先读取高分资源，再补读相关联系人与历史项目资料",
  });
}

export async function generateExecutionPlan(input: {
  userRequest: UserRequest;
  intent: IntentResult;
  skillMatch: SkillMatch;
  screened: CandidateResourceList;
}): Promise<ExecutionPlan> {
  try {
    const result = await invokeJsonModel(ExecutionPlanSchema, {
      systemPrompt: buildPlannerSystemPrompt(),
      userPrompt: buildPlannerUserPrompt(input),
    });
    const parsed = ExecutionPlanSchema.parse(result);
    const relieved = relieveMissingForDocBacked(parsed.missingFields, input.screened);
    if (relieved.length === parsed.missingFields.length) {
      return parsed;
    }
    return syncFollowUps({ ...parsed, missingFields: relieved });
  } catch {
    return fallbackPlan(input);
  }
}
