import {
  AnalystOutputSchema,
  type ChartCandidate,
  type KpiEntry,
  type RetrievalContext,
  type Skill,
} from "../../schemas/index.js";
import type { ReportGraphStateType } from "../state.js";

// 中文+常见单位的数值模式：如 "3,200 人"、"12.5%"、"增长 8%"、"同比 +15%"
const NUMERIC_PATTERN =
  /(?<delta>同比|环比|增长|下降|提升|下滑|增加|减少|\+|-)?\s*(?<value>[\d.,]+)\s*(?<unit>%|人|元|万|亿|亿元|万元|个|次|天|小时|分钟|单|笔)/g;

const UP_KEYWORDS = ["增长", "提升", "增加", "上升", "改善", "+"];
const DOWN_KEYWORDS = ["下降", "下滑", "减少", "下跌", "恶化", "-"];

// 一旦匹配位置附近的窗口出现这些短语，我们认为"这条数字不是业务 KPI"，
// 直接放弃抽取。例如 "比竞品多出了 2 个跳转页面" 中的 2 个跳转页面。
const CONTEXT_HARD_REJECT_PHRASES = [
  "比竞品",
  "跳转",
  "反馈",
  "页面",
  "流程",
  "群里",
  "提到",
  "表示",
  "太长",
  "较长",
  "过长",
];

// name 子串黑名单：只要包含这些词，十有八九不是 KPI 名
const NAME_NOISE_SUBSTRINGS = [
  "反馈",
  "流程",
  "页面",
  "跳转",
  "群里",
  "提到",
  "表示",
  "太长",
  "较长",
  "环节",
  "方面",
  "情况",
  "竞品",
];

// 常见尾部动词/连接词：stripTailVerbs 会把它们从 name 尾部迭代剥掉
const TAIL_VERBS = [
  "提升",
  "下降",
  "下滑",
  "增长",
  "增加",
  "减少",
  "多出了",
  "多出",
  "比竞品",
  "上升",
  "达到",
  "超过",
  "预计",
  "估计",
  "大约",
  "约",
];

// 纯虚词/助词，name 首尾出现都应去掉
const TRAILING_PARTICLES = /[了的得已过着是到]$/u;
const LEADING_PARTICLES = /^[比较约是为对在当]+/u;

function cleanKpiName(raw: string): string {
  let s = raw.trim();
  // 1) 去尾部虚词（迭代）
  while (s.length > 0 && TRAILING_PARTICLES.test(s)) s = s.slice(0, -1);
  // 2) 取 "X的Y" 的 Y（用最后一个"的"之后的部分作为核心名词）
  s = s.split(/的/u).pop() ?? s;
  // 3) 去尾部动词（迭代剥）
  let changed = true;
  while (changed) {
    changed = false;
    for (const v of TAIL_VERBS) {
      if (s.length > v.length && s.endsWith(v)) {
        s = s.slice(0, -v.length);
        changed = true;
        break;
      }
    }
  }
  // 4) 去首部虚词
  s = s.replace(LEADING_PARTICLES, "");
  return s.trim();
}

// 合法 KPI 名：长度 2-5，不含噪声子串，不是纯标点/数字
function isValidKpiName(name: string): boolean {
  if (!name) return false;
  if (name.length < 2 || name.length > 5) return false;
  if (/^[\s\d.,，。；;、%+\-]+$/.test(name)) return false;
  if (NAME_NOISE_SUBSTRINGS.some((w) => name.includes(w))) return false;
  if (TAIL_VERBS.includes(name)) return false;
  return true;
}

function pickTrend(delta: string | undefined, value: string): "up" | "down" | "flat" | "unknown" {
  const text = `${delta ?? ""}${value}`;
  if (UP_KEYWORDS.some((kw) => text.includes(kw))) return "up";
  if (DOWN_KEYWORDS.some((kw) => text.includes(kw))) return "down";
  return "unknown";
}

/**
 * 从匹配位置向前扫，提取最接近的名词短语作为 KPI 名称。
 * 策略：
 *   1) 取前 14 字的窗口；若窗口里出现 CONTEXT_HARD_REJECT_PHRASES，整条样本丢弃
 *   2) 按句读/虚词切分成 tokens，倒序遍历
 *   3) 每个 token 取最后 6 字做 cleanKpiName → 再做 isValidKpiName 校验
 *   4) 全不合格则返回空串
 */
