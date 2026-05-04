import type { Draft } from "../../schemas/agentContracts.js";
import { env } from "../../config/env.js";
import { logger } from "../../shared/logger.js";
import { toolGateway } from "../toolGateway/gateway.js";

export type PublishedArtifact = {
  type: "feishu_doc" | "bitable" | "slides";
  id: string;
  url: string;
  status: "mock_published";
};

function renderDraftAsPlainText(draft: Draft): string {
  const sectionText = draft.sections
    .map((section) => `${section.heading}\n${section.content}`)
    .join("\n\n");
  const chartText =
    draft.chartSuggestions.length > 0
      ? `\n\n图表建议:\n${draft.chartSuggestions
          .map((item) => `- ${item.title}(${item.type})：${item.purpose}，数据建议：${item.dataHint}`)
          .join("\n")}`
      : "";
  return `${draft.title}\n\n摘要：${draft.summary}\n\n${sectionText}${chartText}`.trim();
}

function renderSlidesOutline(draft: Draft): string {
  const sectionBullets = draft.sections
    .map((section) => `## ${section.heading}\n- ${section.content.replace(/\n+/g, "\n- ")}`)
    .join("\n\n");
  return `# ${draft.title}\n\n## 摘要\n- ${draft.summary}\n\n${sectionBullets}`.trim();
}

async function publishFeishuDoc(input: {
  draft: Draft;
  sessionId: string;
  index: number;
}): Promise<PublishedArtifact> {
  const content = renderDraftAsPlainText(input.draft);
  const doc = await toolGateway.createDocument({
    title: input.draft.title,
    content,
  });
  await toolGateway.updateDocument({
    documentId: doc.id,
    content,
  });

  if (env.FEISHU_DOC_PUBLISH_STRATEGY === "lark_cli_first") {
    try {
      await toolGateway.viewDocument(doc.id);
    } catch (error) {
      logger.warn("文档发布后 fetch 校验失败，已忽略并继续返回文档链接", {
        documentId: doc.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await toolGateway.addComment({
    documentId: doc.id,
    content: "由 Agent 自动生成，可在此处继续批注修改。",
  });
  return {
    type: "feishu_doc",
    id: doc.id,
    url: doc.url ?? `https://mock.feishu.local/feishu_doc/${input.sessionId}/${input.index + 1}`,
    status: "mock_published",
  };
}

async function publishSlides(input: {
  draft: Draft;
  sessionId: string;
  index: number;
}): Promise<PublishedArtifact> {
  const outline = renderSlidesOutline(input.draft);
  if (env.FEISHU_SLIDES_DELIVERY_LEVEL === "artifact_best_effort") {
    try {
      const slides = await toolGateway.createSlides({
        title: input.draft.title,
        outline,
      });
      return {
        type: "slides",
        id: slides.id,
        url: slides.url ?? `https://mock.feishu.local/slides/${input.sessionId}/${input.index + 1}`,
        status: "mock_published",
      };
    } catch (error) {
      logger.warn("Slides 实体发布失败，回退为 outline 交付", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    type: "slides",
    id: `slides_outline_${input.sessionId}_${input.index + 1}`,
    url: `https://mock.feishu.local/slides-outline/${input.sessionId}/${input.index + 1}`,
    status: "mock_published",
  };
}

export async function publishOutputs(input: {
  draft: Draft;
  outputTargets: Array<"feishu_doc" | "bitable" | "slides">;
  sessionId: string;
}): Promise<PublishedArtifact[]> {
  const artifacts: PublishedArtifact[] = [];

  for (const [idx, target] of input.outputTargets.entries()) {
    if (target === "feishu_doc") {
      const artifact = await publishFeishuDoc({
        draft: input.draft,
        sessionId: input.sessionId,
        index: idx,
      });
      artifacts.push(artifact);
      continue;
    }

    if (target === "slides") {
      artifacts.push(
        await publishSlides({
          draft: input.draft,
          sessionId: input.sessionId,
          index: idx,
        }),
      );
      continue;
    }

    artifacts.push({
      type: target,
      id: `${target}_${input.sessionId}_${idx + 1}`,
      url: `https://mock.feishu.local/${target}/${input.sessionId}/${idx + 1}`,
      status: "mock_published",
    });
  }

  return artifacts;
}
