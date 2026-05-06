import { env } from "../../config/env.js";
import { logger } from "../../shared/logger.js";
import { extractJsonObject } from "../../shared/utils.js";
import {
  DraftSchema,
  type AnalysisResult,
  type DetailedContext,
  type Draft,
  type ExecutionPlan,
  type SkillMatch,
} from "../../schemas/agentContracts.js";
import type { UserRequest } from "../../schemas/index.js";
import { invokeBailianModel } from "../../llm/client.js";
import { buildWriterSystemPrompt, buildWriterUserPrompt } from "../../prompts/reviewPrompts.js";

const WRITER_EVIDENCE_PER_SOURCE = 12_000;
const WRITER_EVIDENCE_TOTAL = 28_000;

/** 将深读 sourceDetails 压成 Writer 可消费的原文摘录（避免只依赖 Analyst 摘要丢失细节） */
export function buildWriterSourceEvidence(ctx: DetailedContext | null | undefined): string {
  if (!ctx?.sourceDetails?.length) return "";
  const blocks: string[] = [];
  let used = 0;
  for (const s of ctx.sourceDetails) {
    const id = s.resourceId;
    if (id.startsWith("im_contact_")) continue;
    const detail = (s.detail ?? "").trim();
    if (!detail) continue;
    const cap = Math.min(WRITER_EVIDENCE_PER_SOURCE, detail.length);
    const chunk =
      detail.length <= cap
        ? detail
        : `${detail.slice(0, cap)}\n…（摘录已截断；更长内容在同 resourceId 的 Analyst context.sourceDetails）`;
    const block = `### ${id}\n${chunk}`;
    if (used + block.length + 2 > WRITER_EVIDENCE_TOTAL) break;
    blocks.push(block);
    used += block.length + 2;
  }
  if (!blocks.length) return "";
  return [
    "以下片段来自检索与深读；写作须引用其中事实与数据（可与 analysis.normalizedFacts 交叉核对）：",
    ...blocks,
  ].join("\n\n");
}

function collectAnalysisLines(analysis: AnalysisResult): string[] {
  return [...analysis.keyInsights, ...analysis.normalizedFacts].filter(
    (s) => typeof s === "string" && s.trim().length > 0,
  );
}

function buildDraftV2Extensions(input: {
  sections: Array<{ heading: string; content: string }>;
  chartSuggestions: Array<{ type: string; title: string; purpose: string; dataHint: string }>;
}) {
  const sectionBlocks = input.sections.map((section, idx) => ({
    blockId: `sec_${idx + 1}`,
    sectionHeading: section.heading,
    blockType: "paragraph" as const,
    content: section.content,
  }));
  const timelineSlots = input.sections
    .filter((s) => /时间线|里程碑|timeline/i.test(`${s.heading}\n${s.content}`))
    .slice(0, 4)
    .map((s, idx) => ({
      slotId: `timeline_${idx + 1}`,
      title: s.heading,
      periodHint: "待补充周期",
      notes: s.content.slice(0, 120),
    }));
  const ganttSlots = input.sections
    .filter((s) => /甘特|gantt|排期|计划/i.test(`${s.heading}\n${s.content}`))
    .slice(0, 4)
    .map((s, idx) => ({
      slotId: `gantt_${idx + 1}`,
      task: s.heading,
      ownerHint: "待补充负责人",
      startHint: "待补充开始时间",
      endHint: "待补充结束时间",
    }));
  const chartSlots = input.chartSuggestions.map((c, idx) => ({
    slotId: `chart_${idx + 1}`,
    chartType: c.type,
    title: c.title,
    metricHint: c.dataHint,
  }));
  if (chartSlots.length === 0) {
    chartSlots.push({
      slotId: "chart_1",
      chartType: "bar",
      title: "关键指标对比（占位）",
      metricHint: "建议填充本期与上期的关键指标",
    });
  }
  if (timelineSlots.length === 0) {
    timelineSlots.push({
      slotId: "timeline_1",
      title: "关键里程碑（占位）",
      periodHint: "按周或按阶段填写时间点",
      notes: "用于在编辑工作台补全项目时间线",
    });
  }
  if (ganttSlots.length === 0) {
    ganttSlots.push({
      slotId: "gantt_1",
      task: "关键任务（占位）",
      ownerHint: "待补充负责人",
      startHint: "待补充开始时间",
      endHint: "待补充结束时间",
    });
  }
  return {
    sectionBlocks,
    timelineSlots,
    ganttSlots,
    chartSlots,
  };
}

