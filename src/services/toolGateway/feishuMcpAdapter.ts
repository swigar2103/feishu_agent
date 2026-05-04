import { env } from "../../config/env.js";
import { feishuHttpFetch } from "../../integrations/feishu/httpFetch.js";
import { getFeishuMvpConfig } from "../../integrations/feishu/feishuConfig.js";
import { getTenantAccessToken } from "../../integrations/feishu/token.js";
import { logger } from "../../shared/logger.js";
import type {
  AddCommentInput,
  CreateDocumentInput,
  CreateSlidesInput,
  FeishuToolGatewayApi,
  GatewayComment,
  GatewayDocument,
  GatewaySlides,
  GatewayUser,
  UpdateDocumentInput,
} from "./types.js";

type McpToolCallResult = {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: unknown;
};

function parseMcpPayload<T>(payload: unknown): T | null {
  if (!payload) return null;
  try {
    if (typeof payload === "string") {
      return JSON.parse(payload) as T;
    }
    return payload as T;
  } catch {
    return null;
  }
}

export class FeishuMcpAdapter implements FeishuToolGatewayApi {
  private readonly endpoint: string;
  private readonly allowedTools: string;

  constructor() {
    this.endpoint = env.FEISHU_MCP_URL;
    this.allowedTools = env.FEISHU_MCP_ALLOWED_TOOLS;
  }

  private async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.endpoint) {
      throw new Error("FEISHU_MCP_URL 未配置");
    }
    const c = getFeishuMvpConfig();
    if (!c.appId || !c.appSecret) {
      throw new Error("缺少 FEISHU_APP_ID/FEISHU_APP_SECRET，无法调用 MCP");
    }
    const tat = await getTenantAccessToken(c);
    const body = {
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: {
        name: toolName,
        arguments: args,
      },
    };

    const res = await feishuHttpFetch(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "X-Lark-MCP-TAT": tat,
        "X-Lark-MCP-Allowed-Tools": this.allowedTools,
      },
      body: JSON.stringify(body),
    });

    const raw = await res.text();
    if (!res.ok) {
      throw new Error(`MCP tool ${toolName} http=${res.status} body=${raw.slice(0, 300)}`);
    }
    const json = JSON.parse(raw) as {
      result?: McpToolCallResult;
      error?: { message?: string };
    };
    if (json.error) {
      throw new Error(`MCP tool ${toolName} error=${json.error.message ?? "unknown"}`);
    }
    const result = json.result;
    if (!result) return null;
    if (result.structuredContent) return result.structuredContent;
    const text = result.content?.map((item) => item.text ?? "").join("\n") ?? "";
    return text || null;
  }

  async searchDocuments(query: string): Promise<GatewayDocument[]> {
    const data = await this.callTool("search-docs", { query });
    const parsed =
      parseMcpPayload<{ docs?: Array<{ id?: string; title?: string; summary?: string; url?: string }> }>(
        data,
      );
    return (parsed?.docs ?? []).map((doc, idx) => ({
      id: doc.id ?? `mcp_doc_${idx + 1}`,
      title: doc.title ?? `MCP文档${idx + 1}`,
      summary: doc.summary ?? "",
      url: doc.url,
      source: "mcp",
    }));
  }

  async listDocuments(query?: string): Promise<GatewayDocument[]> {
    const data = await this.callTool("list-docs", { query: query ?? "" });
    const parsed =
      parseMcpPayload<{ docs?: Array<{ id?: string; title?: string; summary?: string; url?: string }> }>(
        data,
      );
    return (parsed?.docs ?? []).map((doc, idx) => ({
      id: doc.id ?? `mcp_list_doc_${idx + 1}`,
      title: doc.title ?? `MCP文档${idx + 1}`,
      summary: doc.summary ?? "",
      url: doc.url,
      source: "mcp",
    }));
  }

  async viewDocument(documentId: string): Promise<GatewayDocument | null> {
    const data = await this.callTool("fetch-doc", { document_id: documentId });
    const parsed = parseMcpPayload<{ id?: string; title?: string; content?: string; url?: string }>(data);
    if (!parsed) return null;
    return {
      id: parsed.id ?? documentId,
      title: parsed.title ?? `文档-${documentId}`,
      content: parsed.content ?? "",
      summary: parsed.content?.slice(0, 200),
      url: parsed.url,
      source: "mcp",
    };
  }

  async getFileContent(fileToken: string): Promise<string> {
    const data = await this.callTool("get-file-content", { file_token: fileToken });
    const parsed = parseMcpPayload<{ content?: string }>(data);
    return parsed?.content ?? (typeof data === "string" ? data : "");
  }

  async createDocument(input: CreateDocumentInput): Promise<GatewayDocument> {
    const data = await this.callTool("create-doc", {
      title: input.title,
      content: input.content ?? "",
    });
    const parsed = parseMcpPayload<{ id?: string; title?: string; url?: string }>(data);
    return {
      id: parsed?.id ?? `mcp_created_${Date.now()}`,
      title: parsed?.title ?? input.title,
      summary: input.content?.slice(0, 200),
      content: input.content,
      url: parsed?.url,
      source: "mcp",
    };
  }

  async updateDocument(input: UpdateDocumentInput): Promise<boolean> {
    await this.callTool("update-doc", {
      document_id: input.documentId,
      content: input.content,
    });
    return true;
  }

  async getComments(documentId: string): Promise<GatewayComment[]> {
    const data = await this.callTool("get-comments", { document_id: documentId });
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

  async addComment(input: AddCommentInput): Promise<boolean> {
    try {
      await this.callTool("add-comment", {
        document_id: input.documentId,
        content: input.content,
      });
      return true;
    } catch (error) {
      logger.warn("MCP add-comment 调用失败", {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  async searchUsers(query: string): Promise<GatewayUser[]> {
    const data = await this.callTool("search-users", { query });
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

  async getUserInfo(userId: string): Promise<GatewayUser | null> {
    const data = await this.callTool("get-user-info", { user_id: userId });
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

  async createSlides(input: CreateSlidesInput): Promise<GatewaySlides> {
    const data = await this.callTool("create-slides", {
      title: input.title,
      outline: input.outline,
    });
    const parsed = parseMcpPayload<{ id?: string; title?: string; url?: string }>(data);
    return {
      id: parsed?.id ?? `mcp_slides_${Date.now()}`,
      title: parsed?.title ?? input.title,
      outline: input.outline,
      url: parsed?.url ?? `https://mock.feishu.local/slides/${Date.now()}`,
      source: "mcp",
    };
  }
}
