import { reviewStyle } from "../../services/agent/styleReviewer.js";
import type { ReportGraphStateType } from "../state.js";

const MAX_STYLE_REWRITE = 2;

export async function styleReviewerNode(
  state: ReportGraphStateType,
): Promise<Partial<ReportGraphStateType>> {
  if (!state.draft || !state.taskRequest) {
    throw new Error("style_reviewer 缺少 draft/taskRequest");
  }

  const result = await reviewStyle({
    draft: state.draft,
    preferredTone: state.executionPlan?.targetTone,
    styleNotes: state.skillMatch?.selectedSkill.styleRules ?? [],
  });

  const loop = state.styleReviewLoopCount + 1;
  const shouldRewrite = !result.pass && loop <= MAX_STYLE_REWRITE;

  return {
    styleReviewResult: result,
    styleReviewLoopCount: loop,
    callbackRoute: shouldRewrite ? "to_writer" : "to_compliance",
    styleRewriteHints: shouldRewrite ? result.suggestions : [],
    debugTrace: [
      `[style_reviewer] pass=${result.pass} loop=${loop} rewrite=${shouldRewrite} route=${shouldRewrite ? "to_writer" : "to_compliance"}`,
    ],
  };
}
