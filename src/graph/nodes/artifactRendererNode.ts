import { renderDraftArtifacts } from "../../services/render/artifactRenderer.js";
import { publishPipelineProgress } from "../../services/progress/pipelineProgress.js";
import type { ReportGraphStateType } from "../state.js";

export async function artifactRendererNode(
  state: ReportGraphStateType,
): Promise<Partial<ReportGraphStateType>> {
  if (!state.taskRequest || !state.draft) {
    return {
      renderedArtifacts: [],
      debugTrace: ["[artifact_renderer] skipped: missing taskRequest/draft"],
    };
  }
  const userId = state.taskRequest.userRequest.userId;
  const sourceLinks = [
    ...new Set(
      (state.detailedContext?.sourceDetails ?? [])
        .flatMap((item) => {
          const hits = item.detail.match(/https?:\/\/[^\s)\]）】]+/g);
          return hits ?? [];
        })
        .map((url) => url.trim())
        .filter(Boolean),
    ),
  ];
  const startedAt = Date.now();
  try {
    const result = await renderDraftArtifacts({
      userId,
      draft: state.draft,
      sourceLinks,
    });
    publishPipelineProgress({
      sessionId: state.taskRequest.userRequest.sessionId,
      stage: "artifact_renderer",
      message: "可视化产物渲染完成",
      meta: {
        artifactCount: result.artifacts.length,
        warningCount: result.warnings.length,
        elapsedMs: Date.now() - startedAt,
      },
    });
    return {
      renderedArtifacts: result.artifacts,
      debugTrace: [
        `[artifact_renderer] artifacts=${result.artifacts.length} warnings=${result.warnings.length} elapsed=${Date.now() - startedAt}ms`,
        ...result.warnings.map((w) => `[artifact_renderer:warn] ${w}`),
      ],
    };
  } catch (error) {
    return {
      renderedArtifacts: [],
      debugTrace: [
        `[artifact_renderer:error] ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
}
