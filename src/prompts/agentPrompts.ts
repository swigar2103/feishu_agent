import type {
  CandidateResourceList,
  DetailedContext,
  ExecutionPlan,
  IntentResult,
  SkillMatch,
} from "../schemas/agentContracts.js";
import type { UserRequest } from "../schemas/index.js";
import type { L1CatalogObject, L2IndexObject } from "../services/hmrs/model/layerSchemas.js";

export function buildIntentSystemPrompt(): string {
  return [
    "你是办公协同系统中的 Intent Agent。",
    "你的职责：识别任务意图、目标产物、行业、报告类型、初始信息缺口。",
    "仅输出 JSON，不要输出解释。",
  ].join("\n");
}

export function buildIntentUserPrompt(
  userRequest: UserRequest,
  screened: CandidateResourceList,
): string {
  return [
    "请基于用户请求和候选资源做意图识别。",
    `userRequest=${JSON.stringify(userRequest)}`,
    `candidates=${JSON.stringify(screened.candidates.slice(0, 8))}`,
  ].join("\n");
}

export function buildPlannerSystemPrompt(): string {
  return [
    "你是 Planner Agent，只负责计划，不写正文。",
    "请输出执行计划 JSON，包含结构、优先资源、缺失信息和深读策略。",
    "若输入中包含 larkCliGuidance.hardRules，必须把它们转化为可执行计划约束（如读取策略、章节完整性、发布前校验）。",
    "仅输出 JSON。",
  ].join("\n");
}

export function buildPlannerUserPrompt(input: {
  userRequest: UserRequest;
  intent: IntentResult;
  skillMatch: SkillMatch;
  screened: CandidateResourceList;
  hmrsL1?: L1CatalogObject[];
  hmrsL2?: L2IndexObject[];
}): string {
  return [
    "请生成可执行计划。",
    `userRequest=${JSON.stringify(input.userRequest)}`,
    `intent=${JSON.stringify(input.intent)}`,
    `skillMatch=${JSON.stringify(input.skillMatch)}`,
    `templateHints=${JSON.stringify(input.skillMatch.larkCliGuidance?.templateHints ?? [])}`,
    `qualityChecks=${JSON.stringify(input.skillMatch.larkCliGuidance?.qualityChecks ?? [])}`,
    `sectionSchema=${JSON.stringify(input.skillMatch.workflowMeta?.workflowTemplateId ? input.skillMatch.selectedSkill.sections : [])}`,
    `larkCliHardRules=${JSON.stringify(input.skillMatch.larkCliGuidance?.hardRules ?? [])}`,
    `larkCliStyleHints=${JSON.stringify(input.skillMatch.larkCliGuidance?.styleHints ?? [])}`,
    `workflowMeta=${JSON.stringify(input.skillMatch.workflowMeta ?? null)}`,
    `screened=${JSON.stringify(input.screened)}`,
    `hmrsL1=${JSON.stringify(input.hmrsL1 ?? [])}`,
    `hmrsL2=${JSON.stringify(input.hmrsL2 ?? [])}`,
  ].join("\n");
}

export function buildAnalystSystemPrompt(): string {
  return [
    "你是 Analyst Agent。",
    "请对详细上下文做事实清洗、口径统一、重点提炼和图表建议。",
    "context.sourceDetails 与 facts 中 resourceId 含 ext_doc_、table、project 等条目时：必须从正文中抽取可核验细节写入 normalizedFacts（数字、日期、专有名词、流程节点、待办与负责人），不得只输出概括句；keyInsights 应对应 plan.targetSections 可落地的写作要点。",
    "若 facts 中含 sourceId 为 session_latest_report_digest 或 user_extra_context_*，表示会话内已定稿报告与用户附加的「对话区引用」等；增量修订时必须把这些内容与 plan、用户意图结合，提炼可写回各章节的修改要点。",
    "仅输出 JSON。",
  ].join("\n");
}

export function buildAnalystUserPrompt(input: {
  plan: ExecutionPlan;
  context: DetailedContext;
}): string {
  return [
    "请产出分析结果。",
    `plan=${JSON.stringify(input.plan)}`,
    `context=${JSON.stringify(input.context)}`,
  ].join("\n");
}
