import type { Draft } from "../../schemas/agentContracts.js";
import { env } from "../../config/env.js";
import { logger } from "../../shared/logger.js";
import { toolGateway } from "../toolGateway/gateway.js";
import { getFeishuMvpConfig } from "../../integrations/feishu/feishuConfig.js";
import type { GatewayDocument } from "../toolGateway/types.js";

export type PublishedArtifact = {
  type: "feishu_doc" | "bitable" | "slides";
  id: string;
  url: string;
  status: "published" | "fallback" | "mock_published";
};

function normalizeMultilineToBullets(text: string): string {
  return text
    .split(/\n+/g)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `- ${line}`)
    .join("\n");
}

function renderDraftAsTemplateMarkdown(draft: Draft): string {
  const sections = draft.sections
    .map((section) => `## ${section.heading}\n${section.content}`)
    .join("\n\n");
  const chartBlock = draft.chartSuggestions.length > 0
    ? [
        "## 图表建议",
        ...draft.chartSuggestions.map(
          (item) => `- ${item.title}（${item.type}）：${item.purpose}；数据建议：${item.dataHint}`,
        ),
      ].join("\n")
    : "";
  const openQuestions = draft.openQuestions.length > 0
    ? ["## 待确认事项", ...draft.openQuestions.map((item) => `- ${item}`)].join("\n")
    : "";
  return [
    `# ${draft.title}`,
    "## 摘要",
    normalizeMultilineToBullets(draft.summary || "待补充摘要"),
    sections,
    chartBlock,
    openQuestions,
  ]
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function renderSlidesOutline(draft: Draft): string {
  const sectionBullets = draft.sections
    .map((section) => `## ${section.heading}\n- ${section.content.replace(/\n+/g, "\n- ")}`)
    .join("\n\n");
  const chartSlides =
    draft.chartSuggestions.length > 0
      ? `\n\n## 图表页建议\n${draft.chartSuggestions
          .map((item) => `- ${item.title}（${item.type}）：${item.purpose}；数据：${item.dataHint}`)
          .join("\n")}`
      : "";
  return `# ${draft.title}\n\n## 摘要\n- ${draft.summary}\n\n${sectionBullets}${chartSlides}`.trim();
}

async function notifyChatIfNeeded(text: string): Promise<void> {
  const notifyChatId = getFeishuMvpConfig().imNotifyChatId;
  if (!notifyChatId) return;
  await toolGateway
    .sendMessage({
      chatId: notifyChatId,
      content: text,
      msgType: "text",
    })
    .catch(() => false);
}

function summarizeDraftForNotify(draft: Draft): string {
  const sectionBullets = draft.sections
    .slice(0, 3)
    .map((section) => `- ${section.heading}`)
    .join("\n");
  return [`摘要：${draft.summary}`, sectionBullets].filter(Boolean).join("\n");
}

function validatePublishedDoc(doc: GatewayDocument): void {
  const missing: string[] = [];
  if (!doc.id?.trim()) missing.push("id");
  if (!doc.title?.trim()) missing.push("title");
  if (!doc.url?.trim()) missing.push("url");
  if (missing.length > 0) {
    throw new Error(`文档发布验收失败，缺少字段: ${missing.join(",")}`);
  }
}

async function publishFeishuDoc(input: {
  draft: Draft;
  sessionId: string;
  index: number;
  userId?: string;
  preferUserScope?: boolean;
}): Promise<PublishedArtifact> {
  const content = renderDraftAsTemplateMarkdown(input.draft);
  const doc = await toolGateway.createDocument({
    title: input.draft.title,
    content,
    userId: input.userId,
    preferUserScope: input.preferUserScope,
  }, {
    userId: input.userId,
    preferUserScope: input.preferUserScope,
  });
  validatePublishedDoc(doc);
  const updated = await toolGateway.updateDocument({
    documentId: doc.id,
    content,
  }, {
    userId: input.userId,
    preferUserScope: input.preferUserScope,
  });
  if (!updated) {
    throw new Error(`文档内容更新失败: ${doc.id}`);
  }

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
  }, {
    userId: input.userId,
    preferUserScope: input.preferUserScope,
  });
  const url = doc.url ?? `https://mock.feishu.local/feishu_doc/${input.sessionId}/${input.index + 1}`;
  await notifyChatIfNeeded(
    [`报告文档已生成：${doc.title}`, url, summarizeDraftForNotify(input.draft)].join("\n"),
  );
  return {
    type: "feishu_doc",
    id: doc.id,
    url,
    status: "published",
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
      const slide = await toolGateway.createSlides({
        title: input.draft.title,
        outline,
      });
      const url = slide.url ?? `https://mock.feishu.local/slides/${input.sessionId}/${input.index + 1}`;
      await notifyChatIfNeeded(`演示稿已生成：${slide.title ?? input.draft.title}\n${url}`);
      return {
        type: "slides",
        id: slide.presentationId,
        url,
        status: "published",
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
    status: "fallback",
  };
}

export async function publishOutputs(input: {
  draft: Draft;
  outputTargets: Array<"feishu_doc" | "bitable" | "slides">;
  sessionId: string;
  userId?: string;
  preferUserScope?: boolean;
}): Promise<PublishedArtifact[]> {
  const artifacts: PublishedArtifact[] = [];

  for (const [idx, target] of input.outputTargets.entries()) {
    if (target === "feishu_doc") {
      try {
        artifacts.push(
          await publishFeishuDoc({
            draft: input.draft,
            sessionId: input.sessionId,
            index: idx,
            userId: input.userId,
            preferUserScope: input.preferUserScope,
          }),
        );
      } catch (error) {
        logger.warn("文档正式产物发布失败，回退为摘要链接占位", {
          error: error instanceof Error ? error.message : String(error),
        });
        artifacts.push({
          type: "feishu_doc",
          id: `feishu_doc_fallback_${input.sessionId}_${idx + 1}`,
          url: `https://mock.feishu.local/feishu_doc-fallback/${input.sessionId}/${idx + 1}`,
          status: "fallback",
        });
        await notifyChatIfNeeded(
          [
            `文档发布失败，已回退摘要：${input.draft.title}`,
            summarizeDraftForNotify(input.draft),
          ].join("\n"),
        );
      }
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

