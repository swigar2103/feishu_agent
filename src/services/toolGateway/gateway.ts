import { env } from "../../config/env.js";
import { logger } from "../../shared/logger.js";
import type { GatewayCapability } from "./capabilities.js";
import { isFallbackableGatewayError } from "./errors.js";
import { FeishuMcpAdapter } from "./feishuMcpAdapter.js";
import { LarkCliAdapter } from "./larkCliAdapter.js";
import { FeishuOpenApiAdapter } from "./feishuOpenApiAdapter.js";
import { getAdapterPriority, type GatewayAdapterName } from "./priority.js";
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

export class ToolGateway implements FeishuToolGatewayApi {
  private readonly mcp = new FeishuMcpAdapter();
  private readonly larkCli = new LarkCliAdapter();
  private readonly openapi = new FeishuOpenApiAdapter();

  private pickAdapter(name: GatewayAdapterName): FeishuToolGatewayApi {
    if (name === "mcp") return this.mcp;
    if (name === "lark_cli") return this.larkCli;
    return this.openapi;
  }

  private isDocumentCapability(capability: GatewayCapability): boolean {
    return capability.startsWith("document.");
  }

  private isDocumentArtifactCapability(capability: GatewayCapability): boolean {
    return capability === "document.create" || capability === "document.update";
  }

  private async canUseLarkCli(capability: GatewayCapability): Promise<boolean> {
    if (!this.larkCli.isEnabled()) return false;
    if (!(await this.larkCli.isRuntimeAvailable())) return false;
    if (capability === "document.search" || capability === "document.list") {
      return this.larkCli.hasCapability("docsSearch");
    }
    if (capability === "user.search" || capability === "user.get") {
      return this.larkCli.hasCapability("contactSearch");
    }
    if (capability === "slides.create") {
      return this.larkCli.hasCapability("slidesPublish");
    }
    return true;
  }

  private isDocPublishCapability(capability: GatewayCapability): boolean {
    return (
      capability === "document.create" ||
      capability === "document.update" ||
      capability === "document.comment.add"
    );
  }

  private shouldDisableFallback(capability: GatewayCapability): boolean {
    return env.FEISHU_DOC_LARK_CLI_HARD_PREFER && this.isDocPublishCapability(capability);
  }

  private getExecutionOrder(capability: GatewayCapability): GatewayAdapterName[] {
    const baseOrder = getAdapterPriority(capability);
    if (this.isDocumentArtifactCapability(capability)) {
      const withoutMcp = baseOrder.filter((name) => name !== "mcp");
      return ["mcp", ...withoutMcp];
    }
    if (
      env.FEISHU_DOC_PUBLISH_STRATEGY === "lark_cli_first" &&
      this.isDocumentCapability(capability)
    ) {
      const withoutCli = baseOrder.filter((name) => name !== "lark_cli");
      return ["lark_cli", ...withoutCli];
    }
    return baseOrder;
  }

  private async executeWithPolicy<T>(
    capability: GatewayCapability,
    operationName: string,
    run: (adapter: FeishuToolGatewayApi) => Promise<T>,
  ): Promise<T> {
    const order = this.getExecutionOrder(capability);
    const startedAt = Date.now();
    let latestError: unknown;

    for (const adapterName of order) {
      if (adapterName === "mcp" && !env.FEISHU_MCP_URL.trim()) {
        logger.info(`[tool-gateway] ${operationName} skip mcp by config`);
        continue;
      }
      if (adapterName === "lark_cli" && !(await this.canUseLarkCli(capability))) {
        logger.info(`[tool-gateway] ${operationName} skip lark-cli by capability`, {
          capability,
        });
        continue;
      }
      const adapter = this.pickAdapter(adapterName);
      try {
        if (this.isDocumentArtifactCapability(capability) && adapterName !== "mcp") {
          logger.warn(`[tool-gateway] ${operationName} use fallback adapter for doc artifact`, {
            capability,
            adapter: adapterName,
          });
        }
        const result = await run(adapter);
        logger.info(`[tool-gateway] ${operationName} success`, {
          capability,
          adapter: adapterName,
          elapsedMs: Date.now() - startedAt,
        });
        return result;
      } catch (error) {
        latestError = error;
        const fallbackable = isFallbackableGatewayError(error);
        logger.warn(`[tool-gateway] ${operationName} failed`, {
          capability,
          adapter: adapterName,
          fallbackable,
          error: error instanceof Error ? error.message : String(error),
        });
        if (!fallbackable) {
          throw error;
        }
        if (this.shouldDisableFallback(capability) && adapterName === "lark_cli") {
          throw error;
        }
      }
    }

    throw latestError instanceof Error
      ? latestError
      : new Error(`[tool-gateway] ${operationName} all adapters failed`);
  }

