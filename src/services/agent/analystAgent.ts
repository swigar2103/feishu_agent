import {
  AnalysisResultSchema,
  type AnalysisResult,
  type DetailedContext,
  type ExecutionPlan,
} from "../../schemas/agentContracts.js";
import { z } from "zod";
import { env } from "../../config/env.js";
import { invokeJsonModel } from "../../llm/jsonModel.js";
import { buildAnalystSystemPrompt, buildAnalystUserPrompt } from "../../prompts/agentPrompts.js";
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
    throw new Error("严格真实模式：检索阶段未获得任何事实证据，已中止分析与生成。");
  }
  try {
    const result = await invokeJsonModel(z.unknown(), {
      systemPrompt: buildAnalystSystemPrompt(),
      userPrompt: buildAnalystUserPrompt(input),
    });
    return normalizeAnalysisOutput(result, input);
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
