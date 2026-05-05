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
  GatewayMessage,
  GatewayRequestContext,
  GatewaySlide,
  GatewayUser,
  GatewayWhiteboard,
  ListMessagesInput,
  SendMessageInput,
  UpdateDocumentInput,
  UpdateWhiteboardInput,
} from "./types.js";
import { ToolGatewayError } from "./errors.js";

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
      throw new ToolGatewayError("NOT_CONFIGURED", "FEISHU_MCP_URL 未配置");
    }
    const c = getFeishuMvpConfig();
    if (!c.appId || !c.appSecret) {
      throw new ToolGatewayError("NOT_CONFIGURED", "缺少 FEISHU_APP_ID/FEISHU_APP_SECRET，无法调用 MCP");
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
      throw new ToolGatewayError("UPSTREAM_TEMPORARY", `MCP tool ${toolName} http=${res.status}`, {
        causeText: raw.slice(0, 300),
      });
    }
    const json = JSON.parse(raw) as {
      result?: McpToolCallResult;
      error?: { message?: string };
    };
    if (json.error) {
      throw new ToolGatewayError("UPSTREAM_TEMPORARY", `MCP tool ${toolName} error`, {
        causeText: json.error.message ?? "unknown",
      });
    }
    const result = json.result;
    if (!result) return null;
    if (result.structuredContent) return result.structuredContent;
    const text = result.content?.map((item) => item.text ?? "").join("\n") ?? "";
    return text || null;
  }

  async searchDocuments(query: string, _context?: GatewayRequestContext): Promise<GatewayDocument[]> {
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

  async listDocuments(query?: string, _context?: GatewayRequestContext): Promise<GatewayDocument[]> {
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

  async viewDocument(documentId: string, _context?: GatewayRequestContext): Promise<GatewayDocument | null> {
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

  async getFileContent(fileToken: string, _context?: GatewayRequestContext): Promise<string> {
    const data = await this.callTool("get-file-content", { file_token: fileToken });
    const parsed = parseMcpPayload<{ content?: string }>(data);
    return parsed?.content ?? (typeof data === "string" ? data : "");
  }

  async createDocument(input: CreateDocumentInput, _context?: GatewayRequestContext): Promise<GatewayDocument> {
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

  async updateDocument(input: UpdateDocumentInput, _context?: GatewayRequestContext): Promise<boolean> {
    await this.callTool("update-doc", {
      document_id: input.documentId,
      content: input.content,
    });
    return true;
  }

  async getComments(documentId: string, _context?: GatewayRequestContext): Promise<GatewayComment[]> {
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

  async addComment(input: AddCommentInput, _context?: GatewayRequestContext): Promise<boolean> {
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

  async searchUsers(query: string, _context?: GatewayRequestContext): Promise<GatewayUser[]> {
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

  async getUserInfo(userId: string, _context?: GatewayRequestContext): Promise<GatewayUser | null> {
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
}