  searchDocuments(query: string, context?: GatewayRequestContext): Promise<GatewayDocument[]> {
    return this.executeWithPolicy("document.search", "searchDocuments", (adapter) =>
      adapter.searchDocuments(query, context),
    );
  }

  listDocuments(query?: string, context?: GatewayRequestContext): Promise<GatewayDocument[]> {
    return this.executeWithPolicy("document.list", "listDocuments", (adapter) =>
      adapter.listDocuments(query, context),
    );
  }

  viewDocument(documentId: string, context?: GatewayRequestContext): Promise<GatewayDocument | null> {
    return this.executeWithPolicy("document.view", "viewDocument", (adapter) =>
      adapter.viewDocument(documentId, context),
    );
  }

  getFileContent(fileToken: string, context?: GatewayRequestContext): Promise<string> {
    return this.executeWithPolicy("document.fileContent", "getFileContent", (adapter) =>
      adapter.getFileContent(fileToken, context),
    );
  }

  createDocument(input: CreateDocumentInput, context?: GatewayRequestContext): Promise<GatewayDocument> {
    return this.executeWithPolicy("document.create", "createDocument", (adapter) =>
      adapter.createDocument(input, context),
    );
  }

  updateDocument(input: UpdateDocumentInput, context?: GatewayRequestContext): Promise<boolean> {
    return this.executeWithPolicy("document.update", "updateDocument", (adapter) =>
      adapter.updateDocument(input, context),
    );
  }

  getComments(documentId: string, context?: GatewayRequestContext): Promise<GatewayComment[]> {
    return this.executeWithPolicy("document.comment.list", "getComments", (adapter) =>
      adapter.getComments(documentId, context),
    );
  }

  addComment(input: AddCommentInput, context?: GatewayRequestContext): Promise<boolean> {
    return this.executeWithPolicy("document.comment.add", "addComment", (adapter) =>
      adapter.addComment(input, context),
    );
  }

  searchUsers(query: string, context?: GatewayRequestContext): Promise<GatewayUser[]> {
    return this.executeWithPolicy("user.search", "searchUsers", (adapter) =>
      adapter.searchUsers(query, context),
    );
  }

  getUserInfo(userId: string, context?: GatewayRequestContext): Promise<GatewayUser | null> {
    return this.executeWithPolicy("user.get", "getUserInfo", (adapter) =>
      adapter.getUserInfo(userId, context),
    );
  }

  createSlides(input: CreateSlidesInput): Promise<GatewaySlide> {
    return this.executeWithPolicy("slides.create", "createSlides", (adapter) =>
      adapter.createSlides(input),
    );
  }

  queryWhiteboard(token: string): Promise<GatewayWhiteboard | null> {
    return this.executeWithPolicy("whiteboard.query", "queryWhiteboard", (adapter) =>
      adapter.queryWhiteboard(token),
    );
  }

  updateWhiteboard(input: UpdateWhiteboardInput): Promise<boolean> {
    return this.executeWithPolicy("whiteboard.update", "updateWhiteboard", (adapter) =>
      adapter.updateWhiteboard(input),
    );
  }

  sendMessage(input: SendMessageInput): Promise<boolean> {
    return this.executeWithPolicy("message.send", "sendMessage", (adapter) =>
      adapter.sendMessage(input),
    );
  }

  listMessages(input: ListMessagesInput): Promise<GatewayMessage[]> {
    return this.executeWithPolicy("message.list", "listMessages", (adapter) =>
      adapter.listMessages(input),
    );
  }
}

export const toolGateway = new ToolGateway();

