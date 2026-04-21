import { classifyIntentByLlm } from "../../llm/orchestratorModel.js";
import { TaskIntentSchema, type TaskIntent } from "../../schemas/index.js";
import type { ReportGraphStateType } from "../state.js";

type FastPathResult = { intent: TaskIntent; confident: boolean };

// 第一层：关键词 fast path，命中即返回，避免不必要的 LLM 调用。
// confident=false 表示落到兜底 general_report，需要 LLM 二次分类。
function detectIntentByKeyword(prompt: string, reportType?: string): FastPathResult {
  const text = `${prompt} ${reportType ?? ""}`.toLowerCase();
  if (text.includes("周报") || text.includes("weekly")) {
    return { intent: "weekly_report", confident: true };
  }
  if (text.includes("日报") || text.includes("daily")) {
    return { intent: "daily_report", confident: true };
  }
  if (text.includes("复盘") || text.includes("回顾") || text.includes("retrospect")) {
    return { intent: "review_report", confident: true };
  }
  if (text.includes("分析") || text.includes("analysis") || text.includes("专题")) {
    return { intent: "analysis_report", confident: true };
  }
  return { intent: "general_report", confident: false };
}

export async function intentNode(
  state: ReportGraphStateType,
): Promise<Partial<ReportGraphStateType>> {
  if (!state.userRequest) {
    throw new Error("intent_node 缺少 userRequest");
  }

  const fast = detectIntentByKeyword(
    state.userRequest.prompt,
    state.userRequest.reportType,
  );

  let intent: TaskIntent = fast.intent;
  let source: "keyword" | "llm" = "keyword";

  if (!fast.confident) {
    // 关键词没命中，走 LLM 兜底分类
    intent = await classifyIntentByLlm(state.userRequest);
    source = "llm";
  }

  // 再经过 schema 校验，防御 LLM 返回非枚举值
  const safeIntent = TaskIntentSchema.parse(intent);

  return {
    taskIntent: safeIntent,
    debugTrace: [`[intent_node] intent=${safeIntent} via=${source}`],
  };
}
