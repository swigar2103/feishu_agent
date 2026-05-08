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

function normalizeHeadingCandidate(line: string): string {
  return line
    .replace(/^#{1,6}\s*/, "")
    .replace(/^[\-*]\s+/, "")
    .replace(/^\d+(\.\d+){0,2}\s+/, "")
    .trim();
}

function isHeadingLike(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (t.length > 32) return false;
  if (/^#{1,6}\s+\S+/.test(t)) return true;
  if (/^[一二三四五六七八九十]+[、.．]\s*\S+/.test(t)) return true;
  if (/^\d+(\.\d+){0,2}\s+\S+/.test(t)) return true;
  if (/^[（(][一二三四五六七八九十\d]+[)）]\s*\S+/.test(t)) return true;
  return false;
}

/**
 * 从深读正文中抽取模板章节骨架（优先包含“周报/模板”上下文的文档）。
 */
export function extractTemplateSectionsFromDetailedContext(
  ctx: DetailedContext | null | undefined,
): string[] {
  if (!ctx?.sourceDetails?.length) return [];
  const preferred = [...ctx.sourceDetails].sort((a, b) => {
    const aScore = /周报|模板|template/i.test(a.detail) ? 1 : 0;
    const bScore = /周报|模板|template/i.test(b.detail) ? 1 : 0;
    return bScore - aScore;
  });
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of preferred) {
    const lines = item.detail
      .replace(/\r/g, "")
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean);
    for (const line of lines) {
      if (!isHeadingLike(line)) continue;
      const normalized = normalizeHeadingCandidate(line);
      if (normalized.length < 2 || seen.has(normalized)) continue;
      seen.add(normalized);
      out.push(normalized);
      if (out.length >= 10) return out;
    }
  }
  return out;
}

