import type {
  AnalysisResult,
  Draft,
  ExecutionPlan,
  SkillMatch,
} from "../schemas/agentContracts.js";
import type { UserRequest } from "../schemas/index.js";

export function buildWriterSystemPrompt(): string {
  return [
    "你是 Writer Agent。",
    "请根据计划、分析结果和 skill 约束生成结构化初稿。",
    "若 user 消息含「云文档/附件原文摘录」或 sourceEvidence：必须以其中的具体事实、数字、名称、日期与待办为准展开；每节至少引用 2–3 处与摘录明确对应的内容，禁止仅用泛化套话（如「取得显著进展」「面临一些挑战」）代替。",
    "仅输出 JSON。",
    "禁止输出空 title/summary；sections 每一项必须包含非空 heading/content。",
    "sections 数组长度必须与 plan.targetSections 一致；每节 heading 建议与 targetSections 顺序一一对应。",
    "各节 content 需为完整段落叙述，禁止使用「请围绕××补充」式编辑提示语占位。",
  ].join("\n");
}

export function buildWriterUserPrompt(
  input: {
    userRequest: UserRequest;
    plan: ExecutionPlan;
    analysis: AnalysisResult;
    skillMatch: SkillMatch;
    rewriteHints?: string[];
  },
  sourceEvidence?: string,
): string {
  const digest = input.userRequest.chatPriorArtifactDigest ?? "";
  const revisionNote =
    digest.length > 80
      ? [
          "",
          "【增量修订硬约束】userRequest 含 chatPriorArtifactDigest：你必须在上一轮报告结构上按 userRequest.prompt 改写；凡用户点名的章节/选区须有可见文面变化，禁止除换行外与上一稿关键结论段落逐字相同。",
        ].join("\n")
      : "";
  const evidenceBlock =
    sourceEvidence && sourceEvidence.trim().length > 0
      ? [
          "",
          "【云文档/附件原文摘录（检索深读）】以下为第一方来源正文，写作时必须体现其中的数据与事实，不可忽略：",
          sourceEvidence.trim(),
        ].join("\n")
      : "";
  return [
    "请生成初稿。",
    revisionNote,
    input.skillMatch.larkCliGuidance?.enabled
      ? "【lark-cli 规范增强】请优先遵循 larkCliGuidance.templateHints 与 qualityChecks 约束输出。"
      : "",
    input.skillMatch.larkCliGuidance?.hardRules?.length
      ? "【强制规则】必须满足 larkCliGuidance.hardRules，不得省略。"
      : "",
    input.skillMatch.workflowMeta
      ? "【官方 workflow 命中】请优先满足 workflowMeta.reviewRules，输出目标参考 workflowMeta.outputTargets。"
      : "",
    `userRequest=${JSON.stringify(input.userRequest)}`,
    `plan=${JSON.stringify(input.plan)}`,
    `analysis=${JSON.stringify(input.analysis)}`,
    `skillMatch=${JSON.stringify(input.skillMatch)}`,
    `larkCliGuidance=${JSON.stringify(input.skillMatch.larkCliGuidance ?? null)}`,
    `larkCliHardRules=${JSON.stringify(input.skillMatch.larkCliGuidance?.hardRules ?? [])}`,
    `larkCliStyleHints=${JSON.stringify(input.skillMatch.larkCliGuidance?.styleHints ?? [])}`,
    `workflowMeta=${JSON.stringify(input.skillMatch.workflowMeta ?? null)}`,
    `rewriteHints=${JSON.stringify(input.rewriteHints ?? [])}`,
    evidenceBlock,
  ]
    .filter((part) => typeof part === "string" && part.length > 0)
    .join("\n");
}

export function buildStyleReviewSystemPrompt(): string {
  return [
    "你是 Style Reviewer。",
    "只评估风格与语气，不评估事实正确性。",
    "仅输出 JSON。",
  ].join("\n");
}

export function buildStyleReviewUserPrompt(input: {
  draft: Draft;
  preferredTone?: string;
  styleNotes: string[];
}): string {
  return [
    "请做风格审查。",
    `draft=${JSON.stringify(input.draft)}`,
    `preferredTone=${input.preferredTone ?? ""}`,
    `styleNotes=${JSON.stringify(input.styleNotes)}`,
  ].join("\n");
}

export function buildComplianceSystemPrompt(): string {
  return [
    "你是 Compliance Reviewer。",
    "请检查结构完整性、术语一致性、必填项和数据口径。",
    "issueType 仅允许 planner_gap/data_quality/ok。",
    "仅输出 JSON。",
  ].join("\n");
}

export function buildComplianceUserPrompt(input: {
  draft: Draft;
  plan: ExecutionPlan;
  requiredInputs: string[];
  terminology: string[];
  reviewRules?: string[];
}): string {
  return [
    "请进行规范审查。",
    `draft=${JSON.stringify(input.draft)}`,
    `plan=${JSON.stringify(input.plan)}`,
    `requiredInputs=${JSON.stringify(input.requiredInputs)}`,
    `terminology=${JSON.stringify(input.terminology)}`,
    `reviewRules=${JSON.stringify(input.reviewRules ?? [])}`,
  ].join("\n");
}
