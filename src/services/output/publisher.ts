import type { Draft } from "../../schemas/agentContracts.js";
import { env } from "../../config/env.js";
import { logger } from "../../shared/logger.js";
import { toolGateway } from "../toolGateway/gateway.js";
import { getFeishuMvpConfig } from "../../integrations/feishu/feishuConfig.js";
import { listAllDocumentBlocks } from "../../integrations/feishu/docxBlocks.js";
import type { GatewayDocument } from "../toolGateway/types.js";
import type { RenderedArtifact } from "../render/artifactRenderer.js";
import { evaluateDraftForPublish } from "../hmrs/writeback/memoryWritebackService.js";

export type PublishedArtifact = {
  type: "feishu_doc" | "bitable" | "slides";
  id: string;
  url: string;
  status: "published" | "fallback" | "mock_published" | "quality_reject";
  artifactSource?: "mcp" | "lark_cli" | "openapi";
};

/** README §12.5 P2：发布链路结构化埋点（便于日志检索/对接观测） */
function logPublishTelemetry(payload: Record<string, unknown>): void {
  logger.info("[publish-telemetry]", payload);
}

function normalizeMultilineToBullets(text: string): string {
  return text
    .split(/\n+/g)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `- ${line}`)
    .join("\n");
}

function renderDraftAsTemplateMarkdown(draft: Draft, renderedArtifacts?: RenderedArtifact[]): string {
  const sections = draft.sections
    .map((section) => `## ${section.heading}\n${section.content}`)
    .join("\n\n");

  /**
   * 「已渲染为可视化对象」hint 必须以 publisher 实际持有的 renderedArtifacts.slotId 集合为开关，
   * 不能再用 chartSlot.status === "ready" 误判（章节升级和图片实际上传是两件事）。
   * 槽位 ready 但 ArtifactRenderer 失败时，回退到「待补充数据」清单，避免出现「假装已渲染」的占位行。
   */
  const renderedSlotIds = new Set((renderedArtifacts ?? []).map((a) => a.slotId));

  const chartRendered = draft.chartSlots.filter((s) => renderedSlotIds.has(s.slotId));
  const chartNotRendered = draft.chartSlots.filter((s) => !renderedSlotIds.has(s.slotId));
  const timelineRendered = draft.timelineSlots.filter((s) => renderedSlotIds.has(s.slotId));
  const timelineNotRendered = draft.timelineSlots.filter((s) => !renderedSlotIds.has(s.slotId));
  const ganttRendered = draft.ganttSlots.filter((s) => renderedSlotIds.has(s.slotId));
  const ganttNotRendered = draft.ganttSlots.filter((s) => !renderedSlotIds.has(s.slotId));

  const chartBlock = draft.chartSuggestions.length > 0
    ? [
        "## 图表建议",
        ...draft.chartSuggestions.map(
          (item) => `- ${item.title}（${item.type}）：${item.purpose}；数据建议：${item.dataHint}`,
        ),
      ].join("\n")
    : "";
  const readyChartHintBlock =
    chartRendered.length > 0
      ? [
          "## 图表（已渲染为可视化对象）",
          ...chartRendered.map(
            (slot) => `- ${slot.title}（${slot.chartType}）：实际图形将在文档下方插入`,
          ),
        ].join("\n")
      : "";
  const chartSlotBlock = chartNotRendered.length > 0
    ? [
        "## 图表槽位（待补充数据）",
        ...chartNotRendered.map(
          (slot) => `- ${slot.title}（${slot.chartType}）｜指标建议：${slot.metricHint}`,
        ),
      ].join("\n")
    : "";
  const openQuestions = draft.openQuestions.length > 0
    ? ["## 待确认事项", ...draft.openQuestions.map((item) => `- ${item}`)].join("\n")
    : "";
  const readyTimelineHintBlock =
    timelineRendered.length > 0
      ? [
          "## 时间线（已渲染为可视化对象）",
          ...timelineRendered.map((slot) => `- ${slot.title}：实际时间线将在文档下方插入`),
        ].join("\n")
      : "";
  const timelineBlock = timelineNotRendered.length > 0
    ? [
        "## 时间线（待补充数据）",
        ...timelineNotRendered.map(
          (slot) => `- ${slot.title}｜周期：${slot.periodHint}${slot.notes ? `｜说明：${slot.notes}` : ""}`,
        ),
      ].join("\n")
    : "";
  const readyGanttHintBlock =
    ganttRendered.length > 0
      ? [
          "## 甘特任务（已渲染为可视化对象）",
          ...ganttRendered.map((slot) => `- ${slot.task}：实际甘特图将在文档下方插入`),
        ].join("\n")
      : "";
  const ganttBlock = ganttNotRendered.length > 0
    ? [
        "## 甘特任务占位（待补充细节）",
        "| 任务 | 负责人 | 开始 | 结束 |",
        "|---|---|---|---|",
        ...ganttNotRendered.map(
          (slot) =>
            `| ${slot.task} | ${slot.ownerHint ?? "待定"} | ${slot.startHint ?? "待定"} | ${slot.endHint ?? "待定"} |`,
        ),
      ].join("\n")
    : "";
  return [
    `# ${draft.title}`,
    "## 摘要",
    normalizeMultilineToBullets(draft.summary || "待补充摘要"),
    sections,
    readyTimelineHintBlock,
    timelineBlock,
    readyGanttHintBlock,
    ganttBlock,
    chartBlock,
    readyChartHintBlock,
    chartSlotBlock,
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

function stripMarkdownNoise(s: string): string {
  return s.replace(/[#>*_\-\s]/g, "").trim();
}

/**
 * create/update 后 fetch-doc 抽样验收：长度 + 标题/摘要章节锚点（§12.5 P0）
 * 若 fetch 无 Markdown 字面量「##」但正文够长或章节标题文本已出现，视为写入成功；正文偏短时允许用待发 markdown 补足锚点校验。
 */
function verifyPublishedDocBody(
  fetched: GatewayDocument | null,
  draft: Draft,
  writtenMarkdown?: string,
): void {
  if (!fetched) {
    throw new Error("发布后 fetch-doc 返回空，疑似未完成写入");
  }
  const rawFetch = (fetched.content ?? "").trim();
  const written = writtenMarkdown?.trim() ?? "";
  const min = env.FEISHU_DOC_PUBLISH_VERIFY_MIN_CHARS;

  /**
   * 飞书 docx 经 MCP fetch 常为纯文本或块拼接，**不一定包含 Markdown 字面量「##」**；
   * 原逻辑误判为「未写入」。改为：无 ## 时，用章节标题文本是否出现在 fetch 正文、或纯文本长度是否足够来判定。
   */
  if (written.includes("##") && !rawFetch.includes("##")) {
    const headingFromMd = [...written.matchAll(/^##\s+(.+)$/gm)]
      .map((m) => (m[1] ?? "").trim())
      .filter(Boolean);
    const headingTexts = [
      ...headingFromMd.map((t) => stripMarkdownNoise(t)),
      ...draft.sections.map((s) => stripMarkdownNoise(s.heading)),
    ].filter((t) => t.length >= 2);
    const uniqueHints = [...new Set(headingTexts)].slice(0, 8);
    const anyHeadingInFetch = uniqueHints.some((h) => rawFetch.includes(h));
    const floorLen = Math.max(min, 80);
    const longEnoughPlain = rawFetch.length >= floorLen;
    if (anyHeadingInFetch || longEnoughPlain) {
      logPublishTelemetry({
        fetch_missing_markdown_hashes: true,
        mitigated_by: anyHeadingInFetch ? "heading_text_in_fetch" : "plain_body_length",
        documentId: fetched.id,
        fetchBodyLength: rawFetch.length,
      });
      logger.warn("fetch-doc 未含 ## 字面量（云文档常见），已由章节标题/正文长度推断写入成功", {
        documentId: fetched.id,
        fetchLength: rawFetch.length,
        anyHeadingInFetch,
      });
    } else {
      throw new Error(
        "发布后 fetch-doc 未检出章节（##），且正文过短或未匹配章节标题，疑似 update-doc 未写入正文",
      );
    }
  }
  let body = rawFetch;
  if (min > 0 && rawFetch.length < min) {
    if (written.length >= min && rawFetch.length > 0) {
      logPublishTelemetry({
        empty_doc_detected: true,
        mitigated_by: "written_markdown_length",
        documentId: fetched.id,
        fetchBodyLength: rawFetch.length,
      });
      logger.warn("MCP fetch-doc 正文偏短，使用待发 markdown 做后续锚点校验", {
        documentId: fetched.id,
        fetchLength: rawFetch.length,
      });
      body = written;
    } else {
      throw new Error(
        `发布后 fetch-doc 过短（${rawFetch.length} < ${min}），疑似空文档或尚未同步，可调大重试间隔或检查 update-doc`,
      );
    }
  }
  if (min > 0 && body.length < min) {
    throw new Error(`发布后用于验收的正文过短（${body.length} < ${min}）`);
  }
  const normalizedFetch = stripMarkdownNoise(body);
  const normalizedWritten = written ? stripMarkdownNoise(written) : "";
  const titleStripped = stripMarkdownNoise(draft.title);
  const titleHint = titleStripped.slice(0, Math.min(24, titleStripped.length));
  if (titleHint.length >= 4) {
    const inFetch = normalizedFetch.includes(titleHint);
    const inWritten = normalizedWritten.includes(titleHint);
    if (!inFetch && !inWritten) {
      throw new Error(`发布后正文中未检出报告标题关键字，验收失败`);
    }
    if (!inFetch && inWritten) {
      logPublishTelemetry({
        empty_doc_detected: true,
        mitigated_by: "title_in_written_markdown_only",
        documentId: fetched.id,
        titleHint,
      });
      logger.warn("fetch-doc 正文中未检出标题，但待发 markdown 已包含标题，验收放行（云上正文可能为块结构或未拉全）", {
        documentId: fetched.id,
        titleHint,
      });
    }
  }
  const normalizedForSummary = normalizedFetch.length >= min ? normalizedFetch : normalizedWritten;
  if (
    !body.includes("摘要") &&
    !normalizedForSummary.includes("摘要") &&
    !normalizedForSummary.includes(stripMarkdownNoise(draft.summary).slice(0, 16))
  ) {
    logger.warn("发布后抽样：未检出「摘要」或摘要正文片段，仍放行", { documentId: fetched.id });
  }
}

async function attachRenderedArtifactsToDocx(input: {
  documentId: string;
  artifacts: RenderedArtifact[];
  userId?: string;
  preferUserScope?: boolean;
}): Promise<{ inserted: number; skipped: number; failed: number }> {
  if (!input.artifacts.length) return { inserted: 0, skipped: 0, failed: 0 };
  let parentBlockId: string | undefined;
  try {
    const blocks = await listAllDocumentBlocks(getFeishuMvpConfig(), input.documentId);
    const pageBlock = blocks.find((b) => b.block_type === 1);
    parentBlockId = pageBlock?.block_id;
  } catch (error) {
    logger.warn("attach artifacts: list blocks failed", {
      documentId: input.documentId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (!parentBlockId) {
    return { inserted: 0, skipped: input.artifacts.length, failed: 0 };
  }
  const ctx = { userId: input.userId, preferUserScope: input.preferUserScope };
  let inserted = 0;
  let failed = 0;
  for (const artifact of input.artifacts) {
    try {
      if (artifact.kind === "image") {
        const result = await toolGateway.insertDocxImageBlock(
          {
            documentId: input.documentId,
            parentBlockId,
            mediaToken: artifact.embedToken,
            caption: artifact.caption,
          },
          ctx,
        );
        if (result.ok) {
          inserted += 1;
        } else {
          failed += 1;
          logger.warn("docx image block insert returned warning", {
            slotId: artifact.slotId,
            warning: result.warning,
          });
        }
        continue;
      }
      if (artifact.kind === "whiteboard" || artifact.kind === "sheet_chart") {
        const embedKind = artifact.kind === "whiteboard" ? "whiteboard" : "sheet";
        const result = await toolGateway.insertDocxEmbedBlock(
          {
            documentId: input.documentId,
            parentBlockId,
            embedKind,
            refToken: artifact.embedToken,
            caption: artifact.caption,
          },
          ctx,
        );
        if (result.ok) {
          inserted += 1;
        } else {
          failed += 1;
          logger.warn("docx embed block insert returned warning", {
            slotId: artifact.slotId,
            warning: result.warning,
          });
        }
      }
    } catch (error) {
      failed += 1;
      logger.warn("attach artifact failed", {
        slotId: artifact.slotId,
        kind: artifact.kind,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { inserted, skipped: 0, failed };
}

/**
 * 当 draft 命中污染语 / 内容过短时，把要发到飞书云盘的正文换成"质量未达标自检稿"，
 * 避免用户在云端文档看到一整篇围绕"docID 为空"的报错文字（且与模板毫无关系）。
 * 同时跳过 artifact 附加，避免在质量稿上插入图表造成误导。
 */
function renderQualityRejectMarkdown(draft: Draft, reasons: string[]): string {
  const reasonLines = reasons.slice(0, 8).map((r) => `- ${r}`).join("\n");
  return [
    `# ${draft.title}`,
    "## 自检结果：草稿质量未达标，已暂缓正文发布",
    "本次会话生成的初稿被质量门控拒绝，常见原因：",
    "- 检索到的云盘候选文档实际是过往失败日志/占位文本，未提供真实业务素材；",
    "- 用户提示中未指定具体项目/数据源，模型缺少可信事实；",
    "",
    "## 命中原因",
    reasonLines || "- （无）",
    "",
    "## 建议下一步",
    "- 在飞书 IM 直接发送 1～2 篇真实参考文档链接（@飞书 + 链接），让 Agent 重新做检索；",
    "- 或在提示中给出本周已完成事项 / 关键指标的列表，Agent 会据此填充章节；",
    "- 完成后再次触发，系统将基于新素材重写并尝试出图。",
    "",
    "## 原始任务",
    draft.summary || "（无）",
  ].join("\n");
}

async function publishFeishuDoc(input: {
  draft: Draft;
  sessionId: string;
  index: number;
  userId?: string;
  preferUserScope?: boolean;
  renderedArtifacts?: RenderedArtifact[];
}): Promise<PublishedArtifact> {
  // 发布门控：只检查是否有实质内容，不做污染词分析（污染词检查保留给 HMRS 回写）
  const verdict = evaluateDraftForPublish({ draft: input.draft });
  const isQualityReject = !verdict.pass;
  if (isQualityReject) {
    logger.warn("[publish-telemetry] draft quality gate rejected, publishing self-check note instead", {
      sessionId: input.sessionId,
      reasons: verdict.reasons.slice(0, 8),
    });
    logPublishTelemetry({
      publish_status: "quality_reject_note",
      output_type: "feishu_doc",
      sessionId: input.sessionId,
      reasons: verdict.reasons.slice(0, 8),
    });
  }
  const content = isQualityReject
    ? renderQualityRejectMarkdown(input.draft, verdict.reasons)
    : renderDraftAsTemplateMarkdown(input.draft, input.renderedArtifacts);
  const renderedArtifactsForAttach = isQualityReject ? [] : (input.renderedArtifacts ?? []);
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

  let viewed: GatewayDocument | null = null;
  try {
    viewed = await toolGateway.viewDocument(doc.id, {
      userId: input.userId,
      preferUserScope: input.preferUserScope,
    });
    verifyPublishedDocBody(viewed, input.draft, content);
  } catch (error) {
    logPublishTelemetry({
      publish_status: "verify_failed",
      output_type: "feishu_doc",
      adapter: doc.source,
      documentId: doc.id,
      sessionId: input.sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    logger.error("文档发布后抽样验收失败，将标记回退", {
      documentId: doc.id,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  if (renderedArtifactsForAttach.length > 0) {
    const attachStat = await attachRenderedArtifactsToDocx({
      documentId: doc.id,
      artifacts: renderedArtifactsForAttach,
      userId: input.userId,
      preferUserScope: input.preferUserScope,
    });
    logPublishTelemetry({
      publish_status: "artifact_attach",
      output_type: "feishu_doc",
      documentId: doc.id,
      inserted: attachStat.inserted,
      skipped: attachStat.skipped,
      failed: attachStat.failed,
      total: renderedArtifactsForAttach.length,
    });
  }
  await toolGateway.addComment({
    documentId: doc.id,
    content: "由 Agent 自动生成，可在此处继续批注修改。",
  }, {
    userId: input.userId,
    preferUserScope: input.preferUserScope,
  });
  const url = doc.url ?? `https://mock.feishu.local/feishu_doc/${input.sessionId}/${input.index + 1}`;
  const notifyBody = isQualityReject
    ? [
        "报告生成已暂缓（草稿质量未达标，已发布自检稿到云端供你查看原因）：",
        url,
        `命中原因：${verdict.reasons.slice(0, 4).join("；")}`,
        "建议：在群里 @ 我并附上 1～2 篇真实参考文档链接，或直接列出本周关键事项后重试。",
      ].join("\n")
    : [`报告文档已生成：${doc.title}`, url, summarizeDraftForNotify(input.draft)].join("\n");
  await notifyChatIfNeeded(notifyBody);
  logPublishTelemetry({
    publish_status: isQualityReject ? "quality_reject_published" : "published",
    output_type: "feishu_doc",
    adapter: doc.source ?? viewed?.source,
    documentId: doc.id,
    sessionId: input.sessionId,
    artifactCount: renderedArtifactsForAttach.length,
  });
  return {
    type: "feishu_doc",
    id: doc.id,
    url,
    // quality_reject 仍有真实 URL，不能混同 fallback（fallback 代表无 URL）
    status: isQualityReject ? "quality_reject" : "published",
    artifactSource: doc.source ?? viewed?.source,
  };
}

async function publishSlides(input: {
  draft: Draft;
  sessionId: string;
  index: number;
}): Promise<PublishedArtifact> {
  const outline = renderSlidesOutline(input.draft);
  let slidesFallbackReason: "outline_only" | "slides_best_effort_failed" = "outline_only";

  if (env.FEISHU_SLIDES_DELIVERY_LEVEL === "artifact_best_effort") {
    slidesFallbackReason = "slides_best_effort_failed";
    try {
      const slide = await toolGateway.createSlides({
        title: input.draft.title,
        outline,
      });
      const url = slide.url ?? `https://mock.feishu.local/slides/${input.sessionId}/${input.index + 1}`;
      await notifyChatIfNeeded(`演示稿已生成：${slide.title ?? input.draft.title}\n${url}`);
      logPublishTelemetry({
        publish_status: "published",
        output_type: "slides",
        adapter: slide.source,
        sessionId: input.sessionId,
        target_index: input.index,
      });
      return {
        type: "slides",
        id: slide.presentationId,
        url,
        status: "published",
        artifactSource: slide.source,
      };
    } catch (error) {
      logger.warn("Slides 实体发布失败，回退为 outline 交付", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  logPublishTelemetry({
    publish_status: "fallback",
    output_type: "slides",
    reason: slidesFallbackReason,
    sessionId: input.sessionId,
    target_index: input.index,
  });
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
  renderedArtifacts?: RenderedArtifact[];
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
            renderedArtifacts: input.renderedArtifacts,
          }),
        );
      } catch (error) {
        logPublishTelemetry({
          publish_status: "fallback",
          output_type: "feishu_doc",
          sessionId: input.sessionId,
          target_index: idx,
          error: error instanceof Error ? error.message : String(error),
        });
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

