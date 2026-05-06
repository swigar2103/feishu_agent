import {
  buildWriterSourceEvidence,
  extractTemplateSectionsFromDetailedContext,
  writeDraft,
} from "../../services/agent/writerAgent.js";
import { publishPipelineProgress } from "../../services/progress/pipelineProgress.js";
import { WriterOutputSchema } from "../../schemas/index.js";
import type { ReportGraphStateType } from "../state.js";

export async function writerAgentNode(
  state: ReportGraphStateType,
): Promise<Partial<ReportGraphStateType>> {
  if (!state.taskRequest || !state.executionPlan || !state.analysisResult || !state.skillMatch) {
    throw new Error("writer_agent 缺少前置状态");
  }

  const sourceEvidence = buildWriterSourceEvidence(state.detailedContext);
  const templateSections = extractTemplateSectionsFromDetailedContext(state.detailedContext);
  const targetCount = state.executionPlan.targetSections.length;
  const templateTargetSections =
    templateSections.length >= 3
      ? [
          ...templateSections.slice(0, targetCount),
          ...state.executionPlan.targetSections,
        ].slice(0, targetCount)
      : state.executionPlan.targetSections;
  const planForWriter =
    templateTargetSections === state.executionPlan.targetSections
      ? state.executionPlan
      : {
          ...state.executionPlan,
          targetSections: templateTargetSections,
        };
  const rewriteHints = [
    ...(state.styleRewriteHints ?? []),
    ...(templateSections.length >= 3
      ? [
          `请优先遵循模板章节骨架：${templateSections.slice(0, 8).join(" / ")}`,
          "章节标题与顺序需尽量贴近模板，不要改写成通用空泛结构。",
        ]
      : []),
  ];

  const draft = await writeDraft({
    userRequest: state.taskRequest.userRequest,
    plan: planForWriter,
    analysis: state.analysisResult,
    skillMatch: state.skillMatch,
    rewriteHints,
    sourceEvidence: sourceEvidence || undefined,
  });
  publishPipelineProgress({
    sessionId: state.taskRequest.userRequest.sessionId,
    stage: "writer",
    message: "初稿写作完成",
    meta: {
      title: draft.title,
      sectionCount: draft.sections.length,
      templateSectionsDetected: templateSections.length,
    },
  });

  return {
    draft,
    writerOutput: WriterOutputSchema.parse(draft),
    debugTrace: [
      `[writer_agent] draft title=${draft.title} templateSections=${templateSections.length}`,
    ],
  };
}
