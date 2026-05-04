import { reportGraph } from "../graph/reportGraph.js";
import { env } from "../config/env.js";
import { logger } from "../shared/logger.js";
import {
  UserRequestSchema,
  type TaskPlan,
  type UserRequest,
  type WriterOutput,
} from "../schemas/index.js";
import type {
  ComplianceReviewResult,
  ExecutionPlan,
  FinalDeliverable,
  IntentResult,
  MemoryUpdate,
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
  outputTargets?: Array<"feishu_doc" | "bitable" | "slides">;
  report: WriterOutput;
  debugTrace?: string[];
};

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
    outputTargets:
      request.outputTargets.length > 0 ? request.outputTargets : ["feishu_doc"],
    report: state.writerOutput,
    debugTrace: state.debugTrace.length > 0 ? state.debugTrace : undefined,
  };
  } finally {
    logger.info("report graph 结束", {
      sessionId: request.sessionId,
      ms: Date.now() - t0,
      ok,
    });
  }
}
