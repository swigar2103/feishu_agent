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
import { getMemoryFacade } from "../hmrs/facade/memoryFacade.js";
import { readHmrsTaskType } from "../hmrs/flags/hmrsFeatureFlags.js";
import { logHmrsDiff } from "../hmrs/observe/hmrsDiffLogger.js";
import type { L1CatalogObject, L2IndexObject } from "../hmrs/model/layerSchemas.js";

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

function syncPrioritizedResources(plan: ExecutionPlan, screened: CandidateResourceList): ExecutionPlan {
  if (plan.prioritizedResourceIds.length > 0) return plan;
  const selected = screened.selectionDecision?.selectedResourceIds ?? [];
  if (selected.length === 0) return plan;
  return {
    ...plan,
    prioritizedResourceIds: selected.slice(0, 8),
  };
}

function enforceTemplateSections(plan: ExecutionPlan, skillMatch: SkillMatch): ExecutionPlan {
  if (skillMatch.source !== "user_template") return plan;
  if (skillMatch.selectedSkill.sections.length === 0) return plan;
  return {
    ...plan,
    selectedSkillId: skillMatch.selectedSkill.skillId,
    targetSections: skillMatch.selectedSkill.sections,
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
    prioritizedResourceIds:
      input.screened.selectionDecision?.selectedResourceIds?.slice(0, 5) ??
      input.screened.candidates.slice(0, 5).map((r) => r.resourceId),
    missingFields,
    followUpQuestions: missingFields.map((field) => `请补充：${field}`),
    retrievalStrategy: "优先读取高分资源，再补读相关联系人与历史项目资料",
    recallBudgetHint: {
      maxItems: 6,
      maxChars: 30000,
      priority: "balanced",
    },
  });
}

async function attachHmrsExpansion(
  plan: ExecutionPlan,
  input: {
    userRequest: UserRequest;
    screened: CandidateResourceList;
    hmrsL1?: L1CatalogObject[];
    hmrsL2?: L2IndexObject[];
  },
): Promise<ExecutionPlan> {
  const facade = getMemoryFacade();
  const l1 =
    input.hmrsL1 ??
    (await facade.queryWingSummaries({
      owner: input.userRequest.userId,
      keyword: input.userRequest.prompt,
      wings: ["projects_wing", "templates_wing", "people_wing", "resources_wing"],
      limit: 8,
    }));
  const l2 =
    input.hmrsL2 ??
    (await facade.queryRoomIndexes({
      owner: input.userRequest.userId,
      keyword: input.userRequest.prompt,
      limit: 12,
    }));
  const expansion = await facade.planExpansion({ plan, l1, l2 });

  logHmrsDiff({
    sessionId: input.userRequest.sessionId,
    userId: input.userRequest.userId,
    taskType: readHmrsTaskType(input.userRequest),
    legacyTopIds: input.screened.candidates.slice(0, 5).map((item) => item.resourceId),
    hmrsL1Ids: expansion.l1Ids,
    hmrsL2Ids: expansion.l2Ids,
    finalExpansionIds: expansion.finalResourceIds,
    budget: {
      maxItems: expansion.budget.maxItems,
      maxChars: expansion.budget.maxChars,
    },
  });

  return {
    ...plan,
    expansionDecision: {
      l1Ids: expansion.l1Ids,
      l2Ids: expansion.l2Ids,
      finalResourceIds: expansion.finalResourceIds,
      reason: expansion.reason,
      // 保留 Planner LLM 输出的目标文件夹选择（若原 plan 中已有则继承）
      targetFolderTokens: plan.expansionDecision?.targetFolderTokens ?? [],
    },
    recallBudgetHint: {
      maxItems: expansion.budget.maxItems,
      maxChars: expansion.budget.maxChars,
      priority: expansion.budget.priority,
    },
  };
}

export async function generateExecutionPlan(input: {
  userRequest: UserRequest;
  intent: IntentResult;
  skillMatch: SkillMatch;
  screened: CandidateResourceList;
}): Promise<ExecutionPlan> {
  let hmrsL1: L1CatalogObject[] | undefined;
  let hmrsL2: L2IndexObject[] | undefined;
  const facade = getMemoryFacade();
  [hmrsL1, hmrsL2] = await Promise.all([
    facade.queryWingSummaries({
      owner: input.userRequest.userId,
      keyword: input.userRequest.prompt,
      wings: ["projects_wing", "templates_wing", "people_wing", "resources_wing"],
      limit: 8,
    }),
    facade.queryRoomIndexes({
      owner: input.userRequest.userId,
      keyword: input.userRequest.prompt,
      limit: 12,
    }),
  ]);

  // 获取文件夹结构供 LLM 动态选择目标子文件夹
  const managedFolderStructure = await facade.getManagedFolderStructure(input.userRequest.userId).catch(() => []);

  try {
    const result = await invokeJsonModel(ExecutionPlanSchema, {
      systemPrompt: buildPlannerSystemPrompt(),
      userPrompt: buildPlannerUserPrompt({
        ...input,
        hmrsL1,
        hmrsL2,
        managedFolderStructure,
      }),
    });
    const parsed = ExecutionPlanSchema.parse(result);
    const relieved = relieveMissingForDocBacked(parsed.missingFields, input.screened);
    const normalized =
      relieved.length === parsed.missingFields.length
        ? parsed
        : syncFollowUps({ ...parsed, missingFields: relieved });
    return attachHmrsExpansion(
      enforceTemplateSections(syncPrioritizedResources(normalized, input.screened), input.skillMatch),
      {
      userRequest: input.userRequest,
      screened: input.screened,
      hmrsL1,
      hmrsL2,
      },
    );
  } catch {
    const fallback = enforceTemplateSections(
      syncPrioritizedResources(fallbackPlan(input), input.screened),
      input.skillMatch,
    );
    return attachHmrsExpansion(fallback, {
      userRequest: input.userRequest,
      screened: input.screened,
      hmrsL1,
      hmrsL2,
    });
  }
}
