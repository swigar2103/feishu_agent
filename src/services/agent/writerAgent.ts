import { env } from "../../config/env.js";
import { logger } from "../../shared/logger.js";
import {
  DraftSchema,
  type AnalysisResult,
  type Draft,
  type ExecutionPlan,
  type SkillMatch,
} from "../../schemas/agentContracts.js";
import type { UserRequest } from "../../schemas/index.js";
import { invokeJsonModel } from "../../llm/jsonModel.js";
import { buildWriterSystemPrompt, buildWriterUserPrompt } from "../../prompts/reviewPrompts.js";

function collectAnalysisLines(analysis: AnalysisResult): string[] {
  return [...analysis.keyInsights, ...analysis.normalizedFacts].filter(
    (s) => typeof s === "string" && s.trim().length > 0,
  );
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
  });
}

export async function writeDraft(input: {
  userRequest: UserRequest;
  plan: ExecutionPlan;
  analysis: AnalysisResult;
  skillMatch: SkillMatch;
  rewriteHints?: string[];
}): Promise<Draft> {
  try {
    const result = await invokeJsonModel(DraftSchema, {
      model: env.BAILIAN_MODEL_WRITER,
      systemPrompt: buildWriterSystemPrompt(),
      userPrompt: buildWriterUserPrompt(input),
    });
    return DraftSchema.parse(result);
  } catch (error) {
    logger.warn("Writer JSON 调用失败，已使用兜底草稿", {
      message: error instanceof Error ? error.message : String(error),
    });
    return fallbackDraft(input);
  }
}
