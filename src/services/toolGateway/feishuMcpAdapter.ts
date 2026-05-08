import { env } from "../../config/env.js";
import { feishuHttpFetch } from "../../integrations/feishu/httpFetch.js";
import { getFeishuMvpConfig } from "../../integrations/feishu/feishuConfig.js";
import { ensureUserOAuthReady } from "../../integrations/feishu/userOAuthRefresh.js";
import { getTenantAccessToken } from "../../integrations/feishu/token.js";
import { logger } from "../../shared/logger.js";
import type {
  AddCommentInput,
  CreateDocumentInput,
  CreateSlidesInput,
  DocxBlockInsertResult,
  DocxEmbedBlockInsertInput,
  DocxImageBlockInsertInput,
  FeishuToolGatewayApi,
  GatewayComment,
  GatewayDocument,
  GatewayDriveItem,
  GatewayDriveTaskStatus,
  GatewayFolderMeta,
  GatewayMessage,
  GatewayRequestContext,
  GatewayRootFolderMeta,
  GatewaySlide,
  GatewayUser,
  GatewayWhiteboard,
  ListMessagesInput,
  SendMessageInput,
  SheetChartInput,
  SheetChartResult,
  SheetCreateInput,
  SheetCreateResult,
  SheetWriteInput,
  UpdateDocumentInput,
  UpdateWhiteboardInput,
  UploadImageMediaInput,
  UploadImageMediaResult,
  WhiteboardCreateInput,
  WhiteboardCreateResult,
} from "./types.js";
import { ToolGatewayError } from "./errors.js";
import {
  extractCreateDocMetaFromUnknown,
  extractFetchDocBodyFromUnknown,
  extractSearchDocListFromUnknown,
  hasKnownSearchDocArrayField,
  interpretMcpUpdateDocResult,
  mcpSearchDocResponseIndicatesScopeGap,
  parseMcpPayload,
} from "./mcpResponseParse.js";
import { compactDocumentSearchQuery } from "./searchQueryNormalize.js";
import { detectDocumentPollution } from "../../shared/evidenceQuality.js";

type McpToolCallResult = {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: unknown;
};

type McpJsonRpcResponse = {
  result?: McpToolCallResult | { tools?: Array<{ name?: string }> };
  error?: { code?: number; message?: string; data?: unknown };
};

/** 与飞书「远程 MCP 支持的工具列表」文档中的工具名一致；README 旧版 plural 已弃用。 */
const MCP_TOOLS = {
  searchDoc: "search-doc",
  listDocs: "list-docs",
  fetchDoc: "fetch-doc",
  fetchFile: "fetch-file",
  createDoc: "create-doc",
  updateDoc: "update-doc",
  getComments: "get-comments",
  addComments: "add-comments",
  searchUser: "search-user",
  getUser: "get-user",
} as const;

/**
 * 远程 MCP 没有为渲染相关能力暴露稳定 tool；尝试以下候选工具名，命中即用，
 * 全部失败时抛 NOT_SUPPORTED，让 ToolGateway 走 OpenAPI/lark-cli 兜底。
 */
const MCP_RENDER_CANDIDATES = {
  uploadMedia: ["upload-media", "docx.media.upload", "media-upload", "drive.media.upload"],
  whiteboardCreate: [
    "create-whiteboard",
    "whiteboard.node.create",
    "board.whiteboard.node.create",
    "create-board",
  ],
  docxImageInsert: [
    "insert-docx-image-block",
    "docx.block.image.insert",
    "update-doc.image.insert",
  ],
  docxEmbedInsert: [
    "insert-docx-embed-block",
    "docx.block.embed.insert",
    "update-doc.embed.insert",
  ],
} as const;

function asRecord(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return null;
}

/** MCP tools/call 的 structuredContent 可能是 JSON 字符串 */
function toolResultAsRecord(data: unknown): Record<string, unknown> | null {
  if (data === null || data === undefined) return null;
  if (typeof data === "string") {
    const t = data.trim();
    if (!t) return null;
    const p = parseMcpPayload<Record<string, unknown>>(t);
    if (p && typeof p === "object" && !Array.isArray(p)) return p;
    return null;
  }
  return asRecord(data);
}

