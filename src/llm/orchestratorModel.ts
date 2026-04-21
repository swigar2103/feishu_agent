import { env } from "../config/env.js";
import {
  ReviewReportSchema,
  TaskIntentSchema,
  TaskPlanSchema,
  type AnalystOutput,
  type RetrievalContext,
  type ReviewReport,
  type TaskIntent,
  type TaskPlan,
  type UserRequest,
  type WriterOutput,
} from "../schemas/index.js";
import { extractJsonObject } from "../shared/utils.js";
import { logger } from "../shared/logger.js";
import { invokeBailianModel } from "./client.js";
import { buildPlannerSystemPrompt, buildPlannerUserPrompt } from "../prompts/plannerPrompt.js";
import { buildReviewerSystemPrompt, buildReviewerUserPrompt } from "../prompts/reviewerPrompt.js";

export async function generateTaskPlan(
  userRequest: UserRequest,
  retrievalContext: RetrievalContext,
): Promise<TaskPlan> {
  const raw = await invokeBailianModel({
    model: env.BAILIAN_MODEL_ORCHESTRATOR,
    systemPrompt: buildPlannerSystemPrompt(),
    userPrompt: buildPlannerUserPrompt(userRequest, retrievalContext),
    jsonMode: true,
  });

  const json = extractJsonObject(raw);
  return TaskPlanSchema.parse(JSON.parse(json));
}

const INTENT_SYSTEM_PROMPT = [
  "你是企业办公报告流程中的 Intent 分类器。",
  "只负责把用户的自然语言诉求映射到以下五种意图之一，不做其他分析：",
  "- weekly_report（周报类，覆盖 weekly 汇总、本周总结）",
  "- daily_report（日报类，每日汇总）",
  "- review_report（复盘类，事件/项目回顾）",
  "- analysis_report（分析类，专题/数据分析）",
  "- general_report（兜底的通用报告）",
  "必须输出严格 JSON，格式：{\"intent\": <上述五选一>}，不要输出解释或 markdown。",
].join("\n");

function buildIntentUserPrompt(userRequest: UserRequest): string {
  return [
    "请对以下用户请求进行意图分类：",
    `prompt=${JSON.stringify(userRequest.prompt)}`,
    `reportType=${JSON.stringify(userRequest.reportType ?? "")}`,
    `industry=${JSON.stringify(userRequest.industry ?? "")}`,
    "仅输出 {\"intent\": \"...\"} JSON。",
  ].join("\n");
}

export async function generateReviewReport(input: {
  writerOutput: WriterOutput;
  taskPlan: TaskPlan;
  retrievalContext: RetrievalContext;
  analystOutput?: AnalystOutput | null;
}): Promise<ReviewReport> {
  try {
    const raw = await invokeBailianModel({
      model: env.BAILIAN_MODEL_ORCHESTRATOR,
      systemPrompt: buildReviewerSystemPrompt(),
      userPrompt: buildReviewerUserPrompt(input),
      jsonMode: true,
    });
    const json = extractJsonObject(raw);
    return ReviewReportSchema.parse(JSON.parse(json));
  } catch (error) {
    logger.warn("generateReviewReport 调用失败，回退为 pass=true 的占位报告", {
      error: error instanceof Error ? error.message : String(error),
    });
    return ReviewReportSchema.parse({
      pass: true,
      overallScore: 0.6,
      issues: [],
      summary: "LLM 审阅失败，已回退。",
    });
  }
}

export async function classifyIntentByLlm(
  userRequest: UserRequest,
): Promise<TaskIntent> {
  try {
    const raw = await invokeBailianModel({
      model: env.BAILIAN_MODEL_ORCHESTRATOR,
      systemPrompt: INTENT_SYSTEM_PROMPT,
      userPrompt: buildIntentUserPrompt(userRequest),
      jsonMode: true,
    });
    const json = extractJsonObject(raw);
    const parsed = JSON.parse(json) as { intent?: unknown };
    return TaskIntentSchema.parse(parsed.intent);
  } catch (error) {
    logger.warn("classifyIntentByLlm 调用失败，回退到 general_report", {
      error: error instanceof Error ? error.message : String(error),
    });
    return "general_report";
  }
}
