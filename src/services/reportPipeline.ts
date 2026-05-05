import { reportGraph } from "../graph/reportGraph.js";
import {
  UserRequestSchema,
  type TaskPlan,
  type TemplateDistillation,
  type UserRequest,
  type WriterOutput,
} from "../schemas/index.js";

type ReportPipelineResult = {
  selectedSkillId?: string;
  taskIntent?: string;
  taskPlan?: TaskPlan;
  followUpQuestions?: string[];
  reviewNotes?: string[];
  outputTargets?: Array<"feishu_doc" | "bitable" | "slides">;
  report: WriterOutput;
  debugTrace?: string[];
  templateDistillation?: TemplateDistillation;
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

  return {
    selectedSkillId: state.taskPlan?.selectedSkillId,
    taskIntent: state.taskIntent ?? undefined,
    taskPlan: state.taskPlan ?? undefined,
    followUpQuestions:
      state.followUpQuestions.length > 0 ? state.followUpQuestions : undefined,
    reviewNotes: state.reviewNotes.length > 0 ? state.reviewNotes : undefined,
    outputTargets:
      request.outputTargets.length > 0 ? request.outputTargets : ["feishu_doc"],
    report: state.writerOutput,
    debugTrace: state.debugTrace.length > 0 ? state.debugTrace : undefined,
    templateDistillation: state.retrievalContext?.templateDistillation ?? undefined,
  };
}