function pickTrimmedString(r: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = r[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

/**
 * 清洗 search-doc 命中片段中的 <hb> / <em> / <mark> 等高亮 HTML 标签，
 * 避免 snippet 原样塞入 HMRS 的 structureSummary 导致 Writer evidence 含 HTML 噪声。
 */
function stripHighlightTags(input: string | undefined | null): string {
  if (!input) return "";
  return String(input)
    .replace(/<\/?(?:hb|em|mark|b|strong|font|span)[^>]*>/gi, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/**
 * 飞书远程 MCP 的 update-doc 使用参数名 `docID`；值为 docx 的 file_token。
 * 若 create-doc 返回的是完整云文档 URL，需从路径 `/docx/<token>` 取出 token。
 */
function normalizeFeishuDocxTokenForMcp(raw: string): string {
  const s = raw.trim();
  if (!s) return "";
  if (s.startsWith("http://") || s.startsWith("https://")) {
    try {
      const u = new URL(s);
      const segs = u.pathname.split("/").filter(Boolean);
      const idx = segs.indexOf("docx");
      if (idx >= 0 && segs[idx + 1]) return segs[idx + 1]!;
    } catch {
      return s;
    }
  }
  return s;
}

function requireCreateDocShape(data: unknown, fallbackTitle?: string): { id: string; title: string; url: string } {
  const meta = extractCreateDocMetaFromUnknown(data, fallbackTitle);
  if (meta) return meta;
  const sample =
    typeof data === "string"
      ? data.slice(0, 1200)
      : JSON.stringify(data ?? null).slice(0, 1200);
  logger.warn("MCP create-doc 返回无法解析 id/title/url（请保存下列 sample 便于对齐字段）", { sample });
  throw new ToolGatewayError("INVALID_RESPONSE", "MCP create-doc 返回无法解析 id/title/url", {
    causeText: sample,
  });
}

function classifyHttpStatus(status: number, bodySnippet: string): ToolGatewayError {
  if (
    status === 400 &&
    /field validation failed|99992402|invalid\s+param|invalid\s+request/i.test(bodySnippet)
  ) {
    return new ToolGatewayError("VALIDATION", `MCP http=${status} 参数校验失败`, {
      causeText: bodySnippet,
    });
  }
  if (status === 401 || status === 403) {
    return new ToolGatewayError("PERMISSION_DENIED", `MCP http=${status}`, { causeText: bodySnippet });
  }
  if (status === 429) {
    return new ToolGatewayError("UPSTREAM_TEMPORARY", `MCP http=${status} 限流`, { causeText: bodySnippet });
  }
  if (status >= 500) {
    return new ToolGatewayError("UPSTREAM_TEMPORARY", `MCP http=${status}`, { causeText: bodySnippet });
  }
  return new ToolGatewayError("UPSTREAM_TEMPORARY", `MCP http=${status}`, { causeText: bodySnippet });
}

function classifyJsonRpcError(
  toolName: string,
  err?: { code?: number; message?: string },
): ToolGatewayError {
  const msg = err?.message ?? "unknown";
  const code = err?.code;
  const lower = msg.toLowerCase();
  if (
    lower.includes("permission") ||
    lower.includes("无权限") ||
    lower.includes("未授权") ||
    code === -32003
  ) {
    return new ToolGatewayError("PERMISSION_DENIED", `MCP tool ${toolName}: ${msg}`, { causeText: msg });
  }
  if (
    lower.includes("invalid") ||
    lower.includes("参数") ||
    lower.includes("param") ||
    code === -32602
  ) {
    return new ToolGatewayError("VALIDATION", `MCP tool ${toolName}: ${msg}`, { causeText: msg });
  }
  return new ToolGatewayError("UPSTREAM_TEMPORARY", `MCP tool ${toolName} error`, { causeText: msg });
}

type McpRpcAuthOpts = {
  /** UAT 模式下无 userId 时仅允许 tools/list 等探测：使用 TAT 回退 */
  tatFallbackWithoutUser?: boolean;
};

export class FeishuMcpAdapter implements FeishuToolGatewayApi {
  private readonly endpoint: string;
  private readonly allowedTools: string;

  constructor() {
    this.endpoint = env.FEISHU_MCP_URL;
    this.allowedTools = env.FEISHU_MCP_ALLOWED_TOOLS;
  }

  private async buildMcpAuthHeaders(
    context?: GatewayRequestContext,
    authOpts?: McpRpcAuthOpts,
  ): Promise<Record<string, string>> {
    if (env.FEISHU_MCP_IDENTITY === "uat") {
      const userId = context?.userId?.trim();
      if (!userId) {
        if (authOpts?.tatFallbackWithoutUser) {
          const c = getFeishuMvpConfig();
          if (!c.appId.trim() || !c.appSecret.trim()) {
            throw new ToolGatewayError(
              "NOT_CONFIGURED",
              "FEISHU_MCP_IDENTITY=uat 且无 userId 时，tools/list 探测需配置 FEISHU_APP_ID/FEISHU_APP_SECRET 以使用 TAT 回退",
            );
          }
          const tat = await getTenantAccessToken(c);
          logger.info("[mcp] UAT 模式未提供 userId，本请求使用 TAT（建议仅为 tools/list 探测）");
          return { "X-Lark-MCP-TAT": tat };
        }
        throw new ToolGatewayError(
          "NOT_CONFIGURED",
          "FEISHU_MCP_IDENTITY=uat 时需要 GatewayRequestContext.userId，且该用户须完成飞书 OAuth（写入 user-oauth-tokens.json）",
        );
      }
      const ensured = await ensureUserOAuthReady(userId);
      const rec = ensured.record;
      if (!rec || rec.expiresAtMs <= Date.now() + 60_000) {
        throw new ToolGatewayError(
          "NOT_CONFIGURED",
          `用户 ${userId} 无有效飞书用户访问令牌（UAT），请重新完成 OAuth`,
        );
      }
      if (ensured.refreshed) {
        logger.info("[mcp] UAT token 自动刷新成功", { userId });
      }
      return { "X-Lark-MCP-UAT": rec.accessToken };
    }
    const c = getFeishuMvpConfig();
    if (!c.appId.trim() || !c.appSecret.trim()) {
      throw new ToolGatewayError("NOT_CONFIGURED", "缺少 FEISHU_APP_ID/FEISHU_APP_SECRET，无法获取 TAT 调用 MCP");
    }
    const tat = await getTenantAccessToken(c);
    return { "X-Lark-MCP-TAT": tat };
  }

  private async postJsonRpc(
    method: string,
    params: unknown,
    errorLabel?: string,
    context?: GatewayRequestContext,
    authOpts?: McpRpcAuthOpts,
  ): Promise<unknown> {
    if (!this.endpoint) {
      throw new ToolGatewayError("NOT_CONFIGURED", "FEISHU_MCP_URL 未配置");
    }
    const auth = await this.buildMcpAuthHeaders(context, authOpts);
    const body = {
      jsonrpc: "2.0",
      id: Date.now(),
      method,
      params,
    };

    const res = await feishuHttpFetch(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        ...auth,
        "X-Lark-MCP-Allowed-Tools": this.allowedTools,
      },
      body: JSON.stringify(body),
    });

    const raw = await res.text();
    const bodySnippet = raw.slice(0, 300);
    if (!res.ok) {
      throw classifyHttpStatus(res.status, bodySnippet);
    }

    let json: McpJsonRpcResponse;
    try {
      json = JSON.parse(raw) as McpJsonRpcResponse;
    } catch {
      throw new ToolGatewayError("INVALID_RESPONSE", "MCP 响应非 JSON", { causeText: bodySnippet });
    }
    if (json.error) {
      throw classifyJsonRpcError(errorLabel ?? method, json.error);
    }
    return json.result ?? null;
  }

  private async callTool(
    toolName: string,
    args: Record<string, unknown>,
    context?: GatewayRequestContext,
  ): Promise<unknown> {
    const result = (await this.postJsonRpc(
      "tools/call",
      {
        name: toolName,
        arguments: args,
      },
      toolName,
      context,
    )) as McpToolCallResult | null;
    if (!result) return null;
    if (result.structuredContent !== undefined && result.structuredContent !== null) {
      return result.structuredContent;
    }
    const text = result.content?.map((item) => item.text ?? "").join("\n") ?? "";
    return text || null;
  }

  /** 健康探测：若服务端支持 tools/list 则返回工具名列表。 */
  async listRemoteToolNames(
    context?: GatewayRequestContext,
  ): Promise<{ ok: boolean; tools?: string[]; error?: string }> {
    try {
      const result = (await this.postJsonRpc("tools/list", {}, "tools/list", context, {
        tatFallbackWithoutUser: true,
      })) as { tools?: Array<{ name?: string }> } | null;
      const tools = (result?.tools ?? []).map((t) => t.name ?? "").filter(Boolean);
      return { ok: true, tools };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  async searchDocuments(query: string, context?: GatewayRequestContext): Promise<GatewayDocument[]> {
    const normalized = compactDocumentSearchQuery(query);
    if (normalized.length < 2) return [];
    let data: unknown;
    try {
      data = await this.callTool(MCP_TOOLS.searchDoc, { query: normalized }, context);
    } catch (error) {
      if (error instanceof ToolGatewayError && error.code === "VALIDATION") {
        logger.warn("MCP search-doc 参数校验失败，回退 list-docs 本地筛选", {
          queryPreview: normalized.slice(0, 120),
          causeText: error.causeText?.slice(0, 300),
        });
        const listed = await this.listDocuments("", context).catch(() => []);
        const q = normalized.toLowerCase();
        return listed
          .filter((d) => `${d.title ?? ""} ${(d.summary ?? "")}`.toLowerCase().includes(q))
          .slice(0, 8);
      }
      throw error;
    }
    if (mcpSearchDocResponseIndicatesScopeGap(data)) {
      throw new ToolGatewayError(
        "SCOPE_INSUFFICIENT",
        "MCP search-doc 需要用户身份权限 search:docs:read：开放平台「权限管理」对该 scope 选 **用户身份** 并发布后，将 FEISHU_USER_OAUTH_SCOPES 含 search:docs:read（及需的 drive:drive.search:readonly 等），设 FEISHU_USER_OAUTH_PROMPT=consent 后打开 /api/feishu/auth/start?userId=… 完成重新 OAuth（与重登飞书/重启电脑无关）",
        {
          causeText:
            typeof data === "string" ? data.slice(0, 800) : JSON.stringify(data).slice(0, 800),
        },
      );
    }
    const rows = extractSearchDocListFromUnknown(data);
    if (rows.length === 0 && data !== null && data !== undefined) {
      const sample =
        typeof data === "string" ? data.slice(0, 1_200) : JSON.stringify(data).slice(0, 1_200);
      if (hasKnownSearchDocArrayField(data)) {
        logger.info("MCP search-doc 返回 0 条（结构正常，当前查询无命中）", {
          queryPreview: normalized.slice(0, 200),
          sample,
        });
      } else {
        logger.warn("MCP search-doc 解析后 0 条，请核对返回 JSON 字段是否与 docs/documents 等一致", {
          queryPreview: normalized.slice(0, 200),
          sample,
        });
      }
    }
    const baseDocs: GatewayDocument[] = rows.map((doc, idx) => ({
      id: doc.id || `mcp_doc_${idx + 1}`,
      title: stripHighlightTags(doc.title) || `MCP文档${idx + 1}`,
      summary:
        stripHighlightTags(doc.summary).trim() ||
        `文档候选：${stripHighlightTags(doc.title) || doc.id || `MCP文档${idx + 1}`}`,
      url: doc.url,
      source: "mcp",
    }));

    /**
     * 深读前 N 篇：search-doc 命中片段会带 <hb> HTML 高亮，且只是 snippet 不是正文。
     * 让 Writer 真正拿到原文，避免只把 snippet 写回 HMRS 的 structureSummary 形成幻觉。
     */
    return await this.deepFetchSearchHits(baseDocs, context);
  }

  /**
   * 把 search-doc 命中前 N 篇调用 fetch-doc 拉正文，正文截断后写到 content/summary。
   * 命中污染语（系统失败痕迹/占位语/失败哈希）的整篇直接丢弃，避免反喂 Writer 形成回路。
   */
  private async deepFetchSearchHits(
    docs: GatewayDocument[],
    context?: GatewayRequestContext,
  ): Promise<GatewayDocument[]> {
    const N = 6;
    const MAX_CHARS = 8_000;
    const limit = Math.min(N, docs.length);
    const enriched: GatewayDocument[] = [];
    let droppedByPollution = 0;
    for (let i = 0; i < docs.length; i += 1) {
      const doc = docs[i];
      if (!doc) continue;
      if (i >= limit) {
        const verdict = detectDocumentPollution({ title: doc.title, content: doc.summary });
        if (verdict.polluted) {
          droppedByPollution += 1;
          continue;
        }
        enriched.push(doc);
        continue;
      }
      try {
        const view = await this.viewDocument(doc.id, context);
        const rawContent = stripHighlightTags(view?.content ?? view?.summary ?? "").trim();
        if (!rawContent) {
          const verdict = detectDocumentPollution({ title: doc.title, content: doc.summary });
          if (verdict.polluted) {
            droppedByPollution += 1;
            continue;
          }
          enriched.push(doc);
          continue;
        }
        const trimmed = rawContent.length > MAX_CHARS ? rawContent.slice(0, MAX_CHARS) : rawContent;
        const finalTitle = stripHighlightTags(view?.title || doc.title);
        const verdict = detectDocumentPollution({ title: finalTitle, content: trimmed });
        if (verdict.polluted) {
          droppedByPollution += 1;
          logger.warn("MCP deep fetch dropped polluted document", {
            docId: doc.id,
            titlePreview: finalTitle.slice(0, 80),
            reasons: verdict.reasons,
          });
          continue;
        }
        enriched.push({
          ...doc,
          title: finalTitle,
          url: view?.url ?? doc.url,
          content: trimmed,
          summary: trimmed.slice(0, 480),
        });
      } catch (error) {
        logger.warn("MCP deep fetch failed, keep snippet", {
          docId: doc.id,
          error: error instanceof Error ? error.message : String(error),
        });
        enriched.push(doc);
      }
    }
    if (droppedByPollution > 0) {
      logger.warn("MCP deep fetch evidence pollution filter active", {
        droppedByPollution,
        keptCount: enriched.length,
      });
    }
    return enriched;
  }

  async listDocuments(query?: string, context?: GatewayRequestContext): Promise<GatewayDocument[]> {
    const data = await this.callTool(MCP_TOOLS.listDocs, { query: query ?? "" }, context);
    const rows = extractSearchDocListFromUnknown(data);
    return rows.map((doc, idx) => ({
      id: doc.id || `mcp_list_doc_${idx + 1}`,
      title: stripHighlightTags(doc.title) || `MCP文档${idx + 1}`,
      summary: stripHighlightTags(doc.summary ?? ""),
      url: doc.url,
      source: "mcp",
    }));
  }

  async viewDocument(documentId: string, context?: GatewayRequestContext): Promise<GatewayDocument | null> {
    let data: unknown = await this.callTool(MCP_TOOLS.fetchDoc, { document_id: documentId }, context);
    let body = extractFetchDocBodyFromUnknown(data);
    if (!body.trim()) {
      const docUrl = documentId.startsWith("http") ? documentId : `https://www.feishu.cn/docx/${documentId}`;
      for (const args of [{ document_url: docUrl }, { url: docUrl }, { link: docUrl }]) {
        try {
          const d2 = await this.callTool(MCP_TOOLS.fetchDoc, args, context);
          const b2 = extractFetchDocBodyFromUnknown(d2);
          if (b2.trim()) {
            data = d2;
            body = b2;
            break;
          }
        } catch {
          /* 不同部署参数名可能不一致，继续尝试 */
        }
      }
    }
    if (body.trim().length > 0 && body.trim().length < env.FEISHU_VIEW_DOCUMENT_MIN_CHARS) {
      const token = documentId.trim();
      for (const args of [
        { document_id: token, format: "markdown" },
        { document_id: token, export_format: "markdown" },
        { document_id: token, detail: "full" },
      ]) {
        try {
          const d2 = await this.callTool(MCP_TOOLS.fetchDoc, args, context);
          const b2 = extractFetchDocBodyFromUnknown(d2);
          if (b2.trim().length > body.trim().length) {
            data = d2;
            body = b2;
          }
        } catch {
          /* 参数不受支持时忽略 */
        }
      }
    }
    const parsed = parseMcpPayload<Record<string, unknown>>(data);
    const rec = parsed ? asRecord(parsed) : null;
    if (!rec && !body.trim()) return null;
    const id =
      (rec && pickTrimmedString(rec, ["id", "document_id", "file_token"]))?.trim() ?? documentId;
    const title =
      (rec && pickTrimmedString(rec, ["title", "document_title", "name"])) ?? `文档-${documentId}`;
    const url =
      (rec && pickTrimmedString(rec, ["url", "link", "document_url"])) ??
      (documentId.startsWith("http") ? documentId : undefined);
    return {
      id,
      title,
      content: body,
      summary: body ? body.slice(0, 200) : rec ? undefined : "",
      url,
      source: "mcp",
    };
  }

  async getFileContent(fileToken: string, context?: GatewayRequestContext): Promise<string> {
    const data = await this.callTool(MCP_TOOLS.fetchFile, { file_token: fileToken }, context);
    const parsed = parseMcpPayload<{ content?: string }>(data);
    return parsed?.content ?? (typeof data === "string" ? data : "");
  }

  async createDocument(input: CreateDocumentInput, context?: GatewayRequestContext): Promise<GatewayDocument> {
    const effectiveContext: GatewayRequestContext = {
      userId: context?.userId ?? input.userId,
      preferUserScope: context?.preferUserScope ?? input.preferUserScope,
    };
    const data = await this.callTool(
      MCP_TOOLS.createDoc,
      {
        title: input.title,
        content: input.content ?? "",
      },
      effectiveContext,
    );
    const shape = requireCreateDocShape(data, input.title);
    return {
      id: shape.id,
      title: shape.title,
      summary: input.content?.slice(0, 200),
      content: input.content,
      url: shape.url,
      source: "mcp",
    };
  }

  async updateDocument(input: UpdateDocumentInput, context?: GatewayRequestContext): Promise<boolean> {
    const docToken = normalizeFeishuDocxTokenForMcp(input.documentId);
    if (!docToken) {
      throw new ToolGatewayError(
        "VALIDATION",
        "update-doc 缺少有效文档 ID（无法从 documentId 解析 docx token）",
      );
    }
    const data = await this.callTool(
      MCP_TOOLS.updateDoc,
      {
        docID: docToken,
        document_id: docToken,
        mode: "overwrite",
        markdown: input.content,
        content: input.content,
      },
      context,
    );
    const errRec = toolResultAsRecord(data);
    if (errRec && typeof errRec.error === "string" && errRec.error.trim()) {
      const msg = errRec.error.trim();
      throw new ToolGatewayError("VALIDATION", `MCP update-doc: ${msg.slice(0, 500)}`, {
        causeText: msg,
      });
    }
    if (interpretMcpUpdateDocResult(data)) {
      return true;
    }
    const sample =
      typeof data === "string" ? data.slice(0, 500) : JSON.stringify(data ?? null).slice(0, 500);
    logger.warn("MCP update-doc 返回未识别为成功，尝试 fetch-doc 写后读校验", { sample });
    try {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 400);
      });
      const viewed = await this.viewDocument(input.documentId, context);
      const body = extractFetchDocBodyFromUnknown(viewed).trim();
      const written = (input.content ?? "").trim();
      if (written.length > 0 && body.length > 0) {
        if (written.includes("##") && body.includes("##")) {
          logger.info("[mcp] update-doc 经 fetch-doc 校验通过（正文含章节）", {
            documentId: input.documentId,
            bodyLen: body.length,
          });
          return true;
        }
        const n = Math.min(160, written.length, body.length);
        if (n >= 24 && written.slice(0, n) === body.slice(0, n)) {
          logger.info("[mcp] update-doc 经 fetch-doc 前缀校验通过", { documentId: input.documentId });
          return true;
        }
      }
    } catch (err) {
      logger.warn("MCP update-doc 写后读校验异常", {
        documentId: input.documentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    throw new ToolGatewayError("INVALID_RESPONSE", "MCP update-doc 未返回成功状态", {
      causeText: sample,
    });
  }

  async getComments(documentId: string, context?: GatewayRequestContext): Promise<GatewayComment[]> {
    const data = await this.callTool(MCP_TOOLS.getComments, { document_id: documentId }, context);
    const parsed =
      parseMcpPayload<{ comments?: Array<{ id?: string; author?: string; content?: string; created_at?: string }> }>(
        data,
      );
    return (parsed?.comments ?? []).map((item, idx) => ({
      id: item.id ?? `mcp_comment_${idx + 1}`,
      author: item.author,
      content: item.content ?? "",
      createdAt: item.created_at,
      source: "mcp",
    }));
  }

  async addComment(input: AddCommentInput, context?: GatewayRequestContext): Promise<boolean> {
    try {
      await this.callTool(
        MCP_TOOLS.addComments,
        {
          document_id: input.documentId,
          content: input.content,
        },
        context,
      );
      return true;
    } catch (error) {
      logger.warn("MCP add-comments 调用失败", {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  async searchUsers(query: string, context?: GatewayRequestContext): Promise<GatewayUser[]> {
    const data = await this.callTool(MCP_TOOLS.searchUser, { query }, context);
    const parsed =
      parseMcpPayload<{ users?: Array<{ id?: string; name?: string; department?: string; role?: string }> }>(
        data,
      );
    return (parsed?.users ?? []).map((item, idx) => ({
      id: item.id ?? `mcp_user_${idx + 1}`,
      name: item.name ?? `用户${idx + 1}`,
      department: item.department,
      role: item.role,
      source: "mcp",
    }));
  }

  async getUserInfo(userId: string, context?: GatewayRequestContext): Promise<GatewayUser | null> {
    const data = await this.callTool(MCP_TOOLS.getUser, { user_id: userId }, context);
    const parsed = parseMcpPayload<{ id?: string; name?: string; department?: string; role?: string }>(data);
    if (!parsed) return null;
    return {
      id: parsed.id ?? userId,
      name: parsed.name ?? userId,
      department: parsed.department,
      role: parsed.role,
      source: "mcp",
    };
  }

  async createSlides(_input: CreateSlidesInput): Promise<GatewaySlide> {
    throw new ToolGatewayError("NOT_SUPPORTED", "MCP 侧暂未提供 slides create 工具");
  }

  async queryWhiteboard(_token: string): Promise<GatewayWhiteboard | null> {
    throw new ToolGatewayError("NOT_SUPPORTED", "MCP 侧暂未提供 whiteboard query 工具");
  }

  async updateWhiteboard(_input: UpdateWhiteboardInput): Promise<boolean> {
    throw new ToolGatewayError("NOT_SUPPORTED", "MCP 侧暂未提供 whiteboard update 工具");
  }

  async sendMessage(_input: SendMessageInput): Promise<boolean> {
    throw new ToolGatewayError("NOT_SUPPORTED", "MCP 侧暂未提供 message send 工具");
  }

  async listMessages(_input: ListMessagesInput): Promise<GatewayMessage[]> {
    throw new ToolGatewayError("NOT_SUPPORTED", "MCP 侧暂未提供 message list 工具");
  }

  async getRootFolderMeta(_context?: GatewayRequestContext): Promise<GatewayRootFolderMeta> {
    throw new ToolGatewayError("NOT_SUPPORTED", "MCP 侧暂未提供 drive root meta 工具");
  }

  async getFolderMeta(_folderToken: string, _context?: GatewayRequestContext): Promise<GatewayFolderMeta> {
    throw new ToolGatewayError("NOT_SUPPORTED", "MCP 侧暂未提供 folder meta 工具");
  }

  async listFolderItems(
    _folderToken: string,
    _context?: GatewayRequestContext,
  ): Promise<GatewayDriveItem[]> {
    throw new ToolGatewayError("NOT_SUPPORTED", "MCP 侧暂未提供 folder list 工具");
  }

  async createFolder(
    _input: { parentFolderToken: string; folderName: string },
    _context?: GatewayRequestContext,
  ): Promise<GatewayFolderMeta> {
    throw new ToolGatewayError("NOT_SUPPORTED", "MCP 侧暂未提供 create folder 工具");
  }

  async moveFile(
    _input: { fileToken: string; targetFolderToken: string },
    _context?: GatewayRequestContext,
  ): Promise<GatewayDriveTaskStatus | null> {
    throw new ToolGatewayError("NOT_SUPPORTED", "MCP 侧暂未提供 move file 工具");
  }

  async copyFile(
    _input: { fileToken: string; targetFolderToken: string; fileName?: string; copyAsDocx?: boolean },
    _context?: GatewayRequestContext,
  ): Promise<{ fileToken?: string; url?: string; task?: GatewayDriveTaskStatus | null }> {
    throw new ToolGatewayError("NOT_SUPPORTED", "MCP 侧暂未提供 copy file 工具");
  }

  async deleteFile(
    _input: { fileToken: string; fileType?: string },
    _context?: GatewayRequestContext,
  ): Promise<GatewayDriveTaskStatus | null> {
    throw new ToolGatewayError("NOT_SUPPORTED", "MCP 侧暂未提供 delete file 工具");
  }

  async checkTask(
    _input: { ticket: string },
    _context?: GatewayRequestContext,
  ): Promise<GatewayDriveTaskStatus> {
    throw new ToolGatewayError("NOT_SUPPORTED", "MCP 侧暂未提供 task check 工具");
  }

  /**
   * 按候选工具名依次试调；命中一个即返回原始 result。
   * 全部失败抛 NOT_SUPPORTED，让 ToolGateway 走 OpenAPI/lark-cli 兜底。
   */
  private async tryMcpToolByCandidates(input: {
    candidates: readonly string[];
    args: Record<string, unknown>;
    context?: GatewayRequestContext;
    label: string;
  }): Promise<unknown> {
    let lastError: unknown;
    for (const toolName of input.candidates) {
      try {
        const result = await this.callTool(toolName, input.args, input.context);
        if (result === null || result === undefined) {
          // 部分服务端会返回空结果；视为未命中继续下一个候选
          lastError = new ToolGatewayError("NOT_SUPPORTED", `MCP ${toolName} returned empty result`);
          continue;
        }
        return result;
      } catch (error) {
        lastError = error;
        if (
          error instanceof ToolGatewayError &&
          (error.code === "PERMISSION_DENIED" || error.code === "VALIDATION")
        ) {
          // 工具存在但拒绝/参数不对，直接抛出，不再尝试其他名字
          throw error;
        }
        // 否则视为该候选不可用，尝试下一个
      }
    }
    throw new ToolGatewayError(
      "NOT_SUPPORTED",
      `MCP 侧未暴露 ${input.label} 工具（试过 ${input.candidates.join(", ")}）`,
      {
        causeText: lastError instanceof Error ? lastError.message : undefined,
      },
    );
  }

  async uploadImageMedia(
    input: UploadImageMediaInput,
    context?: GatewayRequestContext,
  ): Promise<UploadImageMediaResult> {
    const base64 = Buffer.from(input.buffer).toString("base64");
    const args: Record<string, unknown> = {
      file_name: input.fileName,
      mime_type: input.mimeType ?? "image/png",
      content_base64: base64,
      data: base64,
      size: input.buffer.byteLength,
    };
    if (input.parent?.type === "docx_image") {
      args.parent_type = "docx_image";
      args.parent_node = input.parent.documentId;
      args.document_id = input.parent.documentId;
    } else if (input.parent?.type === "drive") {
      args.parent_type = "explorer";
      if (input.parent.folderToken) args.parent_node = input.parent.folderToken;
    }
    const result = await this.tryMcpToolByCandidates({
      candidates: MCP_RENDER_CANDIDATES.uploadMedia,
      args,
      context,
      label: "media upload",
    });
    const rec = toolResultAsRecord(result) ?? asRecord(result);
    const mediaToken =
      pickTrimmedString(rec ?? {}, ["file_token", "fileToken", "media_token", "mediaToken", "token"]) ?? "";
    if (!mediaToken) {
      throw new ToolGatewayError("INVALID_RESPONSE", "MCP media upload 未返回 media token", {
        causeText: typeof result === "string" ? result.slice(0, 600) : JSON.stringify(result).slice(0, 600),
      });
    }
    return {
      mediaToken,
      url: pickTrimmedString(rec ?? {}, ["url", "preview_url", "previewUrl", "link"]),
      source: "mcp",
    };
  }

  async insertDocxImageBlock(
    input: DocxImageBlockInsertInput,
    context?: GatewayRequestContext,
  ): Promise<DocxBlockInsertResult> {
    const docToken = normalizeFeishuDocxTokenForMcp(input.documentId);
    if (!docToken) {
      throw new ToolGatewayError("VALIDATION", "MCP insertDocxImageBlock 缺少有效 documentId");
    }
    const args: Record<string, unknown> = {
      document_id: docToken,
      docID: docToken,
      parent_block_id: input.parentBlockId,
      parentBlockId: input.parentBlockId,
      media_token: input.mediaToken,
      mediaToken: input.mediaToken,
      ...(typeof input.index === "number" ? { index: input.index } : {}),
      ...(input.caption ? { caption: input.caption } : {}),
    };
    try {
      const result = await this.tryMcpToolByCandidates({
        candidates: MCP_RENDER_CANDIDATES.docxImageInsert,
        args,
        context,
        label: "docx image block insert",
      });
      const rec = toolResultAsRecord(result) ?? asRecord(result);
      return {
        ok: true,
        blockId: rec ? pickTrimmedString(rec, ["block_id", "blockId", "id"]) : undefined,
        source: "mcp",
      };
    } catch (error) {
      if (error instanceof ToolGatewayError && error.code === "NOT_SUPPORTED") throw error;
      return {
        ok: false,
        warning: error instanceof Error ? error.message : String(error),
        source: "mcp",
      };
    }
  }

  async insertDocxEmbedBlock(
    input: DocxEmbedBlockInsertInput,
    context?: GatewayRequestContext,
  ): Promise<DocxBlockInsertResult> {
    const docToken = normalizeFeishuDocxTokenForMcp(input.documentId);
    if (!docToken) {
      throw new ToolGatewayError("VALIDATION", "MCP insertDocxEmbedBlock 缺少有效 documentId");
    }
    const args: Record<string, unknown> = {
      document_id: docToken,
      docID: docToken,
      parent_block_id: input.parentBlockId,
      parentBlockId: input.parentBlockId,
      embed_kind: input.embedKind,
      embedKind: input.embedKind,
      ref_token: input.refToken,
      refToken: input.refToken,
      ...(typeof input.index === "number" ? { index: input.index } : {}),
      ...(input.caption ? { caption: input.caption } : {}),
    };
    try {
      const result = await this.tryMcpToolByCandidates({
        candidates: MCP_RENDER_CANDIDATES.docxEmbedInsert,
        args,
        context,
        label: "docx embed block insert",
      });
      const rec = toolResultAsRecord(result) ?? asRecord(result);
      return {
        ok: true,
        blockId: rec ? pickTrimmedString(rec, ["block_id", "blockId", "id"]) : undefined,
        source: "mcp",
      };
    } catch (error) {
      if (error instanceof ToolGatewayError && error.code === "NOT_SUPPORTED") throw error;
      return {
        ok: false,
        warning: error instanceof Error ? error.message : String(error),
        source: "mcp",
      };
    }
  }

  async createSheet(
    _input: SheetCreateInput,
    _context?: GatewayRequestContext,
  ): Promise<SheetCreateResult> {
    throw new ToolGatewayError("NOT_SUPPORTED", "MCP 侧暂未提供 sheet create 工具");
  }

  async writeSheet(_input: SheetWriteInput, _context?: GatewayRequestContext): Promise<boolean> {
    throw new ToolGatewayError("NOT_SUPPORTED", "MCP 侧暂未提供 sheet write 工具");
  }

  async createSheetChart(
    _input: SheetChartInput,
    _context?: GatewayRequestContext,
  ): Promise<SheetChartResult> {
    throw new ToolGatewayError("NOT_SUPPORTED", "MCP 侧暂未提供 sheet chart 工具");
  }

  async createWhiteboard(
    input: WhiteboardCreateInput,
    context?: GatewayRequestContext,
  ): Promise<WhiteboardCreateResult> {
    const args: Record<string, unknown> = {
      title: input.title,
      syntax: input.syntax,
      body: input.body,
      content: input.body,
      ...(input.parentFolderToken
        ? { parent_folder_token: input.parentFolderToken, parentFolderToken: input.parentFolderToken }
        : {}),
    };
    const result = await this.tryMcpToolByCandidates({
      candidates: MCP_RENDER_CANDIDATES.whiteboardCreate,
      args,
      context,
      label: "whiteboard create",
    });
    const rec = toolResultAsRecord(result) ?? asRecord(result);
    const token =
      pickTrimmedString(rec ?? {}, ["whiteboard_token", "whiteboardToken", "token", "node_token", "nodeToken"]) ?? "";
    if (!token) {
      throw new ToolGatewayError("INVALID_RESPONSE", "MCP whiteboard create 未返回 token", {
        causeText: typeof result === "string" ? result.slice(0, 600) : JSON.stringify(result).slice(0, 600),
      });
    }
    return {
      whiteboardToken: token,
      url: pickTrimmedString(rec ?? {}, ["url", "preview_url", "previewUrl", "link"]),
      source: "mcp",
    };
  }

  async fetchDocumentOutline(
    _documentId: string,
    _context?: GatewayRequestContext,
  ): Promise<string[]> {
    // MCP 侧暂未提供 outline-only 拉取工具，返回空数组让 ToolGateway 走 lark-cli 兜底
    throw new ToolGatewayError("NOT_SUPPORTED", "MCP 侧暂未提供 document outline 工具");
  }
}
