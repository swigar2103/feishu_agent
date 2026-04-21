import { generateWriterOutput } from "../../llm/writerModel.js";
import type { ReportGraphStateType } from "../state.js";

export async function writerNode(
  state: ReportGraphStateType,
): Promise<Partial<ReportGraphStateType>> {
  if (!state.writerInput) {
    throw new Error("writer_node 缺少 writerInput");
  }

  // 是否处于"改写模式"：reviewer 已经跑过且打了不通过 + 还有 issues
  const isRevision =
    Boolean(state.reviewReport) &&
    !state.reviewReport!.pass &&
    state.reviewReport!.issues.length > 0;

  const revisionHints = isRevision
    ? {
        previousDraft: state.writerOutput ?? null,
        issues: state.reviewReport!.issues,
      }
    : undefined;

  const writerOutput = await generateWriterOutput(state.writerInput, revisionHints);

  const nextRevisionCount = isRevision ? state.revisionCount + 1 : state.revisionCount;

  return {
    writerOutput,
    revisionCount: nextRevisionCount,
    debugTrace: [
      isRevision
        ? `[writer_node] revision=${nextRevisionCount} title=${writerOutput.title} (addressed ${state.reviewReport!.issues.length} issues)`
        : `[writer_node] report generated title=${writerOutput.title}`,
    ],
  };
}
