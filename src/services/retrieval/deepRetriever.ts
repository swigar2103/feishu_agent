import {
  DetailedContextSchema,
  type CandidateResourceList,
  type DetailedContext,
  type ExecutionPlan,
} from "../../schemas/agentContracts.js";
import { TemplateDistillationSchema } from "../../schemas/templateProfile.js";
import type { UserRequest } from "../../schemas/index.js";
import { getMemoryFacade } from "../hmrs/facade/memoryFacade.js";
import { readHmrsTaskType } from "../hmrs/flags/hmrsFeatureFlags.js";
import { logHmrsDiff } from "../hmrs/observe/hmrsDiffLogger.js";

function toFact(sourceId: string, content: string, evidence?: string) {
  return {
    sourceId,
    fact: content,
    ...(evidence ? { evidence } : {}),
  };
}

/** 会话内增量修订：把 latestReport 摘要与用户 extraContext 注入事实层，否则 Analyst/Writer 只看资产池，上一稿等于从未出现。 */
function buildSessionAnchoredFacts(request: UserRequest): Array<{
  sourceId: string;
  fact: string;
  evidence?: string;
}> {
  const out: Array<{ sourceId: string; fact: string; evidence?: string }> = [];
  const cap = (s: string, max: number) =>
    s.length <= max ? s : `${s.slice(0, max)}\n…（已截断，完整内容见用户请求 extraContext）`;

  if (request.chatPriorArtifactDigest?.trim()) {
    out.push(
      toFact(
        "session_latest_report_digest",
        cap(request.chatPriorArtifactDigest.trim(), 18_000),
        "【增量修订基线】当前会话最近一次已定稿报告（JSON 文本）；修订必须以此为出发点改写相应小节，不得无视用户意见重复原句。",
      ),
    );
  }

  const extras = request.extraContext ?? [];
  for (let i = 0; i < extras.length; i++) {
    const block = extras[i]?.trim();
    if (!block) continue;
    out.push(
      toFact(
        `user_extra_context_${i + 1}`,
        cap(block, 18_000),
        "【用户附加】含「对话区引用」及内嵌报告 JSON 片段；与摘要型 digest 冲突时，以用户意见与显式引用文字为准。",
      ),
    );
  }

  return out;
}

function mergeWithCommonFacts(base: DetailedContext, request: UserRequest): DetailedContext {
  const historyFacts = request.historyDocs.map((doc, idx) =>
    toFact(`history_doc_${idx + 1}`, doc),
  );
  const contactFacts = request.imContacts.map((contact, idx) =>
    toFact(
      `im_contact_${idx + 1}`,
      `联系人 ${contact.name}(${contact.id}) 角色=${contact.role ?? "未知"} 可用于补充任务字段`,
    ),
  );
  const anchored = buildSessionAnchoredFacts(request);
  const anchoredDetails = anchored.map((a) => ({
    resourceId: a.sourceId,
    detail: a.fact,
  }));
  const personalKnowledgeDetails = request.personalKnowledge.map((item, idx) => ({
    resourceId: `pk_${idx + 1}`,
    detail: item,
  }));

  return DetailedContextSchema.parse({
    facts: [...anchored, ...base.facts, ...historyFacts, ...contactFacts],
    sourceDetails: [...anchoredDetails, ...base.sourceDetails, ...personalKnowledgeDetails],
    templateDistillation: base.templateDistillation,
  });
}

function buildFallbackTemplateDistillation(input: {
  plan: ExecutionPlan;
  screened: CandidateResourceList;
}) {
  const docLike = input.screened.candidates
    .filter((item) => item.resourceType === "doc_summary")
    .slice(0, 3);
  if (docLike.length === 0) return undefined;
  const profilesByResourceId = Object.fromEntries(
    docLike.map((item) => [
      item.resourceId,
      {
        version: 1,
        resourceId: item.resourceId,
        sectionOrder: input.plan.targetSections,
        fixedLabels: [],
        listPatterns: [],
        styleRules: ["优先沿用用户既有模板的章节顺序与命名。"],
        forbiddenPatterns: [],
        slotHints: input.plan.targetSections.map((heading, idx) => ({
          slotId: `slot_${idx + 1}`,
          sectionHeading: heading,
          description: `围绕「${heading}」补齐结构化内容与证据引用`,
        })),
      },
    ]),
  );
  return TemplateDistillationSchema.parse({ profilesByResourceId });
}

export async function deepRetrieveContext(input: {
  request: UserRequest;
  plan: ExecutionPlan;
  screened: CandidateResourceList;
}): Promise<DetailedContext> {
  const facade = getMemoryFacade();
  const expansion = input.plan.expansionDecision?.finalResourceIds?.length
    ? input.plan.expansionDecision.finalResourceIds
    : input.screened.candidates.slice(0, 6).map((item) => `l2_${item.resourceId}`);
  const base = await facade.retrieveDetails({
    request: input.request,
    expansion: {
      l1Ids: input.plan.expansionDecision?.l1Ids ?? [],
      l2Ids: input.plan.expansionDecision?.l2Ids ?? [],
      finalResourceIds: expansion,
      reason: input.plan.expansionDecision?.reason ?? ["fallback_from_screening"],
      budget: {
        maxItems: input.plan.recallBudgetHint?.maxItems ?? 6,
        maxChars: input.plan.recallBudgetHint?.maxChars ?? 30_000,
        priority: input.plan.recallBudgetHint?.priority ?? "balanced",
      },
    },
    screened: input.screened,
  });
  const templateDistillation =
    base.templateDistillation ?? buildFallbackTemplateDistillation({ plan: input.plan, screened: input.screened });
  const merged = mergeWithCommonFacts(
    DetailedContextSchema.parse({
      ...base,
      templateDistillation,
    }),
    input.request,
  );

  logHmrsDiff({
    sessionId: input.request.sessionId,
    userId: input.request.userId,
    taskType: readHmrsTaskType(input.request),
    legacyTopIds: input.screened.candidates.slice(0, 5).map((item) => item.resourceId),
    hmrsL1Ids: input.plan.expansionDecision?.l1Ids ?? [],
    hmrsL2Ids: input.plan.expansionDecision?.l2Ids ?? [],
    finalExpansionIds: expansion,
    budget: {
      maxItems: input.plan.recallBudgetHint?.maxItems ?? 6,
      maxChars: input.plan.recallBudgetHint?.maxChars ?? 30_000,
    },
  });

  return merged;
}
