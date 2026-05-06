import {
  AnalysisResultSchema,
  type AnalysisResult,
  type DetailedContext,
  type ExecutionPlan,
} from "../../schemas/agentContracts.js";
import { env } from "../../config/env.js";
import { invokeJsonModel } from "../../llm/jsonModel.js";
import { buildAnalystSystemPrompt, buildAnalystUserPrompt } from "../../prompts/agentPrompts.js";

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

export async function analyzeContext(input: {
  plan: ExecutionPlan;
  context: DetailedContext;
}): Promise<AnalysisResult> {
  if (env.AGENT_STRICT_FACT_MODE && input.context.facts.length === 0) {
    throw new Error("严格真实模式：检索阶段未获得任何事实证据，已中止分析与生成。");
  }
  try {
    const result = await invokeJsonModel(AnalysisResultSchema, {
      systemPrompt: buildAnalystSystemPrompt(),
      userPrompt: buildAnalystUserPrompt(input),
    });
    return AnalysisResultSchema.parse(result);
  } catch {
    if (env.AGENT_STRICT_FACT_MODE) {
      throw new Error("严格真实模式：Analyst 解析失败，拒绝回退到规则化分析。");
    }
    return fallbackAnalysis(input);
  }
}
