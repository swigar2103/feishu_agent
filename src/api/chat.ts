import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { UserRequestSchema, type UserRequest } from "../schemas/index.js";
import type { ResourceSummary } from "../schemas/agentContracts.js";
import type { WriterOutput } from "../schemas/index.js";
import { runReportPipeline } from "../services/reportPipeline.js";
import { ResourcePoolManager } from "../services/resourcePool/poolManager.js";
import {
  appendChatMessage,
  createChatSession,
  deleteChatSession,
  loadChatSession,
  listChatSessionsForUser,
  setLatestReport,
} from "../services/chat/sessionStore.js";
import { GenerateReportResponseSchema } from "../types/contracts.js";

const poolManager = new ResourcePoolManager();

const CreateSessionBodySchema = z.object({
  userId: z.string().min(1),
  industry: z.string().optional(),
  reportType: z.string().optional(),
});

/** 前端从对话消息选区生成的 Cursor 式上下文（非仓库文件，仅聊天路径） */
export const ChatSelectionContextSchema = z
  .object({
    source: z.literal("chat"),
    pseudoPath: z.string().min(1),
    language: z.string().min(1),
    lineStart: z.number().int().min(1),
    lineEnd: z.number().int().min(1),
    snippet: z.string().min(1).max(12_000),
    role: z.enum(["user", "assistant"]).optional(),
    messageIndex: z.number().int().nonnegative().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.lineEnd < data.lineStart) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "lineEnd 不能小于 lineStart",
        path: ["lineEnd"],
      });
    }
  });

export type ChatSelectionContext = z.infer<typeof ChatSelectionContextSchema>;

const SendMessageBodySchema = z
  .object({
    content: z.string().default(""),
    mentionedResourceIds: z.array(z.string()).optional().default([]),
    revisionMode: z.enum(["full", "incremental"]),
    selectionContexts: z.array(ChatSelectionContextSchema).optional().default([]),
  })
  .superRefine((data, ctx) => {
    if (!data.content.trim() && data.selectionContexts.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "需要输入文本或至少添加一条对话引用",
      });
    }
  });

/** 将选区编译为 extraContext 中的独立块，供 Agent 整段读取 */
function compileChatSelectionContextsToExtraContext(
  contexts: ChatSelectionContext[],
): string[] {
  if (contexts.length === 0) return [];
  const parts: string[] = [
    [
      "## 对话区引用（类似 Cursor Add to Chat）",
      "用户从当前会话气泡中选中的片段：含逻辑路径、行号、语言与原文。请优先基于这些片段理解意图、回答追问或对照修改；若与用户输入冲突，以用户本次输入为准。",
      "",
    ].join("\n"),
  ];
  contexts.forEach((c, i) => {
    const fenceLang =
      c.language && !["text", "markdown", "plaintext"].includes(c.language.toLowerCase())
        ? c.language
        : "";
    parts.push(
      [
        `### 引用 ${i + 1} · ${c.pseudoPath}`,
        `- 行号: L${c.lineStart}–L${c.lineEnd}${c.role ? ` · 消息角色: ${c.role}` : ""} · language: ${c.language}`,
        "```" + fenceLang,
        c.snippet,
        "```",
        "",
      ].join("\n"),
    );
  });
  return [parts.join("\n")];
}

/** 将选区并入主 prompt，避免仅靠 extraContext 时短指令被守卫拒绝或上层模型忽略 */
function buildSelectionInlineForPrompt(contexts: ChatSelectionContext[]): string {
  if (contexts.length === 0) return "";
  const maxPer = 2_500;
  const blocks = contexts.map((c, i) => {
    const clip =
      c.snippet.length > maxPer ? `${c.snippet.slice(0, maxPer)}\n…（片段过长已截断，完整内容见 extraContext）` : c.snippet;
    return [
      `### 选区 ${i + 1} · ${c.pseudoPath}`,
      `行号 L${c.lineStart}–L${c.lineEnd} · language: ${c.language}${c.role ? ` · 角色: ${c.role}` : ""}`,
      "```text",
      clip,
      "```",
    ].join("\n");
  });
  return [
    "",
    "【对话区选区 · 须在本次修订中落实】以下与 extraContext 中「对话区引用」一致；若与上文用户一句式意见同时存在，以选区与意见共同为准。",
    "",
    ...blocks,
    "",
  ].join("\n");
}

