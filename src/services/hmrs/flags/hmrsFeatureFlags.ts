import { env } from "../../../config/env.js";
import type { UserRequest } from "../../../schemas/index.js";

function normalizeTaskType(request: UserRequest): string {
  const reportType = request.reportType?.trim().toLowerCase() ?? "";
  const prompt = request.prompt.toLowerCase();
  if (reportType.includes("周报") || prompt.includes("周报") || prompt.includes("weekly")) {
    return "weekly_report";
  }
  if (reportType.includes("会议") || prompt.includes("会议纪要") || prompt.includes("meeting")) {
    return "meeting_summary";
  }
  if (reportType.includes("项目") || prompt.includes("项目报告") || prompt.includes("模板")) {
    return "templated_doc";
  }
  return reportType || "generic";
}

export function shouldUseHmrs(request: UserRequest): boolean {
  if (!env.HMRS_ENABLED) return false;
  const type = normalizeTaskType(request);
  const set = new Set(
    env.HMRS_ROLLOUT_TASK_TYPES
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
  if (set.size === 0) return false;
  return set.has(type);
}

export function readHmrsTaskType(request: UserRequest): string {
  return normalizeTaskType(request);
}