function computeEvidenceTelemetry(sourceEvidence?: string): {
  evidenceChars: number;
  evidenceSourceCount: number;
} {
  const text = sourceEvidence?.trim() ?? "";
  if (!text) return { evidenceChars: 0, evidenceSourceCount: 0 };
  const evidenceSourceCount = (text.match(/^###\s+/gm) ?? []).length;
  return {
    evidenceChars: text.length,
    evidenceSourceCount,
  };
}

function buildWriterModelCandidates(): string[] {
  const values = [
    env.BAILIAN_MODEL_WRITER,
    env.BAILIAN_MODEL_WRITER_FALLBACK,
    env.BAILIAN_MODEL_ORCHESTRATOR,
  ]
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  return [...new Set(values)];
}

function collectAnalysisLines(analysis: AnalysisResult): string[] {
  return [...analysis.keyInsights, ...analysis.normalizedFacts].filter(
    (s) => typeof s === "string" && s.trim().length > 0,
  );
}

type ChartTypeKind = "line" | "bar" | "pie" | "table" | "image";
function normalizeChartKind(input: string): ChartTypeKind {
  const lower = input.toLowerCase();
  if (lower.includes("line") || /折线|趋势/.test(input)) return "line";
  if (lower.includes("pie") || /饼图|占比/.test(input)) return "pie";
  if (lower.includes("table") || /表格/.test(input)) return "table";
  if (lower.includes("image") || /插图/.test(input)) return "image";
  return "bar";
}

/**
 * 从 section 内容里轻量启发式抽取「日期 + 任务 + 负责人」三元组，
 * 用于把对应可视化槽位从 needs_data 提升为 ready，让 ArtifactRenderer 实际产图。
 */
function extractGanttDataFromSections(
  sections: Array<{ heading: string; content: string }>,
): Array<{ task: string; owner?: string; start: string; end: string }> {
  const dateRe =
    /((?:20\d{2}[-./年]\s*)?(?:0?[1-9]|1[0-2])[-./月]\s*(?:0?[1-9]|[12]\d|3[01])(?:日)?)/g;
  const ownerRe = /(?:负责人|owner|by|@|by\s+)\s*[:：]?\s*([\u4e00-\u9fa5\w]{2,8})/i;
  const items: Array<{ task: string; owner?: string; start: string; end: string }> = [];
  for (const s of sections) {
    for (const line of s.content.split(/[\n。；;]+/)) {
      const dates = Array.from(line.matchAll(dateRe)).map((m) => m[1]);
      if (dates.length < 2) continue;
      const ownerMatch = line.match(ownerRe);
      const task = line
        .replace(dateRe, "")
        .replace(ownerRe, "")
        .replace(/[，,：:]+/g, " ")
        .trim()
        .slice(0, 40);
      if (!task) continue;
      items.push({
        task,
        owner: ownerMatch?.[1],
        start: dates[0]!,
        end: dates[1]!,
      });
      if (items.length >= 8) break;
    }
    if (items.length >= 8) break;
  }
  return items;
}

function extractTimelineDataFromSections(
  sections: Array<{ heading: string; content: string }>,
): Array<{ label: string; when: string; note?: string }> {
  const dateRe =
    /(20\d{2}[-./年]\s*(?:0?[1-9]|1[0-2])[-./月]\s*(?:0?[1-9]|[12]\d|3[01])(?:日)?|(?:0?[1-9]|1[0-2])[-./月]\s*(?:0?[1-9]|[12]\d|3[01])(?:日)?|第\s*\d+\s*周)/g;
  const items: Array<{ label: string; when: string; note?: string }> = [];
  for (const s of sections) {
    for (const line of s.content.split(/[\n。；;]+/)) {
      const m = line.match(dateRe);
      if (!m || !m[0]) continue;
      const label = line.replace(m[0], "").replace(/[，,：:]+/g, " ").trim().slice(0, 40);
      if (!label) continue;
      items.push({ label, when: m[0], note: line.slice(0, 80) });
      if (items.length >= 8) break;
    }
    if (items.length >= 8) break;
  }
  return items;
}

/**
 * 按 chartSchema 期望返回 categories + series 结构（不是 label/value）。
 */
function extractChartDataFromSections(
  sections: Array<{ heading: string; content: string }>,
): { categories: string[]; series: Array<{ name: string; values: number[] }> } | null {
  const tripleRe = /([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9_]{1,12})[^\d\n]{0,8}(\d{1,6}(?:\.\d{1,2})?)\s*(%|个|项|次|人|元|万|条|份|天|小时)?/g;
  const pairs: Array<{ label: string; value: number }> = [];
  for (const s of sections) {
    for (const m of s.content.matchAll(tripleRe)) {
      const label = (m[1] ?? "").trim();
      const value = Number(m[2] ?? "");
      if (!label || !Number.isFinite(value)) continue;
      pairs.push({ label, value });
      if (pairs.length >= 8) break;
    }
    if (pairs.length >= 8) break;
  }
  if (pairs.length < 3) return null;
  return {
    categories: pairs.map((p) => p.label),
    series: [{ name: "数值", values: pairs.map((p) => p.value) }],
  };
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

  const timelineEvidence = extractTimelineDataFromSections(input.sections);
  const ganttEvidence = extractGanttDataFromSections(input.sections);
  const chartEvidence = extractChartDataFromSections(input.sections);

  const timelineSlots = input.sections
    .filter((s) => /时间线|里程碑|timeline/i.test(`${s.heading}\n${s.content}`))
    .slice(0, 4)
    .map((s, idx) => {
      const localData = timelineEvidence.slice(0, 6);
      const ready = localData.length >= 2;
      return {
        slotId: `timeline_${idx + 1}`,
        title: s.heading,
        periodHint: "待补充周期",
        notes: s.content.slice(0, 120),
        dataSemantic: {
          kind: "timeline" as const,
          dimension: "事件",
          metric: "时间",
          periodHint: "近期",
        },
        data: ready ? localData : [],
        status: ready ? ("ready" as const) : ("needs_data" as const),
      };
    });
  const ganttSlots = input.sections
    .filter((s) => /甘特|gantt|排期|计划/i.test(`${s.heading}\n${s.content}`))
    .slice(0, 4)
    .map((s, idx) => {
      const localData = ganttEvidence.slice(0, 8);
      const ready = localData.length >= 2;
      return {
        slotId: `gantt_${idx + 1}`,
        task: s.heading,
        ownerHint: "待补充负责人",
        startHint: "待补充开始时间",
        endHint: "待补充结束时间",
        dataSemantic: {
          kind: "gantt" as const,
          dimension: "任务",
          metric: "起止",
          periodHint: "本周期",
        },
        data: ready ? localData : [],
        status: ready ? ("ready" as const) : ("needs_data" as const),
      };
    });
  const chartSlots = input.chartSuggestions.map((c, idx) => {
    const ready = chartEvidence !== null;
    return {
      slotId: `chart_${idx + 1}`,
      chartType: c.type,
      title: c.title,
      metricHint: c.dataHint,
      dataSemantic: {
        kind: normalizeChartKind(c.type),
        dimension: c.dataHint,
        metric: c.title,
        periodHint: "本期",
      },
      data: ready ? chartEvidence : undefined,
      status: ready ? ("ready" as const) : ("needs_data" as const),
    };
  });
  if (!env.AGENT_STRICT_FACT_MODE && chartSlots.length === 0) {
    chartSlots.push({
      slotId: "chart_1",
      chartType: "bar",
      title: "关键指标对比（占位）",
      metricHint: "建议填充本期与上期的关键指标",
      dataSemantic: {
        kind: "bar" as const,
        dimension: "类目",
        metric: "数值",
        periodHint: "本期 vs 上期",
      },
      data: undefined,
      status: "needs_data" as const,
    });
  }
  if (!env.AGENT_STRICT_FACT_MODE && timelineSlots.length === 0) {
    timelineSlots.push({
      slotId: "timeline_1",
      title: "关键里程碑（占位）",
      periodHint: "按周或按阶段填写时间点",
      notes: "用于在编辑工作台补全项目时间线",
      dataSemantic: {
        kind: "timeline" as const,
        dimension: "里程碑",
        metric: "时间",
        periodHint: "近期",
      },
      data: [],
      status: "needs_data" as const,
    });
  }
  if (!env.AGENT_STRICT_FACT_MODE && ganttSlots.length === 0) {
    ganttSlots.push({
      slotId: "gantt_1",
      task: "关键任务（占位）",
      ownerHint: "待补充负责人",
      startHint: "待补充开始时间",
      endHint: "待补充结束时间",
      dataSemantic: {
        kind: "gantt" as const,
        dimension: "任务",
        metric: "起止",
        periodHint: "本周期",
      },
      data: [],
      status: "needs_data" as const,
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

/**
 * Writer LLM 偶发会产出缺字段的 chart/timeline/gantt 槽位（如缺 metricHint / slotId / periodHint）。
 * 这里在送入 DraftSchema 之前统一补齐必填字段，避免 Zod 校验直接挂掉。
 * 仅补齐结构，不编造业务数据：data/data-points 仍尊重 LLM 原值。
 */
/** 把 LLM 偶发返回的字符串数值（如 "12" / "12%" / "1,234"）胁迫成 number；非有限值返回 null。 */
function coerceNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const cleaned = v.replace(/[,，%\s元万项个次人份天小时]/g, "").trim();
    if (!cleaned) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** 字符串胁迫：非空字符串原样返，其他类型转字符串后取 trim 后非空，否则返 undefined。 */
function coerceString(v: unknown): string | undefined {
  if (typeof v === "string") {
    const t = v.trim();
    return t.length > 0 ? t : undefined;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}

/**
 * 把 chart slot 的 data 子结构胁迫到 schema 期望形态：
 * - data.categories: string[]（非字符串元素 toString，丢弃空字符串）
 * - data.series[].values: number[]（"12" / "12%" → 12，丢 NaN，长度对齐 categories 后 0 填充）
 * 若胁迫后 categories 与 series 都空，则丢弃 data 字段（让 enrich 接管）。
 */
function coerceChartSlotData(rawData: unknown, fallbackChartType: string): unknown {
  if (!rawData || typeof rawData !== "object") return undefined;
  const d = rawData as Record<string, unknown>;
  const rawCategories = Array.isArray(d.categories) ? d.categories : [];
  const categories: string[] = [];
  for (const c of rawCategories) {
    const s = coerceString(c);
    if (s) categories.push(s);
  }
  const rawSeries = Array.isArray(d.series) ? d.series : [];
  const series: Array<{ name: string; values: number[] }> = [];
  rawSeries.forEach((item, idx) => {
    if (!item || typeof item !== "object") return;
    const r = item as Record<string, unknown>;
    const name = coerceString(r.name) ?? `数值${idx + 1}`;
    const rawValues = Array.isArray(r.values) ? r.values : [];
    const values: number[] = [];
    for (const v of rawValues) {
      const n = coerceNumber(v);
      if (n !== null) values.push(n);
    }
    series.push({ name, values });
  });
  if (categories.length === 0 && series.every((s) => s.values.length === 0)) return undefined;
  return { categories, series };
}

/** dataSemantic.kind 必须是 line/bar/pie/table/image 之一；不合法时按 chartType 推导兜底。 */
function coerceChartDataSemantic(raw: unknown, chartType: string): unknown {
  const allowed = new Set(["line", "bar", "pie", "table", "image"]);
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const kindCandidate = coerceString(r.kind);
  const kind = kindCandidate && allowed.has(kindCandidate) ? kindCandidate : normalizeChartKind(chartType);
  const dimension =
    coerceString(r.dimension) ??
    (Array.isArray(r.dimension) ? r.dimension.map((x) => coerceString(x)).filter(Boolean).join("/") : undefined) ??
    "维度";
  const metric =
    coerceString(r.metric) ??
    (Array.isArray(r.metric) ? r.metric.map((x) => coerceString(x)).filter(Boolean).join("/") : undefined) ??
    "指标";
  const periodHint =
    coerceString(r.periodHint) ??
    coerceString(r.period) ??
    (Array.isArray(r.periodHint) ? r.periodHint.map((x) => coerceString(x)).filter(Boolean).join("/") : undefined) ??
    "本期";
  return {
    kind,
    dimension,
    metric,
    periodHint,
  };
}

function normalizeChartSlotsArray(raw: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: Array<Record<string, unknown>> = [];
  raw.forEach((item, idx) => {
    if (!item || typeof item !== "object") return;
    const r = item as Record<string, unknown>;
    const title = firstNonEmptyText(r.title, r.name) ?? `图表槽位${idx + 1}`;
    const chartType = firstNonEmptyText(r.chartType, r.type, r.kind) ?? "bar";
    const metricHint =
      firstNonEmptyText(r.metricHint, r.dataHint, r.purpose, r.metric, r.dimension) ??
      `请补充与「${title}」相关的指标维度`;
    const slotId = firstNonEmptyText(r.slotId, r.id) ?? `chart_${idx + 1}`;
    const coercedData = coerceChartSlotData(r.data, chartType);
    const dataSemantic = coerceChartDataSemantic(r.dataSemantic, chartType);
    const next: Record<string, unknown> = { ...r, slotId, chartType, title, metricHint };
    if (coercedData !== undefined) next.data = coercedData;
    else delete next.data;
    if (dataSemantic !== undefined) next.dataSemantic = dataSemantic;
    out.push(next);
  });
  return out;
}

/** timeline.data[]: { label:string min1, when:string min1, note?:string } */
function coerceTimelineData(rawData: unknown): unknown[] | undefined {
  if (!Array.isArray(rawData)) return undefined;
  const out: Array<Record<string, unknown>> = [];
  for (const item of rawData) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const label = coerceString(r.label) ?? coerceString(r.title) ?? coerceString(r.name);
    const when = coerceString(r.when) ?? coerceString(r.date) ?? coerceString(r.time);
    if (!label || !when) continue;
    const note = coerceString(r.note) ?? coerceString(r.desc);
    out.push(note ? { label, when, note } : { label, when });
  }
  return out;
}

function normalizeTimelineSlotsArray(raw: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: Array<Record<string, unknown>> = [];
  raw.forEach((item, idx) => {
    if (!item || typeof item !== "object") return;
    const r = item as Record<string, unknown>;
    const title = firstNonEmptyText(r.title, r.name, r.heading) ?? `时间线槽位${idx + 1}`;
    const slotId = firstNonEmptyText(r.slotId, r.id) ?? `timeline_${idx + 1}`;
    const periodHint = firstNonEmptyText(r.periodHint, r.period, r.range) ?? "近期";
    const next: Record<string, unknown> = { ...r, slotId, title, periodHint };
    const data = coerceTimelineData(r.data);
    if (data !== undefined) next.data = data;
    out.push(next);
  });
  return out;
}

/** gantt.data[]: { task:string min1, owner?:string, start:string min1, end:string min1, note?:string } */
function coerceGanttData(rawData: unknown): unknown[] | undefined {
  if (!Array.isArray(rawData)) return undefined;
  const out: Array<Record<string, unknown>> = [];
  for (const item of rawData) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const task = coerceString(r.task) ?? coerceString(r.title) ?? coerceString(r.name);
    const start = coerceString(r.start) ?? coerceString(r.from) ?? coerceString(r.begin);
    const end = coerceString(r.end) ?? coerceString(r.to) ?? coerceString(r.finish);
    if (!task || !start || !end) continue;
    const owner = coerceString(r.owner) ?? coerceString(r.responsible) ?? coerceString(r.assignee);
    const note = coerceString(r.note) ?? coerceString(r.desc);
    const entry: Record<string, unknown> = { task, start, end };
    if (owner) entry.owner = owner;
    if (note) entry.note = note;
    out.push(entry);
  }
  return out;
}

function normalizeGanttSlotsArray(raw: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: Array<Record<string, unknown>> = [];
  raw.forEach((item, idx) => {
    if (!item || typeof item !== "object") return;
    const r = item as Record<string, unknown>;
    const task = firstNonEmptyText(r.task, r.title, r.name) ?? `任务${idx + 1}`;
    const slotId = firstNonEmptyText(r.slotId, r.id) ?? `gantt_${idx + 1}`;
    const next: Record<string, unknown> = { ...r, slotId, task };
    const data = coerceGanttData(r.data);
    if (data !== undefined) next.data = data;
    out.push(next);
  });
  return out;
}

/**
 * 第一次校验通过后再做一次"data 智能注入"：
 * 当 LLM 自报 chart/timeline/gantt 槽位但没填 data（status=needs_data 或 data 空），
 * 用启发式 evidence 抽取从 sections 提数据回填，并升级 status=ready。
 * 这样 ArtifactRenderer 才会真正出图，避免最终输出永远是"图表槽位（待补充数据）"。
 *
 * 仅在抽到合法证据时升级；抽不出就保持 needs_data，由模板渲染层显式提示用户补数据。
 */
function enrichDraftSlotsWithSectionEvidence(draft: Draft): Draft {
  const sections = draft.sections.map((s) => ({ heading: s.heading, content: s.content ?? "" }));
  const ganttEvidence = extractGanttDataFromSections(sections);
  const timelineEvidence = extractTimelineDataFromSections(sections);
  const chartEvidence = extractChartDataFromSections(sections);

  const enrichedGantt = draft.ganttSlots.map((slot) => {
    const hasOwnData = (slot.data ?? []).length >= 2;
    if (slot.status === "ready" && hasOwnData) return slot;
    if (ganttEvidence.length < 2) return slot;
    return { ...slot, data: ganttEvidence.slice(0, 8), status: "ready" as const };
  });
  const enrichedTimeline = draft.timelineSlots.map((slot) => {
    const hasOwnData = (slot.data ?? []).length >= 2;
    if (slot.status === "ready" && hasOwnData) return slot;
    if (timelineEvidence.length < 2) return slot;
    return { ...slot, data: timelineEvidence.slice(0, 8), status: "ready" as const };
  });
  const enrichedChart = draft.chartSlots.map((slot) => {
    const ownData = slot.data;
    const hasOwnData =
      ownData && ownData.categories.length > 0 && ownData.series.some((s) => s.values.length > 0);
    if (slot.status === "ready" && hasOwnData) return slot;
    if (!chartEvidence) return slot;
    return { ...slot, data: chartEvidence, status: "ready" as const };
  });

  return {
    ...draft,
    ganttSlots: enrichedGantt,
    timelineSlots: enrichedTimeline,
    chartSlots: enrichedChart,
  };
}

/**
 * Writer LLM 输出在送入 schema 校验前的轻量结构归一化：仅补齐必填字段，不修改业务字段。
 */
function preNormalizeDraftPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const record = payload as Record<string, unknown>;
  const next: Record<string, unknown> = { ...record };
  const chartSlots = normalizeChartSlotsArray(record.chartSlots);
  const timelineSlots = normalizeTimelineSlotsArray(record.timelineSlots);
  const ganttSlots = normalizeGanttSlotsArray(record.ganttSlots);
  if (chartSlots) next.chartSlots = chartSlots;
  if (timelineSlots) next.timelineSlots = timelineSlots;
  if (ganttSlots) next.ganttSlots = ganttSlots;
  return next;
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

  /**
   * record.* 仍可能缺字段（slotId/metricHint/periodHint/task），先做轻量归一化再回退兜底，
   * 杜绝「LLM 返回 chartSlots 但缺 metricHint 直接 schema 校验失败」的情况。
   */
  const normalizedChartSlotsFromRecord = normalizeChartSlotsArray(record.chartSlots);
  const normalizedTimelineSlotsFromRecord = normalizeTimelineSlotsArray(record.timelineSlots);
  const normalizedGanttSlotsFromRecord = normalizeGanttSlotsArray(record.ganttSlots);

  return {
    format: "doc",
    title,
    summary,
    sections,
    chartSuggestions: normalizedChartSuggestions,
    openQuestions,
    sectionBlocks: Array.isArray(record.sectionBlocks) ? record.sectionBlocks : v2.sectionBlocks,
    timelineSlots: normalizedTimelineSlotsFromRecord ?? v2.timelineSlots,
    ganttSlots: normalizedGanttSlotsFromRecord ?? v2.ganttSlots,
    chartSlots: normalizedChartSlotsFromRecord ?? v2.chartSlots,
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
  modelOverride?: string,
): Promise<unknown> {
  const raw = await invokeBailianModel({
    model: modelOverride ?? env.BAILIAN_MODEL_WRITER,
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
    timeoutMs: env.WRITER_LLM_TIMEOUT_MS,
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
  const evidence = computeEvidenceTelemetry(input.sourceEvidence);
  const factCount = input.analysis.normalizedFacts.filter((f) => f.trim().length > 0).length;
  if (env.AGENT_STRICT_FACT_MODE && factCount === 0 && evidence.evidenceSourceCount === 0) {
    throw new Error("严格真实模式：Writer 阶段没有任何事实证据，拒绝生成占位化初稿。");
  }
  logger.info("[writer-telemetry] drafting started", {
    sessionId: input.userRequest.sessionId,
    userId: input.userRequest.userId,
    selectedSkillId: input.plan.selectedSkillId,
    workflowTemplateId: input.skillMatch.workflowMeta?.workflowTemplateId,
    targetSectionCount: input.plan.targetSections.length,
    analysisFactCount: factCount,
    evidenceChars: evidence.evidenceChars,
    evidenceSourceCount: evidence.evidenceSourceCount,
  });
  const writerModels = buildWriterModelCandidates();
  const invokeWriterWithCandidates = async (extraInstruction?: string): Promise<unknown> => {
    let lastError: unknown = null;
    for (const model of writerModels) {
      try {
        return await invokeWriterRaw(
          {
            userRequest: input.userRequest,
            plan: input.plan,
            analysis: input.analysis,
            skillMatch: input.skillMatch,
            rewriteHints: input.rewriteHints,
            sourceEvidence: input.sourceEvidence,
          },
          extraInstruction,
          model,
        );
      } catch (error) {
        lastError = error;
        logger.warn("[writer] model attempt failed, try next candidate", {
          model,
          timeoutMs: env.WRITER_LLM_TIMEOUT_MS,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    throw lastError ?? new Error("Writer LLM 调用失败");
  };
  try {
    const firstPayloadRaw = await invokeWriterWithCandidates();
    const firstPayload = preNormalizeDraftPayload(firstPayloadRaw);
    const firstTry = DraftSchema.safeParse(firstPayload);
    if (firstTry.success) {
      const enriched = enrichDraftSlotsWithSectionEvidence(firstTry.data);
      logger.info("[writer-telemetry] drafting succeeded first-pass", {
        sessionId: input.userRequest.sessionId,
        sectionCount: enriched.sections.length,
        chartSlotCount: enriched.chartSlots.length,
        timelineSlotCount: enriched.timelineSlots.length,
        ganttSlotCount: enriched.ganttSlots.length,
        readyChartSlots: enriched.chartSlots.filter((s) => s.status === "ready").length,
        readyGanttSlots: enriched.ganttSlots.filter((s) => s.status === "ready").length,
        readyTimelineSlots: enriched.timelineSlots.filter((s) => s.status === "ready").length,
      });
      return enriched;
    }

    const repairedPayload = repairDraftPayload(firstPayload, {
      userRequest: input.userRequest,
      plan: input.plan,
      analysis: input.analysis,
    });
    const repaired = DraftSchema.safeParse(repairedPayload);
    if (repaired.success) {
      const enriched = enrichDraftSlotsWithSectionEvidence(repaired.data);
      logger.warn("Writer JSON 初次校验失败，已通过本地 repair 纠正", {
        issues: firstTry.error.issues.map((issue) => `${issue.path.join(".")}:${issue.message}`).slice(0, 6),
      });
      logger.info("[writer-telemetry] drafting succeeded by repair", {
        sessionId: input.userRequest.sessionId,
        sectionCount: enriched.sections.length,
        chartSlotCount: enriched.chartSlots.length,
        timelineSlotCount: enriched.timelineSlots.length,
        ganttSlotCount: enriched.ganttSlots.length,
      });
      return enriched;
    }

    const retryPayloadRaw = await invokeWriterWithCandidates(
      `上一轮输出未通过校验：${firstTry.error.issues
        .map((issue) => `${issue.path.join(".")}:${issue.message}`)
        .slice(0, 8)
        .join(" | ")}。请返回完全符合 DraftSchema 的 JSON。特别注意每个 chartSlots/timelineSlots/ganttSlots 元素必须包含 slotId、必填字段（chartSlots.metricHint、timelineSlots.periodHint、ganttSlots.task 等）。`,
    );
    const retryPayload = preNormalizeDraftPayload(retryPayloadRaw);
    const repairedRetry = DraftSchema.safeParse(retryPayload);
    if (repairedRetry.success) {
      const enriched = enrichDraftSlotsWithSectionEvidence(repairedRetry.data);
      logger.info("[writer-telemetry] drafting succeeded after retry", {
        sessionId: input.userRequest.sessionId,
        sectionCount: enriched.sections.length,
        chartSlotCount: enriched.chartSlots.length,
        timelineSlotCount: enriched.timelineSlots.length,
        ganttSlotCount: enriched.ganttSlots.length,
      });
      return enriched;
    }
    /**
     * 重试仍失败时，再用 repair 把缺字段的 LLM 输出回退到 v2 兜底骨架（结构上保证可解析），
     * 让上层不再触发严格模式硬抛错。
     */
    const repairedRetryPayload = repairDraftPayload(retryPayload, {
      userRequest: input.userRequest,
      plan: input.plan,
      analysis: input.analysis,
    });
    const parsedRetry = DraftSchema.parse(repairedRetryPayload);
    const enrichedRetry = enrichDraftSlotsWithSectionEvidence(parsedRetry);
    logger.info("[writer-telemetry] drafting succeeded after retry+repair", {
      sessionId: input.userRequest.sessionId,
      sectionCount: enrichedRetry.sections.length,
      chartSlotCount: enrichedRetry.chartSlots.length,
      timelineSlotCount: enrichedRetry.timelineSlots.length,
      ganttSlotCount: enrichedRetry.ganttSlots.length,
    });
    return enrichedRetry;
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    if (env.AGENT_STRICT_FACT_MODE) {
      throw new Error(
        `严格真实模式：Writer 失败且不允许兜底占位稿（含超时）。原始错误：${errMsg}`,
      );
    }
    const isTimeout = errMsg.includes("超时") || errMsg.includes("timeout") || errMsg.includes("Abort");
    if (isTimeout) {
      logger.warn("Writer LLM 超时，已使用兜底草稿（超时不受严格模式拦截）", { message: errMsg });
    } else {
      logger.warn("Writer JSON 调用失败，已使用兜底草稿", { message: errMsg });
    }
    const fallback = fallbackDraft(input);
    logger.info("[writer-telemetry] drafting fallback used", {
      sessionId: input.userRequest.sessionId,
      sectionCount: fallback.sections.length,
      chartSlotCount: fallback.chartSlots.length,
      timelineSlotCount: fallback.timelineSlots.length,
      ganttSlotCount: fallback.ganttSlots.length,
    });
    return fallback;
  }
}