function summarizeReceivedSelections(contexts: ChatSelectionContext[]) {
  return contexts.map((c) => ({
    pseudoPath: c.pseudoPath,
    lineStart: c.lineStart,
    lineEnd: c.lineEnd,
    language: c.language,
    snippetLength: c.snippet.length,
  }));
}

export function writerOutputToMarkdown(report: WriterOutput): string {
  const lines = [
    `# ${report.title}`,
    "",
    report.summary,
    "",
    ...report.sections.flatMap((s) => [`## ${s.heading}`, "", s.content, ""]),
  ];
  return lines.join("\n").trim();
}

async function loadResourcePoolSnapshot(userId: string): Promise<ResourceSummary[]> {
  const base = UserRequestSchema.parse({
    userId,
    sessionId: "pool_snapshot",
    prompt: "pool_snapshot",
    mentionedResourceIds: [],
  });
  return poolManager.buildResourcePool(base);
}

function filterValidMentions(ids: string[], pool: ResourceSummary[]): string[] {
  const allowed = new Set(pool.map((r) => r.resourceId));
  return ids.filter((id) => allowed.has(id));
}

function buildUserRequestForTurn(input: {
  session: {
    sessionId: string;
    userId: string;
    industry?: string;
    reportType?: string;
    messages: { role: string; content: string }[];
    latestReport?: WriterOutput;
  };
  content: string;
  revisionMode: "full" | "incremental";
  mentionedResourceIds: string[];
  selectionContexts: ChatSelectionContext[];
}): UserRequest {
  const { session, content, revisionMode, mentionedResourceIds, selectionContexts } = input;
  const industry = session.industry ?? "通用";
  const reportType = session.reportType ?? "分析报告";

  const selectionExtra = compileChatSelectionContextsToExtraContext(selectionContexts);
  const userInstruction =
    content.trim() ||
    (selectionContexts.length > 0 ? "（未额外输入说明；请主要依据下方「对话区引用」作答或修改。）" : "");

  const historyBrief =
    session.messages.length > 0
      ? session.messages
          .slice(-8)
          .map((m) => `${m.role}:${m.content.slice(0, 280)}`)
          .join("\n")
      : "";

  if (revisionMode === "incremental" && session.latestReport) {
    const artifact = JSON.stringify(session.latestReport);
    const selectionInline = buildSelectionInlineForPrompt(selectionContexts);
    const prompt = [
      "【同一会话 · 增量修订】请在上一次生成的报告基础上，根据用户意见进行修改，保持体裁为结构化报告。",
      "",
      `用户意见：${userInstruction}`,
      selectionInline,
      "若意见与原文冲突，以用户本次意见优先；可调整章节标题以贴合新需求。",
    ].join("\n");

    return UserRequestSchema.parse({
      userId: session.userId,
      sessionId: session.sessionId,
      prompt,
      industry,
      reportType,
      extraContext: [
        ...selectionExtra,
        "以下为上一轮完整报告 JSON，供对齐结构与事实（可改写）：",
        artifact.slice(0, 12_000),
      ],
      personalKnowledge: [],
      historyDocs: [],
      imContacts: [],
      mentionedResourceIds,
      chatPriorArtifactDigest: artifact.slice(0, 16_000),
      outputTargets: ["feishu_doc", "bitable", "slides"],
    });
  }

  const selectionInline = buildSelectionInlineForPrompt(selectionContexts);
  const prompt = [
    `请生成结构化专业报告（行业：${industry}，类型：${reportType}）。`,
    "用户需求如下：",
    userInstruction,
    selectionInline,
    session.messages.length > 2 && historyBrief
      ? `\n本会话摘要（供对齐）：\n${historyBrief}`
      : "",
  ]
    .join("\n")
    .trim();

  return UserRequestSchema.parse({
    userId: session.userId,
    sessionId: session.sessionId,
    prompt,
    industry,
    reportType,
    extraContext: selectionExtra,
    personalKnowledge: [],
    historyDocs: [],
    imContacts: [],
    mentionedResourceIds,
    outputTargets: ["feishu_doc", "bitable", "slides"],
  });
}