function fallbackDraft(input: {
  userRequest: UserRequest;
  plan: ExecutionPlan;
  analysis: AnalysisResult;
}): Draft {
  const lines = collectAnalysisLines(input.analysis);
  const prompt = input.userRequest.prompt.trim();

  const sections = input.plan.targetSections.map((section, idx) => {
    if (lines[idx]) {
      return { heading: section, content: lines[idx] };
    }
    const pivot = lines[0];
    if (pivot) {
      return {
        heading: section,
        content: `${pivot}\n\n（本节标题为「${section}」：可在上述要点基础上补充与该小节更贴合的案例、数据与引用。）`,
      };
    }
    return {
      heading: section,
      content: [
        `【${section}】`,
        "",
        "当前结构化物料不足，以下为根据用户任务摘要整理的占位叙述，便于你继续补全；有数据源后请替换整段。",
        "",
        prompt || "（任务说明为空）",
      ].join("\n"),
    };
  });

  const title = `${input.plan.reportType} - ${input.userRequest.sessionId}`;
  const summary =
    lines[0] ??
    (prompt
      ? prompt.slice(0, Math.min(800, prompt.length))
      : "见各节草稿；建议补充数据来源后再定稿。");

  const v2 = buildDraftV2Extensions({
    sections,
    chartSuggestions: input.analysis.chartSuggestions,
  });
  return DraftSchema.parse({
    format: "doc",
    title,
    summary,
    sections,
    chartSuggestions: input.analysis.chartSuggestions,
    openQuestions: [
      ...input.plan.missingFields,
      "Writer JSON 生成未通过校验，已启用本地兜底稿；请检查模型输出或缩短上下文后重试。",
    ],
    ...v2,
  });
}

