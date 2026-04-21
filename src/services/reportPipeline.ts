import { reportGraph } from "../graph/reportGraph.js";
import {
  UserRequestSchema,
  type ReviewReport,
  type TaskIntent,
  type TaskPlan,
  type UserMemory,
  type UserRequest,
  type WriterOutput,
} from "../schemas/index.js";

type ReportPipelineResult = {
  selectedSkillId?: string;
  taskIntent?: TaskIntent;
  taskPlan?: TaskPlan;
  followUpQuestions?: string[];
  reviewNotes?: string[];
  reviewReport?: ReviewReport;
  revisionCount?: number;
  outputTargets?: Array<"feishu_doc" | "bitable" | "slides">;
  report: WriterOutput;
  debugTrace?: string[];
  userMemorySnapshot?: UserMemory;
};

export async function generateReport(
  userRequest: UserRequest,
): Promise<WriterOutput> {
  const request = UserRequestSchema.parse(userRequest);
  const state = await reportGraph.invoke({
    userRequest: request,
  });

  if (!state.writerOutput) {
    throw new Error("报告生成失败：writerOutput 为空");
  }
  return state.writerOutput;
}

export async function runReportPipeline(
  userRequest: UserRequest,
): Promise<ReportPipelineResult> {
  const request = UserRequestSchema.parse(userRequest);
  const state = await reportGraph.invoke({
    userRequest: request,
  });

  if (!state.writerOutput) {
    throw new Error("报告生成失败：writerOutput 为空");
  }

  // selectedSkillId 的唯一事实源是检索阶段的 matchedSkill，
  // taskPlan.selectedSkillId 只是 plan 内部冗余字段，这里以 matchedSkill 为准。
  const selectedSkillId =
    state.retrievalContext?.matchedSkill.skillId ?? state.taskPlan?.selectedSkillId;

  return {
    selectedSkillId,
    taskIntent: state.taskIntent ?? undefined,
    taskPlan: state.taskPlan ?? undefined,
    followUpQuestions:
      state.followUpQuestions.length > 0 ? state.followUpQuestions : undefined,
    reviewNotes: state.reviewNotes.length > 0 ? state.reviewNotes : undefined,
    reviewReport: state.reviewReport ?? undefined,
    revisionCount: state.revisionCount,
    outputTargets:
      request.outputTargets.length > 0 ? request.outputTargets : ["feishu_doc"],
    report: state.writerOutput,
    debugTrace: state.debugTrace.length > 0 ? state.debugTrace : undefined,
    userMemorySnapshot: state.injectedMemorySnapshot ?? undefined,
  };
}
