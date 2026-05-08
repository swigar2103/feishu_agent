import {
  AnalysisResultSchema,
  type AnalysisResult,
  type DetailedContext,
  type ExecutionPlan,
} from "../../schemas/agentContracts.js";
import { z } from "zod";
import { env } from "../../config/env.js";
import { invokeJsonModel } from "../../llm/jsonModel.js";
import { buildAnalystSystemPrompt } from "../../prompts/agentPrompts.js";
import { logger } from "../../shared/logger.js";
import { getErrorMessage, summarizeError } from "../../shared/errorSummary.js";

function fallbackAnalysis(input: {
  plan: ExecutionPlan;
  context: DetailedContext;
}): AnalysisResult {
  const normalizedFacts = input.context.facts.map((item) => item.fact);
  const keyInsights = normalizedFacts.slice(0, 3);
  return AnalysisResultSchema.parse({
    normalizedFacts,
    metricDefinitions: input.plan.targetSections.map((section) => `${section}: 使用统一统计周期口径`),
    keyInsights,
    chartSuggestions: [
      {
        type: "line",
        title: "关键指标趋势",
        purpose: "展示本周期变化趋势",
        dataHint: "按时间序列聚合关键指标",
      },
    ],
  });
}

function toText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const preferred = [
      "fact",
      "text",
      "content",
      "summary",
      "insight",
      "title",
      "value",
      "name",
      "description",
    ];
    for (const key of preferred) {
      const picked = obj[key];
      if (typeof picked === "string" && picked.trim().length > 0) return picked.trim();
    }
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return "";
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => toText(item))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function clipText(text: string, maxChars: number): string {
  const value = text.trim();
  if (!value) return value;
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}…`;
}

function buildCompactAnalystUserPrompt(input: {
  plan: ExecutionPlan;
  context: DetailedContext;
}): string {
  const compactPlan = {
    targetSections: input.plan.targetSections,
    targetTone: input.plan.targetTone,
    reportType: input.plan.reportType,
    prioritizedResourceIds: input.plan.prioritizedResourceIds.slice(0, 12),
    expansionDecision: input.plan.expansionDecision
      ? {
          targetFolderTokens: input.plan.expansionDecision.targetFolderTokens.slice(0, 8),
          reason: input.plan.expansionDecision.reason,
        }
      : undefined,
  };

  const compactFacts = input.context.facts
    .slice(0, env.ANALYST_PROMPT_MAX_FACTS)
    .map((item) => ({
      sourceId: item.sourceId,
      fact: clipText(item.fact, env.ANALYST_PROMPT_MAX_FACT_CHARS),
      evidence: item.evidence ? clipText(item.evidence, env.ANALYST_PROMPT_MAX_FACT_CHARS) : undefined,
    }));

  const compactSourceDetails = input.context.sourceDetails
    .slice(0, env.ANALYST_PROMPT_MAX_SOURCE_DETAILS)
    .map((item) => ({
      resourceId: item.resourceId,
      detail: clipText(item.detail, env.ANALYST_PROMPT_MAX_DETAIL_CHARS),
    }));

  const contextSummary = {
    factCount: input.context.facts.length,
    sourceDetailCount: input.context.sourceDetails.length,
    selectedFacts: compactFacts,
    selectedSourceDetails: compactSourceDetails,
  };

  return [
    "请产出分析结果（严格基于以下真实证据，不得臆造）。",
    `plan=${JSON.stringify(compactPlan)}`,
    `contextSummary=${JSON.stringify(contextSummary)}`,
  ].join("\n");
}

function buildAnalystModelCandidates(): string[] {
  const values = [
    env.BAILIAN_MODEL_ANALYST,
    env.BAILIAN_MODEL_ORCHESTRATOR,
    env.BAILIAN_MODEL_ANALYST_FALLBACK,
  ]
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  return [...new Set(values)];
}

function normalizeAnalysisOutput(raw: unknown, input: {
  plan: ExecutionPlan;
  context: DetailedContext;
}): AnalysisResult {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};

  const normalizedFacts = toStringArray(
    obj.normalizedFacts ?? obj.facts ?? obj.factList ?? obj.cleanedFacts,
  );

  const metricDefinitions = toStringArray(
    obj.metricDefinitions ?? obj.metrics ?? obj.metricDefs ?? obj.metricDefinition,
  );

  const keyInsightsSource = obj.keyInsights ?? obj.insights ?? obj.keyPoints ?? obj.highlights;
  const keyInsights = Array.isArray(keyInsightsSource)
    ? toStringArray(keyInsightsSource)
    : keyInsightsSource
      ? toStringArray([keyInsightsSource])
      : [];

  const rawCharts = obj.chartSuggestions ?? obj.charts ?? obj.chartSlots ?? [];
  const chartArray = Array.isArray(rawCharts) ? rawCharts : [rawCharts];
  const chartSuggestions = chartArray
    .map((item) => {
      if (typeof item === "string") {
        const title = item.trim();
        return {
          type: "chart",
          title: title || "图表",
          purpose: "展示关键指标或结论",
          dataHint: title || "请基于事实补充数据来源",
        };
      }
      if (!item || typeof item !== "object") return null;
      const chart = item as Record<string, unknown>;
      return {
        type: toText(chart.type ?? chart.chartType ?? chart.kind) || "chart",
        title: toText(chart.title ?? chart.name) || "图表",
        purpose: toText(chart.purpose ?? chart.why ?? chart.description) || "展示关键结论",
        dataHint:
          toText(chart.dataHint ?? chart.metricHint ?? chart.dataSource ?? chart.data) ||
          "请基于事实补充数据来源",
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);

  // 若模型未给出图表建议，至少保留一个基础槽位，避免后续 Writer 链路断裂。
  const ensuredCharts =
    chartSuggestions.length > 0
      ? chartSuggestions
      : [
          {
            type: "line",
            title: "关键指标趋势",
            purpose: "展示本周期变化趋势",
            dataHint: "按时间序列聚合关键指标",
          },
        ];

  return AnalysisResultSchema.parse({
    normalizedFacts,
    metricDefinitions:
      metricDefinitions.length > 0
        ? metricDefinitions
        : input.plan.targetSections.map((section) => `${section}: 使用统一统计周期口径`),
    keyInsights,
    chartSuggestions: ensuredCharts,
  });
}

export async function analyzeContext(input: {
  plan: ExecutionPlan;
  context: DetailedContext;
}): Promise<AnalysisResult> {
  if (env.AGENT_STRICT_FACT_MODE && input.context.facts.length === 0) {
    // 无证据时不再直接中止，改为降级：注入提示让 Writer 明确告知用户需要补充素材
    logger.warn("[analyst] 严格模式：0 条事实，降级为素材缺失提示而非中止");
    return AnalysisResultSchema.parse({
      normalizedFacts: ["（当前未检索到相关业务文档，请补充本周具体事项或在消息中附上参考文档链接后重试）"],
      metricDefinitions: [],
      keyInsights: ["素材缺失：Agent 未能从纳管目录中获取相关数据"],
      chartSuggestions: [],
    });
  }
  try {
    const modelCandidates = buildAnalystModelCandidates();
    const userPrompt = buildCompactAnalystUserPrompt(input);
    let lastError: unknown = null;

    for (const model of modelCandidates) {
      try {
        const result = await invokeJsonModel(z.unknown(), {
          systemPrompt: buildAnalystSystemPrompt(),
          userPrompt,
          model,
          timeoutMs: env.ANALYST_LLM_TIMEOUT_MS,
        });
        return normalizeAnalysisOutput(result, input);
      } catch (error) {
        lastError = error;
        logger.warn("[analyst] model attempt failed, try next candidate", {
          model,
          timeoutMs: env.ANALYST_LLM_TIMEOUT_MS,
          error: summarizeError(error),
        });
      }
    }
    throw lastError ?? new Error("Analyst LLM 调用失败");
  } catch (error) {
    logger.error("[analyst] analyzeContext failed", {
      strictMode: env.AGENT_STRICT_FACT_MODE,
      factCount: input.context.facts.length,
      error: summarizeError(error),
    });
    if (env.AGENT_STRICT_FACT_MODE) {
      throw new Error(
        `严格真实模式：Analyst 解析失败，拒绝回退到规则化分析。原始原因：${getErrorMessage(error)}`,
      );
    }
    return fallbackAnalysis(input);
  }
}
