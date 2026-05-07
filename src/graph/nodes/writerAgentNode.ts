import {
  buildWriterSourceEvidence,
  extractTemplateSectionsFromDetailedContext,
  writeDraft,
} from "../../services/agent/writerAgent.js";
import { publishPipelineProgress } from "../../services/progress/pipelineProgress.js";
import { WriterOutputSchema } from "../../schemas/index.js";
import { readStyleProfileSoft } from "../../services/hmrs/styleDistillationService.js";
import type { ReportGraphStateType } from "../state.js";

export async function writerAgentNode(
  state: ReportGraphStateType,
): Promise<Partial<ReportGraphStateType>> {
  if (!state.taskRequest || !state.executionPlan || !state.analysisResult || !state.skillMatch) {
    throw new Error("writer_agent 缺少前置状态");
  }

  const sourceEvidence = buildWriterSourceEvidence(state.detailedContext);
  const templateSections = extractTemplateSectionsFromDetailedContext(state.detailedContext);
  const preferredSections = state.blueprintPlan?.sectionBlueprint ?? state.executionPlan.targetSections;
  const targetCount = preferredSections.length;
  const templateTargetSections =
    templateSections.length >= 3
      ? [
          ...templateSections.slice(0, targetCount),
          ...preferredSections,
        ].slice(0, targetCount)
      : preferredSections;
  const planForWriter =
    templateTargetSections === preferredSections
      ? state.executionPlan
      : {
          ...state.executionPlan,
          targetSections: templateTargetSections,
        };
  const styleProfile = await readStyleProfileSoft({ userId: state.taskRequest.userRequest.userId });
  const styleHints: string[] = [];
  if (styleProfile) {
    if (styleProfile.toneTags.length > 0) {
      styleHints.push(
        `用户写作语气画像：${styleProfile.toneTags.slice(0, 5).join("、")}；尽量贴合，不要写成空泛套话。`,
      );
    }
    if (styleProfile.sentencePatterns.length > 0) {
      styleHints.push(
        `用户句式偏好：${styleProfile.sentencePatterns.slice(0, 5).join("；")}。`,
      );
    }
    if (styleProfile.commonTerms.length > 0) {
      styleHints.push(
        `用户常用术语（保留风味，但不要堆叠）：${styleProfile.commonTerms.slice(0, 8).join("、")}。`,
      );
    }
    if (styleProfile.forbiddenWords.length > 0) {
      styleHints.push(
        `用户避免使用的措辞：${styleProfile.forbiddenWords.slice(0, 8).join("、")}。`,
      );
    }
    if (styleProfile.anonymizedStyleSample) {
      styleHints.push(
        `用户匿名化文风样例（仅参考语感，禁止抄袭）：${styleProfile.anonymizedStyleSample.slice(0, 280)}`,
      );
    }
  }
  const rewriteHints = [
    ...(state.styleRewriteHints ?? []),
    ...(templateSections.length >= 3
      ? [
          `请优先遵循模板章节骨架：${templateSections.slice(0, 8).join(" / ")}`,
          "章节标题与顺序需尽量贴近模板，不要改写成通用空泛结构。",
        ]
      : []),
    ...(state.blueprintPlan?.templateGuardrails ?? []),
    ...styleHints,
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
      `[writer_agent] style_profile applied=${Boolean(styleProfile)} hints=${styleHints.length}`,
    ],
  };
}