function guessKpiName(content: string, matchIndex: number): string {
  const window = content.slice(Math.max(0, matchIndex - 14), matchIndex);

  if (CONTEXT_HARD_REJECT_PHRASES.some((p) => window.includes(p))) {
    return "";
  }

  const tokens = window
    .split(/[，,。；;、:：\s（）()「」《》""''"'\-]+/u)
    .map((t) => t.trim())
    .filter(Boolean);

  for (let i = tokens.length - 1; i >= 0; i--) {
    const token = tokens[i]!;
    const tail = token.slice(-6);
    const cleaned = cleanKpiName(tail);
    if (isValidKpiName(cleaned)) return cleaned;
  }
  return "";
}

function extractKpis(context: RetrievalContext): KpiEntry[] {
  const kpis: KpiEntry[] = [];
  const seen = new Set<string>();

  for (const item of context.projectContext) {
    const content = item.content ?? "";
    if (!content) continue;

    NUMERIC_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = NUMERIC_PATTERN.exec(content)) !== null) {
      const value = match.groups?.value;
      const unit = match.groups?.unit;
      const delta = match.groups?.delta;
      if (!value || !unit) continue;

      const name = guessKpiName(content, match.index);
      if (!name) continue; // 没抓到干净的 name，丢弃该样本（避免"比竞品多出了=2个"这类噪声）

      const dedupKey = `${item.sourceId}::${name}::${value}${unit}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      kpis.push({
        name,
        value,
        unit,
        trend: pickTrend(delta, value),
        delta: delta?.trim() || undefined,
        sourceId: item.sourceId,
      });

      if (kpis.length >= 20) return kpis; // 上限保护
    }
  }
  return kpis;
}

function recommendCharts(kpis: KpiEntry[], skill: Skill): ChartCandidate[] {
  const chartRules = skill.chartRules ?? [];
  const candidates: ChartCandidate[] = [];

  const hasPercent = kpis.some((k) => k.unit === "%");
  const hasCount = kpis.some((k) => ["人", "个", "次", "单", "笔"].includes(k.unit ?? ""));
  const hasMoney = kpis.some((k) => ["元", "万", "亿", "万元", "亿元"].includes(k.unit ?? ""));
  const hasTrend = kpis.some((k) => k.trend === "up" || k.trend === "down");

  if (hasTrend) {
    candidates.push({
      type: "line",
      title: "关键指标趋势",
      purpose: "展示指标的周期变化与同环比走势",
      dataHint: kpis
        .filter((k) => k.trend === "up" || k.trend === "down")
        .slice(0, 5)
        .map((k) => `${k.name}=${k.value}${k.unit ?? ""}`)
        .join("；") || "按周期对齐后的核心指标",
      priority: 0.9,
    });
  }

  if (hasCount || hasMoney) {
    candidates.push({
      type: "bar",
      title: "核心量级对比",
      purpose: "对比不同维度下的关键量级指标",
      dataHint: kpis
        .filter((k) => ["人", "个", "次", "元", "万", "亿", "万元", "亿元"].includes(k.unit ?? ""))
        .slice(0, 5)
        .map((k) => `${k.name}=${k.value}${k.unit ?? ""}`)
        .join("；") || "按维度分组的计数/金额",
      priority: 0.7,
    });
  }

  if (hasPercent) {
    candidates.push({
      type: "pie",
      title: "占比结构",
      purpose: "呈现占比类指标的构成关系",
      dataHint: kpis
        .filter((k) => k.unit === "%")
        .slice(0, 5)
        .map((k) => `${k.name}=${k.value}%`)
        .join("；") || "按维度划分的占比",
      priority: 0.5,
    });
  }

  // 如果 skill.chartRules 明确提到某类图表，顺带加 bonus
  for (const rule of chartRules) {
    if (rule.includes("折线") && !candidates.some((c) => c.type === "line")) {
      candidates.push({
        type: "line",
        title: "核心指标趋势",
        purpose: rule,
        dataHint: "按时间序列对齐的核心指标",
        priority: 0.6,
      });
    }
    if (rule.includes("柱状") && !candidates.some((c) => c.type === "bar")) {
      candidates.push({
        type: "bar",
        title: "核心维度对比",
        purpose: rule,
        dataHint: "按维度分组对比",
        priority: 0.5,
      });
    }
  }

  return candidates.sort((a, b) => b.priority - a.priority).slice(0, 6);
}

function assessDataQuality(
  context: RetrievalContext,
  kpis: KpiEntry[],
): string[] {
  const notes: string[] = [];
  const hasStructuredSource = context.projectContext.some((ctx) =>
    ["doc", "table", "external"].includes(ctx.sourceType),
  );
  if (!hasStructuredSource) {
    notes.push("缺少结构化数据源（doc/table/external），指标口径可能不一致，建议人工二次校核。");
  }
  if (kpis.length === 0) {
    notes.push("未从上下文中提取到数值型指标，建议补充带有量化数据的素材。");
  }
  if (kpis.length > 0) {
    const unknownTrend = kpis.filter((k) => k.trend === "unknown").length;
    if (unknownTrend / kpis.length > 0.6) {
      notes.push("多数指标缺少同比/环比方向信息，趋势判断存在不确定性。");
    }
  }
  const units = new Set(kpis.map((k) => k.unit).filter(Boolean));
  if (units.has("万") && units.has("亿")) {
    notes.push("金额单位同时出现“万”和“亿”，请在正文中统一换算口径。");
  }
  return notes;
}

function buildHighlights(kpis: KpiEntry[]): string[] {
  return kpis
    .filter((k) => k.trend === "up" || k.trend === "down")
    .slice(0, 5)
    .map(
      (k) =>
        `${k.name}: ${k.value}${k.unit ?? ""}（趋势 ${k.trend}${k.delta ? `，线索:${k.delta}` : ""}）`,
    );
}

export async function analystNode(
  state: ReportGraphStateType,
): Promise<Partial<ReportGraphStateType>> {
  if (!state.userRequest || !state.retrievalContext || !state.taskPlan) {
    throw new Error("analyst_node 缺少 userRequest/retrievalContext/taskPlan");
  }

  const kpis = extractKpis(state.retrievalContext);
  const chartCandidates = recommendCharts(kpis, state.retrievalContext.matchedSkill);
  const dataQualityNotes = assessDataQuality(state.retrievalContext, kpis);
  const highlights = buildHighlights(kpis);

  const analystOutput = AnalystOutputSchema.parse({
    kpis,
    chartCandidates,
    dataQualityNotes,
    highlights,
  });

  const followUpQuestions = state.taskPlan.missingFields.map(
    (field) => `请补充字段：${field}（可通过 IM 联系人收集）`,
  );

  return {
    analystOutput,
    followUpQuestions,
    debugTrace: [
      `[analyst_node] extracted kpis=${kpis.length} charts=${chartCandidates.length} notes=${dataQualityNotes.length}`,
      `[analyst_node] follow-up questions=${followUpQuestions.length}`,
    ],
  };
}