function firstNonEmptyText(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function normalizeSections(raw: unknown, targetSections: string[], fallbackLine?: string): Draft["sections"] {
  const fromModel = Array.isArray(raw)
    ? raw
        .map((item) => {
          if (!item || typeof item !== "object") return null;
          const record = item as Record<string, unknown>;
          const heading = firstNonEmptyText(record.heading, record.title);
          const content = firstNonEmptyText(record.content, record.text, record.body);
          if (!heading || !content) return null;
          return { heading, content };
        })
        .filter((item): item is Draft["sections"][number] => Boolean(item))
    : [];

  const normalized = targetSections.map((heading, idx) => {
    const existing = fromModel[idx];
    if (existing) return existing;
    const firstValid = fromModel.find((item) => item.heading === heading);
    if (firstValid) return firstValid;
    return {
      heading,
      content: fallbackLine ?? `围绕「${heading}」补充事实、结论与可执行建议。`,
    };
  });
  return normalized;
}

function repairDraftPayload(payload: unknown, input: {
  userRequest: UserRequest;
  plan: ExecutionPlan;
  analysis: AnalysisResult;
}): unknown {
  const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const line = collectAnalysisLines(input.analysis)[0];
  const title =
    firstNonEmptyText(record.title) ??
    `${input.plan.reportType} - ${input.userRequest.sessionId}`;
  const summary =
    firstNonEmptyText(record.summary, line, input.userRequest.prompt) ??
    "见各章节分析与行动建议。";
  const sections = normalizeSections(record.sections, input.plan.targetSections, line);
  const chartSuggestions = Array.isArray(record.chartSuggestions) ? record.chartSuggestions : [];
  const openQuestions = Array.isArray(record.openQuestions)
    ? record.openQuestions.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  const v2 = buildDraftV2Extensions({ sections, chartSuggestions: chartSuggestions as Array<{
    type: string;
    title: string;
    purpose: string;
    dataHint: string;
  }> });
  const normalizedChartSuggestions =
    chartSuggestions.length > 0
      ? chartSuggestions
      : v2.chartSlots.map((slot) => ({
          type: slot.chartType,
          title: slot.title,
          purpose: "用于补充结构化初稿中的可视化表达",
          dataHint: slot.metricHint,
        }));

  return {
    format: "doc",
    title,
    summary,
    sections,
    chartSuggestions: normalizedChartSuggestions,
    openQuestions,
    sectionBlocks: Array.isArray(record.sectionBlocks) ? record.sectionBlocks : v2.sectionBlocks,
    timelineSlots: Array.isArray(record.timelineSlots) ? record.timelineSlots : v2.timelineSlots,
    ganttSlots: Array.isArray(record.ganttSlots) ? record.ganttSlots : v2.ganttSlots,
    chartSlots: Array.isArray(record.chartSlots) ? record.chartSlots : v2.chartSlots,
  };
}

async function invokeWriterRaw(
  input: {
    userRequest: UserRequest;
    plan: ExecutionPlan;
    analysis: AnalysisResult;
    skillMatch: SkillMatch;
    rewriteHints?: string[];
    sourceEvidence?: string;
  },
  extraInstruction?: string,
): Promise<unknown> {
  const raw = await invokeBailianModel({
    model: env.BAILIAN_MODEL_WRITER,
    systemPrompt: buildWriterSystemPrompt(),
    userPrompt: [
      buildWriterUserPrompt(
        {
          userRequest: input.userRequest,
          plan: input.plan,
          analysis: input.analysis,
          skillMatch: input.skillMatch,
          rewriteHints: input.rewriteHints,
        },
        input.sourceEvidence,
      ),
      extraInstruction ? `\n【修复约束】${extraInstruction}` : "",
    ].join("\n"),
    jsonMode: true,
  });
  return JSON.parse(extractJsonObject(raw)) as unknown;
}

export async function writeDraft(input: {
  userRequest: UserRequest;
  plan: ExecutionPlan;
  analysis: AnalysisResult;
  skillMatch: SkillMatch;
  rewriteHints?: string[];
  /** 云文档/附件深读摘录；与 analysis 一并供模型落笔 */
  sourceEvidence?: string;
}): Promise<Draft> {
  try {
    const firstPayload = await invokeWriterRaw(input);
    const firstTry = DraftSchema.safeParse(firstPayload);
    if (firstTry.success) {
      return firstTry.data;
    }

    const repairedPayload = repairDraftPayload(firstPayload, {
      userRequest: input.userRequest,
      plan: input.plan,
      analysis: input.analysis,
    });
    const repaired = DraftSchema.safeParse(repairedPayload);
    if (repaired.success) {
      logger.warn("Writer JSON 初次校验失败，已通过本地 repair 纠正", {
        issues: firstTry.error.issues.map((issue) => `${issue.path.join(".")}:${issue.message}`).slice(0, 6),
      });
      return repaired.data;
    }

    const retryPayload = await invokeWriterRaw(
      {
        userRequest: input.userRequest,
        plan: input.plan,
        analysis: input.analysis,
        skillMatch: input.skillMatch,
        rewriteHints: input.rewriteHints,
        sourceEvidence: input.sourceEvidence,
      },
      `上一轮输出未通过校验：${firstTry.error.issues
        .map((issue) => `${issue.path.join(".")}:${issue.message}`)
        .slice(0, 8)
        .join(" | ")}。请返回完全符合 DraftSchema 的 JSON。`,
    );
    return DraftSchema.parse(retryPayload);
  } catch (error) {
    logger.warn("Writer JSON 调用失败，已使用兜底草稿", {
      message: error instanceof Error ? error.message : String(error),
    });
    return fallbackDraft(input);
  }
}