export async function registerChatRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/chat/sessions", async (request, reply) => {
    const body = CreateSessionBodySchema.parse(request.body);
    const session = createChatSession(body);
    return reply.send({ sessionId: session.sessionId, createdAt: session.createdAt });
  });

  app.get("/api/chat/sessions", async (request, reply) => {
    const q = z.object({ userId: z.string().min(1) }).parse(request.query);
    return reply.send({ sessions: listChatSessionsForUser(q.userId) });
  });

  app.get("/api/chat/sessions/:sessionId", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const session = loadChatSession(sessionId);
    if (!session) return reply.status(404).send({ message: "会话不存在" });
    return reply.send(session);
  });

  app.delete("/api/chat/sessions/:sessionId", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const q = z.object({ userId: z.string().min(1) }).parse(request.query);
    const session = loadChatSession(sessionId);
    if (!session) return reply.status(404).send({ message: "会话不存在" });
    if (session.userId !== q.userId) {
      return reply.status(403).send({ message: "无权删除该会话" });
    }
    deleteChatSession(sessionId);
    return reply.send({ ok: true });
  });

  app.get("/api/resource-pool/mentions", async (request, reply) => {
    const q = z
      .object({
        userId: z.string().default("mention_user"),
        q: z.string().optional(),
      })
      .parse(request.query);

    const pool = await loadResourcePoolSnapshot(q.userId);
    const needle = (q.q ?? "").trim().toLowerCase();
    const filtered = needle
      ? pool.filter(
          (r) =>
            r.resourceId.toLowerCase().includes(needle) ||
            r.title.toLowerCase().includes(needle) ||
            r.summary.toLowerCase().includes(needle),
        )
      : pool;

    return reply.send({
      items: filtered.slice(0, 100).map((r) => ({
        resourceId: r.resourceId,
        resourceType: r.resourceType,
        title: r.title,
        summary: r.summary.slice(0, 200),
      })),
    });
  });

  app.post("/api/chat/sessions/:sessionId/messages", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const body = SendMessageBodySchema.parse(request.body);
    const session = loadChatSession(sessionId);
    if (!session) return reply.status(404).send({ message: "会话不存在" });

    const pool = await loadResourcePoolSnapshot(session.userId);
    const mentions = filterValidMentions(body.mentionedResourceIds, pool);

    request.log.info(
      {
        sessionId,
        selectionCount: body.selectionContexts.length,
        revisionMode: body.revisionMode,
        contentLen: body.content.trim().length,
      },
      "chat_turn_received",
    );

    const userLines =
      body.content.trim() ||
      (body.selectionContexts.length > 0 ? "（已附带对话区引用）" : body.content);

    const userRequest = buildUserRequestForTurn({
      session,
      content: body.content,
      revisionMode: body.revisionMode,
      mentionedResourceIds: mentions,
      selectionContexts: body.selectionContexts,
    });

    try {
      const result = await runReportPipeline(userRequest);
      const response = GenerateReportResponseSchema.parse(result);
      const md = writerOutputToMarkdown(result.report);

      appendChatMessage(sessionId, {
        role: "user",
        content: userLines,
        revisionMode: body.revisionMode,
        mentionedResourceIds: mentions,
      });
      appendChatMessage(sessionId, {
        role: "assistant",
        content: md,
      });
      setLatestReport(sessionId, result.report);

      return reply.send({
        assistantMarkdown: md,
        pipeline: response,
        ...(body.selectionContexts.length > 0
          ? { receivedSelections: summarizeReceivedSelections(body.selectionContexts) }
          : {}),
      });
    } catch (error) {
      request.log.error({ error }, "chat turn failed");
      return reply.status(500).send({
        message: error instanceof Error ? error.message : "生成失败",
      });
    }
  });
}
