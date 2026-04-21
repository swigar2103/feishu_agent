import { generateReviewReport } from "../../llm/orchestratorModel.js";
import {
  ReviewReportSchema,
  type ReviewIssue,
  type ReviewReport,
  type TaskPlan,
} from "../../schemas/index.js";
import type { ReportGraphStateType } from "../state.js";

/**
 * 规则层审阅：零成本、可预期。
 * 覆盖三类最基础的检查：
 *   - coverage: targetSections 是否都被 writerOutput.sections 覆盖
 *   - completeness: 是否存在未闭环的 openQuestions
 *   - data_quality: analystOutput.dataQualityNotes 是否被透传到正文（只要 notes 非空就提醒）
 */
function runRuleChecks(state: ReportGraphStateType): ReviewIssue[] {
  const issues: ReviewIssue[] = [];
  const writer = state.writerOutput;
  const plan = state.taskPlan;
  if (!writer || !plan) return issues;

  for (const target of plan.targetSections) {
    const covered = writer.sections.some((s) => s.heading.includes(target));
    if (!covered) {
      issues.push({
        type: "coverage",
        severity: "error",
        message: `缺少目标章节：${target}`,
        suggestion: `新增标题含有“${target}”的章节，并按 skill.sections 的顺序填入实质内容。`,
        targetSection: target,
      });
    }
  }

  if (writer.openQuestions.length > 0) {
    issues.push({
      type: "completeness",
      severity: "warning",
      message: `仍存在 ${writer.openQuestions.length} 条未回答的 openQuestions`,
      suggestion: "在正文中对已有信息做结论性表达，或在行动项里列明下一步负责人。",
    });
  }

  const dqNotes = state.analystOutput?.dataQualityNotes ?? [];
  if (dqNotes.length > 0) {
    issues.push({
      type: "data_quality",
      severity: "info",
      message: `Analyst 提示了 ${dqNotes.length} 条数据质量风险，请确认正文已提示读者注意。`,
      suggestion: dqNotes.join("；"),
    });
  }

  return issues;
}

/**
 * 规则层后处理：把数据本身缺失（而非 Writer 没写好）的 coverage error 降级为 data_quality warning。
 * 这是 LLM Reviewer prompt 的兜底——LLM 常常不听"数据缺失应降级"的指令，所以我们用确定性规则保底。
 *
 * 判定条件：issue.type === 'coverage' && issue.severity === 'error'
 *   且 issue.message 或 issue.suggestion 提到了 taskPlan.missingFields 里的任一字段
 *   → 降级为 warning + data_quality，并在 suggestion 前加上"需通过追问补数据"的提示
 */
function downgradeDataMissingErrors(
  issues: ReviewIssue[],
  taskPlan: TaskPlan,
): ReviewIssue[] {
  const missing = taskPlan.missingFields ?? [];
  if (missing.length === 0) return issues;

  return issues.map((issue) => {
    if (issue.type !== "coverage" || issue.severity !== "error") return issue;

    const haystack = `${issue.message} ${issue.suggestion ?? ""} ${issue.targetSection ?? ""}`;
    const hit = missing.find((f) => f && haystack.includes(f));
    if (!hit) return issue;

    const prefix = `[数据缺失-需追问] `;
    return {
      ...issue,
      type: "data_quality",
      severity: "warning",
      suggestion: (issue.suggestion ?? "").startsWith(prefix)
        ? issue.suggestion
        : `${prefix}${issue.suggestion ?? `需通过飞书 IM / 外部补充资料收集字段：${hit}`}`,
    };
  });
}

/**
 * 合并规则层与 LLM 层：
 * - 以 LLM 的 overallScore 和 summary 为主
 * - issues 取两者并集（用 message 去重）
 * - pass 取两者的合取：任一方为 false 则 false
 */
function mergeReviewReports(
  ruleIssues: ReviewIssue[],
  llmReport: ReviewReport,
  taskPlan: TaskPlan,
): ReviewReport {
  const seen = new Set<string>();
  const merged: ReviewIssue[] = [];
  for (const iss of [...ruleIssues, ...llmReport.issues]) {
    const key = `${iss.type}::${iss.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(iss);
  }

  const downgraded = downgradeDataMissingErrors(merged, taskPlan);

  const hasError = downgraded.some((i) => i.severity === "error");
  const pass = !hasError;

  return ReviewReportSchema.parse({
    pass,
    overallScore: hasError ? Math.min(llmReport.overallScore, 0.5) : Math.max(llmReport.overallScore, 0.7),
    issues: downgraded,
    summary:
      llmReport.summary ||
      (pass ? "审阅通过（数据缺失类问题已转为待补字段，不阻断发布）。" : "发现需要改写的问题，请参考 issues。"),
  });
}

export async function reviewerNode(
  state: ReportGraphStateType,
): Promise<Partial<ReportGraphStateType>> {
  if (!state.writerOutput || !state.taskPlan || !state.retrievalContext) {
    throw new Error("reviewer_node 缺少 writerOutput/taskPlan/retrievalContext");
  }

  const ruleIssues = runRuleChecks(state);

  // 用户在 Phase 2 选了 "always"：无论规则层结果如何都过一次 LLM 审阅
  const llmReport = await generateReviewReport({
    writerOutput: state.writerOutput,
    taskPlan: state.taskPlan,
    retrievalContext: state.retrievalContext,
    analystOutput: state.analystOutput,
  });

  const reviewReport = mergeReviewReports(ruleIssues, llmReport, state.taskPlan);

  const errorCount = reviewReport.issues.filter((i) => i.severity === "error").length;
  const warningCount = reviewReport.issues.filter((i) => i.severity === "warning").length;

  // 向 reviewNotes 汇总一份人类可读的摘要（保持原来的输出字段兼容）
  const reviewNotes = reviewReport.issues.map(
    (i) => `[${i.severity}:${i.type}] ${i.message}${i.suggestion ? `｜建议：${i.suggestion}` : ""}`,
  );

  return {
    reviewReport,
    reviewNotes,
    debugTrace: [
      `[reviewer_node] pass=${reviewReport.pass} score=${reviewReport.overallScore.toFixed(2)} errors=${errorCount} warnings=${warningCount}`,
    ],
  };
}
