import { reportGraph } from "../graph/reportGraph.js";
import { env } from "../config/env.js";
import { logger } from "../shared/logger.js";
import {
  UserRequestSchema,
  type TaskPlan,
  type TemplateDistillation,
  type UserRequest,
  type WriterOutput,
} from "../schemas/index.js";
import type {
  ComplianceReviewResult,
  ExecutionPlan,
  FinalDeliverable,
  IntentResult,
  MemoryUpdate,
  QualityBaseline,
  ResourcePoolChange,
  SkillMatch,
  StyleReviewResult,
} from "../schemas/agentContracts.js";

function withReportPipelineTimeout<T>(sessionId: string, promise: Promise<T>): Promise<T> {
  const ms = env.REPORT_PIPELINE_TIMEOUT_MS;
  if (ms <= 0) {
    logger.warn("REPORT_PIPELINE_TIMEOUT_MS 为 0，整段报告管线不设总超时", { sessionId });
    return promise;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `报告生成总超时（${Math.round(ms / 1000)}s）。可调大 REPORT_PIPELINE_TIMEOUT_MS，或检查百炼网络。`,
        ),
      );
    }, ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

type ReportPipelineResult = {
  selectedSkillId?: string;
  taskIntent?: string;
  intent?: IntentResult;
  skillMatch?: SkillMatch;
  executionPlan?: ExecutionPlan;
  taskPlan?: TaskPlan;
  followUpQuestions?: string[];
  styleReview?: StyleReviewResult;
  complianceReview?: ComplianceReviewResult;
  reviewNotes?: string[];
  finalDeliverable?: FinalDeliverable;
  memoryUpdate?: MemoryUpdate;
  resourcePoolChange?: ResourcePoolChange;
  qualityBaseline?: QualityBaseline;
  outputTargets?: Array<"feishu_doc" | "bitable" | "slides">;
  report: WriterOutput;
  debugTrace?: string[];
  templateDistillation?: TemplateDistillation;
};

function computeQualityBaseline(input: {
  report: WriterOutput;
  executionPlan?: ExecutionPlan;
  skillMatch?: SkillMatch;
  finalDeliverable?: FinalDeliverable;
}): QualityBaseline {
  const targetSections = input.executionPlan?.targetSections ?? [];
  const reportSections = input.report.sections ?? [];
  const covered = targetSections.filter((target) =>
    reportSections.some((sec) => sec.heading.trim() === target.trim()),
  ).length;
  const sectionCoverage = targetSections.length > 0 ? covered / targetSections.length : 0.5;

  const workflowSections =
    input.skillMatch?.workflowMeta?.workflowTemplateId && targetSections.length > 0
      ? targetSections
      : input.skillMatch?.selectedSkill.sections ?? [];
  const matchedStructure = workflowSections.filter((target) =>
    reportSections.some((sec) => sec.heading.trim() === target.trim()),
  ).length;
  const templateStructureCoverage =
    workflowSections.length > 0 ? matchedStructure / workflowSections.length : sectionCoverage;

  const joined = reportSections.map((s) => `${s.heading}\n${s.content}`).join("\n");
  const bulletHits = (joined.match(/(^|\n)\s*[-*]\s+/g) ?? []).length;
  const tableHits = (joined.match(/\|.+\|/g) ?? []).length;
  const timelineHits = (joined.match(/时间线|timeline|里程碑/gi) ?? []).length;
  const ganttHits = (joined.match(/甘特|gantt/gi) ?? []).length;
  const chartHits = (input.report.chartSuggestions ?? []).length;

  const publishedCount = input.finalDeliverable?.publishedArtifacts?.filter(
    (a) => a.status === "published",
  ).length ?? 0;
  const artifactReadinessScore = Math.min(
    1,
    sectionCoverage * 0.35 +
      templateStructureCoverage * 0.35 +
      Math.min(1, chartHits > 0 ? 0.2 : 0) +
      Math.min(1, publishedCount > 0 ? 0.1 : 0),
  );

  const notes: string[] = [];
  if (sectionCoverage < 0.7) notes.push("章节覆盖偏低：目标小节未完全命中。");
  if (templateStructureCoverage < 0.7) notes.push("模板结构贴合度偏低：建议加强 sectionSchema 约束。");
  if (chartHits === 0) notes.push("未生成图表槽位：建议补充 chartSlots/图表建议。");

  return {
    source: "heuristic_v1",
    sectionCoverage: Number(sectionCoverage.toFixed(4)),
    templateStructureCoverage: Number(templateStructureCoverage.toFixed(4)),
    artifactReadinessScore: Number(artifactReadinessScore.toFixed(4)),
    templateElementHits: {
      chart: chartHits,
      timeline: timelineHits,
      gantt: ganttHits,
      table: tableHits,
      bulletList: bulletHits,
    },
    notes,
  };
}

