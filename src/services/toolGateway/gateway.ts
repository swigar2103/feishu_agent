import { env } from "../../config/env.js";
import { logger } from "../../shared/logger.js";
import { FeishuMcpAdapter } from "./feishuMcpAdapter.js";
import { FeishuOpenApiAdapter } from "./feishuOpenApiAdapter.js";
import { LarkCliAdapter } from "./larkCliAdapter.js";
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

export class ToolGateway implements FeishuToolGatewayApi {
  private readonly mcp = new FeishuMcpAdapter();
  private readonly fallback = new FeishuOpenApiAdapter();
  private readonly larkCli = new LarkCliAdapter();

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

  private async withLarkCliStrategy<T>(
    name: string,
    runLarkCli: () => Promise<T>,
    runMcp: () => Promise<T>,
    runFallback: () => Promise<T>,
    canRunLarkCli?: () => Promise<boolean>,
  ): Promise<T> {
    if (env.FEISHU_DOC_PUBLISH_STRATEGY === "lark_cli_first" && this.larkCli.isEnabled()) {
      if (canRunLarkCli) {
        const supported = await canRunLarkCli();
        if (!supported) {
          logger.info(`[tool-gateway] ${name} lark-cli capability=false, fallback gateway`);
          return this.withFallback(name, runMcp, runFallback);
        }
      }
      try {
        return await runLarkCli();
      } catch (error) {
        logger.warn(`[tool-gateway] ${name} lark-cli failed, fallback gateway`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return this.withFallback(name, runMcp, runFallback);
  }

  searchDocuments(query: string): Promise<GatewayDocument[]> {
    return this.withLarkCliStrategy(
      "searchDocuments",
      () => this.larkCli.searchDocuments(query),
      () => this.mcp.searchDocuments(query),
      () => this.fallback.searchDocuments(query),
      () => this.larkCli.hasCapability("docsSearch"),
    );
  }

  listDocuments(query?: string): Promise<GatewayDocument[]> {
    return this.withLarkCliStrategy(
      "listDocuments",
      () => this.larkCli.listDocuments(query),
      () => this.mcp.listDocuments(query),
      () => this.fallback.listDocuments(query),
      () => this.larkCli.hasCapability("docsSearch"),
    );
  }

  viewDocument(documentId: string): Promise<GatewayDocument | null> {
    return this.withLarkCliStrategy(
      "viewDocument",
      () => this.larkCli.viewDocument(documentId),
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
    return this.withLarkCliStrategy(
      "createDocument",
      () => this.larkCli.createDocument(input),
      () => this.mcp.createDocument(input),
      () => this.fallback.createDocument(input),
    );
  }

  updateDocument(input: UpdateDocumentInput): Promise<boolean> {
    return this.withLarkCliStrategy(
      "updateDocument",
      () => this.larkCli.updateDocument(input),
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
    return this.withLarkCliStrategy(
      "searchUsers",
      () => this.larkCli.searchUsers(query),
      () => this.mcp.searchUsers(query),
      () => this.fallback.searchUsers(query),
      () => this.larkCli.hasCapability("contactSearch"),
    );
  }

  getUserInfo(userId: string): Promise<GatewayUser | null> {
    return this.withLarkCliStrategy(
      "getUserInfo",
      () => this.larkCli.getUserInfo(userId),
      () => this.mcp.getUserInfo(userId),
      () => this.fallback.getUserInfo(userId),
      () => this.larkCli.hasCapability("contactSearch"),
    );
  }

  createSlides(input: CreateSlidesInput): Promise<GatewaySlides> {
    return this.withLarkCliStrategy(
      "createSlides",
      () => this.larkCli.createSlides(input),
      () => this.mcp.createSlides(input),
      () => this.fallback.createSlides(input),
      () => this.larkCli.hasCapability("slidesPublish"),
    );
  }
}

export const toolGateway = new ToolGateway();
