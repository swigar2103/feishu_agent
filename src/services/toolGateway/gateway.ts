import { env } from "../../config/env.js";
import { logger } from "../../shared/logger.js";
import { FeishuMcpAdapter } from "./feishuMcpAdapter.js";
import { FeishuOpenApiAdapter } from "./feishuOpenApiAdapter.js";
import type {
  AddCommentInput,
  CreateDocumentInput,
  FeishuToolGatewayApi,
  GatewayComment,
  GatewayDocument,
  GatewayUser,
  UpdateDocumentInput,
} from "./types.js";

export class ToolGateway implements FeishuToolGatewayApi {
  private readonly mcp = new FeishuMcpAdapter();
  private readonly fallback = new FeishuOpenApiAdapter();

  private async withFallback<T>(name: string, runMcp: () => Promise<T>, runFallback: () => Promise<T>): Promise<T> {
    if (!env.FEISHU_MCP_URL.trim()) {
      return runFallback();
    }
    try {
      return await runMcp();
    } catch (error) {
      logger.warn(`[tool-gateway] ${name} mcp failed, fallback openapi`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return runFallback();
    }
  }

  searchDocuments(query: string): Promise<GatewayDocument[]> {
    return this.withFallback(
      "searchDocuments",
      () => this.mcp.searchDocuments(query),
      () => this.fallback.searchDocuments(query),
    );
  }

  listDocuments(query?: string): Promise<GatewayDocument[]> {
    return this.withFallback(
      "listDocuments",
      () => this.mcp.listDocuments(query),
      () => this.fallback.listDocuments(query),
    );
  }

  viewDocument(documentId: string): Promise<GatewayDocument | null> {
    return this.withFallback(
      "viewDocument",
      () => this.mcp.viewDocument(documentId),
      () => this.fallback.viewDocument(documentId),
    );
  }

  getFileContent(fileToken: string): Promise<string> {
    return this.withFallback(
      "getFileContent",
      () => this.mcp.getFileContent(fileToken),
      () => this.fallback.getFileContent(fileToken),
    );
  }

  createDocument(input: CreateDocumentInput): Promise<GatewayDocument> {
    return this.withFallback(
      "createDocument",
      () => this.mcp.createDocument(input),
      () => this.fallback.createDocument(input),
    );
  }

  updateDocument(input: UpdateDocumentInput): Promise<boolean> {
    return this.withFallback(
      "updateDocument",
      () => this.mcp.updateDocument(input),
      () => this.fallback.updateDocument(input),
    );
  }

  getComments(documentId: string): Promise<GatewayComment[]> {
    return this.withFallback(
      "getComments",
      () => this.mcp.getComments(documentId),
      () => this.fallback.getComments(documentId),
    );
  }

  addComment(input: AddCommentInput): Promise<boolean> {
    return this.withFallback(
      "addComment",
      () => this.mcp.addComment(input),
      () => this.fallback.addComment(input),
    );
  }

  searchUsers(query: string): Promise<GatewayUser[]> {
    return this.withFallback(
      "searchUsers",
      () => this.mcp.searchUsers(query),
      () => this.fallback.searchUsers(query),
    );
  }

  getUserInfo(userId: string): Promise<GatewayUser | null> {
    return this.withFallback(
      "getUserInfo",
      () => this.mcp.getUserInfo(userId),
      () => this.fallback.getUserInfo(userId),
    );
  }
}

export const toolGateway = new ToolGateway();