function graphInvokeOptions() {
  return { recursionLimit: env.REPORT_GRAPH_RECURSION_LIMIT };
}

export async function generateReport(
  userRequest: UserRequest,
): Promise<WriterOutput> {
  const request = UserRequestSchema.parse(userRequest);
  const t0 = Date.now();
  logger.info("report graph 开始", { sessionId: request.sessionId });
  let ok = false;
  try {
    const state = await withReportPipelineTimeout(
      request.sessionId,
      reportGraph.invoke({ userRequest: request }, graphInvokeOptions()),
    );

    if (!state.writerOutput) {
      throw new Error("报告生成失败：writerOutput 为空");
    }
    ok = true;
    return state.writerOutput;
  } finally {
    logger.info("report graph 结束", {
      sessionId: request.sessionId,
      ms: Date.now() - t0,
      ok,
    });
  }
}

export async function runReportPipeline(
  userRequest: UserRequest,
): Promise<ReportPipelineResult> {
  const request = UserRequestSchema.parse(userRequest);
  const t0 = Date.now();
  logger.info("report graph 开始", { sessionId: request.sessionId });
  let ok = false;
  try {
    const state = await withReportPipelineTimeout(
      request.sessionId,
      reportGraph.invoke({ userRequest: request }, graphInvokeOptions()),
    );

    if (!state.writerOutput || !state.executionPlan) {
      throw new Error("报告生成失败：缺少核心输出");
    }
    ok = true;

    const qualityBaseline = computeQualityBaseline({
      report: state.writerOutput,
      executionPlan: state.executionPlan ?? undefined,
      skillMatch: state.skillMatch ?? undefined,
      finalDeliverable: state.finalDeliverable ?? undefined,
    });

    return {
    selectedSkillId: state.executionPlan.selectedSkillId,
    taskIntent: state.intentResult?.taskIntent ?? state.taskIntent ?? undefined,
    intent: state.intentResult ?? undefined,
    skillMatch: state.skillMatch ?? undefined,
    executionPlan: state.executionPlan ?? undefined,
    taskPlan: state.taskPlan ?? undefined,
    followUpQuestions:
      state.executionPlan.followUpQuestions.length > 0
        ? state.executionPlan.followUpQuestions
        : undefined,
    styleReview: state.styleReviewResult ?? undefined,
    complianceReview: state.complianceReviewResult ?? undefined,
    reviewNotes: state.complianceReviewResult?.issues?.length
      ? state.complianceReviewResult.issues
      : state.styleReviewResult?.issues?.length
        ? state.styleReviewResult.issues
        : undefined,
    finalDeliverable: state.finalDeliverable ?? undefined,
    memoryUpdate: state.memoryUpdate ?? undefined,
    resourcePoolChange: state.resourcePoolChange ?? undefined,
    qualityBaseline,
    outputTargets:
      request.outputTargets.length > 0 ? request.outputTargets : ["feishu_doc"],
    report: state.writerOutput,
    debugTrace: state.debugTrace.length > 0 ? state.debugTrace : undefined,
    templateDistillation: state.retrievalContext?.templateDistillation ?? undefined,
  };
  } finally {
    logger.info("report graph 结束", {
      sessionId: request.sessionId,
      ms: Date.now() - t0,
      ok,
    });
  }
}
