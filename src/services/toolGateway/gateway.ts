import { env } from "../../config/env.js";
import { logger } from "../../shared/logger.js";
import type { GatewayCapability } from "./capabilities.js";
import { ToolGatewayError, isFallbackableGatewayError } from "./errors.js";
import { FeishuMcpAdapter } from "./feishuMcpAdapter.js";
import { LarkCliAdapter } from "./larkCliAdapter.js";
import { FeishuOpenApiAdapter } from "./feishuOpenApiAdapter.js";
import { getAdapterPriority, type GatewayAdapterName } from "./priority.js";
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

  /**
   * UAT 创建的云文档只能由同一用户身份更新；OpenAPI 走 TAT 时对用户文档常见 1770032 forBidden。
   */
  private shouldSkipOpenApiForUserScopedMutation(
    capability: GatewayCapability,
    context?: GatewayRequestContext,
  ): boolean {
    if (env.FEISHU_MCP_IDENTITY !== "uat") return false;
    if (!context?.userId?.trim()) return false;
    return this.isDocPublishCapability(capability);
  }

  /**
   * UAT 主链路下，用户态文档读取优先走 MCP/lark-cli。
   * OpenAPI 常以 TAT 读取用户私有文档导致 1770032 forBidden。
   */
  private shouldSkipOpenApiForUserScopedRead(
    capability: GatewayCapability,
    context?: GatewayRequestContext,
  ): boolean {
    if (env.FEISHU_MCP_IDENTITY !== "uat") return false;
    if (!context?.userId?.trim()) return false;
    if (!context.preferUserScope) return false;
    return capability === "document.view" || capability === "document.fileContent";
  }

  private filterOrderForContext(
    order: GatewayAdapterName[],
    capability: GatewayCapability,
    context?: GatewayRequestContext,
  ): GatewayAdapterName[] {
    if (
      !this.shouldSkipOpenApiForUserScopedMutation(capability, context) &&
      !this.shouldSkipOpenApiForUserScopedRead(capability, context)
    ) {
      return order;
    }
    return order.filter((name) => name !== "openapi");
  }

  private async executeWithPolicy<T>(
    capability: GatewayCapability,
    operationName: string,
    run: (adapter: FeishuToolGatewayApi) => Promise<T>,
    context?: GatewayRequestContext,
  ): Promise<T> {
    const order = this.filterOrderForContext(this.getExecutionOrder(capability), capability, context);
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
        if (
          capability === "document.search" &&
          error instanceof ToolGatewayError &&
          error.code === "VALIDATION"
        ) {
          // search 参数已判定不合法时，不再切换后续 adapter 重复打同类失败请求
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

  async searchDocuments(query: string, context?: GatewayRequestContext): Promise<GatewayDocument[]> {
    const docs = await this.executeWithPolicy(
      "document.search",
      "searchDocuments",
      (adapter) => adapter.searchDocuments(query, context),
      context,
    );
    const previewLimit = 16;
    logger.info("[document-search-debug] searchDocuments", {
      query: query.length > 800 ? `${query.slice(0, 800)}…` : query,
      queryLength: query.length,
      resultCount: docs.length,
      userId: context?.userId,
      preferUserScope: context?.preferUserScope,
      documents: docs.slice(0, previewLimit).map((d) => ({
        id: d.id,
        title: d.title,
        url: d.url,
        source: d.source,
      })),
      truncated: docs.length > previewLimit,
    });
    return docs;
  }

  listDocuments(query?: string, context?: GatewayRequestContext): Promise<GatewayDocument[]> {
    return this.executeWithPolicy(
      "document.list",
      "listDocuments",
      (adapter) => adapter.listDocuments(query, context),
      context,
    );
  }

  async viewDocument(documentId: string, context?: GatewayRequestContext): Promise<GatewayDocument | null> {
    const capability = "document.view";
    const order = this.filterOrderForContext(this.getExecutionOrder(capability), capability, context);
    const startedAt = Date.now();
    const minChars = env.FEISHU_VIEW_DOCUMENT_MIN_CHARS;
    let best: GatewayDocument | null = null;
    let bestLen = 0;

    for (const adapterName of order) {
      if (adapterName === "mcp" && !env.FEISHU_MCP_URL.trim()) {
        logger.info("[tool-gateway] viewDocument skip mcp by config");
        continue;
      }
      if (adapterName === "lark_cli" && !(await this.canUseLarkCli(capability))) {
        logger.info("[tool-gateway] viewDocument skip lark-cli by capability", { capability });
        continue;
      }
      const adapter = this.pickAdapter(adapterName);
      try {
        const doc = await adapter.viewDocument(documentId, context);
        const len = (doc?.content ?? "").trim().length;
        if (doc && len > bestLen) {
          best = doc;
          bestLen = len;
        }
        if (doc && len >= minChars) {
          logger.info("[tool-gateway] viewDocument success", {
            capability,
            adapter: adapterName,
            elapsedMs: Date.now() - startedAt,
            contentChars: len,
            minChars,
          });
          return doc;
        }
        if (doc && len > 0) {
          logger.warn("[tool-gateway] viewDocument short body, try next adapter", {
            capability,
            adapter: adapterName,
            contentChars: len,
            minChars,
          });
        }
      } catch (error) {
        const fallbackable = isFallbackableGatewayError(error);
        logger.warn("[tool-gateway] viewDocument failed", {
          capability,
          adapter: adapterName,
          fallbackable,
          error: error instanceof Error ? error.message : String(error),
        });
        if (!fallbackable) {
          throw error;
        }
      }
    }

    if (best) {
      logger.info("[tool-gateway] viewDocument success (best effort below minChars)", {
        capability,
        elapsedMs: Date.now() - startedAt,
        contentChars: bestLen,
        minChars,
      });
    }
    return best;
  }

  getFileContent(fileToken: string, context?: GatewayRequestContext): Promise<string> {
    return this.executeWithPolicy(
      "document.fileContent",
      "getFileContent",
      (adapter) => adapter.getFileContent(fileToken, context),
      context,
    );
  }

  createDocument(input: CreateDocumentInput, context?: GatewayRequestContext): Promise<GatewayDocument> {
    return this.executeWithPolicy(
      "document.create",
      "createDocument",
      (adapter) => adapter.createDocument(input, context),
      context,
    );
  }

  updateDocument(input: UpdateDocumentInput, context?: GatewayRequestContext): Promise<boolean> {
    return this.executeWithPolicy(
      "document.update",
      "updateDocument",
      (adapter) => adapter.updateDocument(input, context),
      context,
    );
  }

  getComments(documentId: string, context?: GatewayRequestContext): Promise<GatewayComment[]> {
    return this.executeWithPolicy(
      "document.comment.list",
      "getComments",
      (adapter) => adapter.getComments(documentId, context),
      context,
    );
  }

  addComment(input: AddCommentInput, context?: GatewayRequestContext): Promise<boolean> {
    return this.executeWithPolicy(
      "document.comment.add",
      "addComment",
      (adapter) => adapter.addComment(input, context),
      context,
    );
  }

  searchUsers(query: string, context?: GatewayRequestContext): Promise<GatewayUser[]> {
    return this.executeWithPolicy(
      "user.search",
      "searchUsers",
      (adapter) => adapter.searchUsers(query, context),
      context,
    );
  }

  getUserInfo(userId: string, context?: GatewayRequestContext): Promise<GatewayUser | null> {
    return this.executeWithPolicy(
      "user.get",
      "getUserInfo",
      (adapter) => adapter.getUserInfo(userId, context),
      context,
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

  getRootFolderMeta(context?: GatewayRequestContext): Promise<GatewayRootFolderMeta> {
    return this.executeWithPolicy(
      "drive.root.meta",
      "getRootFolderMeta",
      (adapter) => adapter.getRootFolderMeta(context),
      context,
    );
  }

  getFolderMeta(folderToken: string, context?: GatewayRequestContext): Promise<GatewayFolderMeta> {
    return this.executeWithPolicy(
      "drive.folder.meta",
      "getFolderMeta",
      (adapter) => adapter.getFolderMeta(folderToken, context),
      context,
    );
  }

  listFolderItems(folderToken: string, context?: GatewayRequestContext): Promise<GatewayDriveItem[]> {
    return this.executeWithPolicy(
      "drive.folder.list",
      "listFolderItems",
      (adapter) => adapter.listFolderItems(folderToken, context),
      context,
    );
  }

  createFolder(
    input: { parentFolderToken: string; folderName: string },
    context?: GatewayRequestContext,
  ): Promise<GatewayFolderMeta> {
    return this.executeWithPolicy(
      "drive.folder.create",
      "createFolder",
      (adapter) => adapter.createFolder(input, context),
      context,
    );
  }

  moveFile(
    input: { fileToken: string; targetFolderToken: string },
    context?: GatewayRequestContext,
  ): Promise<GatewayDriveTaskStatus | null> {
    return this.executeWithPolicy(
      "drive.file.move",
      "moveFile",
      (adapter) => adapter.moveFile(input, context),
      context,
    );
  }

  copyFile(
    input: { fileToken: string; targetFolderToken: string; fileName?: string; copyAsDocx?: boolean },
    context?: GatewayRequestContext,
  ): Promise<{ fileToken?: string; url?: string; task?: GatewayDriveTaskStatus | null }> {
    return this.executeWithPolicy(
      "drive.file.copy",
      "copyFile",
      (adapter) => adapter.copyFile(input, context),
      context,
    );
  }

  deleteFile(
    input: { fileToken: string },
    context?: GatewayRequestContext,
  ): Promise<GatewayDriveTaskStatus | null> {
    return this.executeWithPolicy(
      "drive.file.delete",
      "deleteFile",
      (adapter) => adapter.deleteFile(input, context),
      context,
    );
  }

  checkTask(
    input: { ticket: string },
    context?: GatewayRequestContext,
  ): Promise<GatewayDriveTaskStatus> {
    return this.executeWithPolicy(
      "drive.task.check",
      "checkTask",
      (adapter) => adapter.checkTask(input, context),
      context,
    );
  }

  uploadImageMedia(
    input: UploadImageMediaInput,
    context?: GatewayRequestContext,
  ): Promise<UploadImageMediaResult> {
    return this.executeWithPolicy(
      "media.upload.image",
      "uploadImageMedia",
      (adapter) => adapter.uploadImageMedia(input, context),
      context,
    );
  }

  insertDocxImageBlock(
    input: DocxImageBlockInsertInput,
    context?: GatewayRequestContext,
  ): Promise<DocxBlockInsertResult> {
    return this.executeWithPolicy(
      "docx.block.image.insert",
      "insertDocxImageBlock",
      (adapter) => adapter.insertDocxImageBlock(input, context),
      context,
    );
  }

  insertDocxEmbedBlock(
    input: DocxEmbedBlockInsertInput,
    context?: GatewayRequestContext,
  ): Promise<DocxBlockInsertResult> {
    return this.executeWithPolicy(
      "docx.block.embed.insert",
      "insertDocxEmbedBlock",
      (adapter) => adapter.insertDocxEmbedBlock(input, context),
      context,
    );
  }

  createSheet(
    input: SheetCreateInput,
    context?: GatewayRequestContext,
  ): Promise<SheetCreateResult> {
    return this.executeWithPolicy(
      "sheet.create",
      "createSheet",
      (adapter) => adapter.createSheet(input, context),
      context,
    );
  }

  writeSheet(input: SheetWriteInput, context?: GatewayRequestContext): Promise<boolean> {
    return this.executeWithPolicy(
      "sheet.write",
      "writeSheet",
      (adapter) => adapter.writeSheet(input, context),
      context,
    );
  }

  createSheetChart(
    input: SheetChartInput,
    context?: GatewayRequestContext,
  ): Promise<SheetChartResult> {
    return this.executeWithPolicy(
      "sheet.chart.create",
      "createSheetChart",
      (adapter) => adapter.createSheetChart(input, context),
      context,
    );
  }

  createWhiteboard(
    input: WhiteboardCreateInput,
    context?: GatewayRequestContext,
  ): Promise<WhiteboardCreateResult> {
    return this.executeWithPolicy(
      "whiteboard.create",
      "createWhiteboard",
      (adapter) => adapter.createWhiteboard(input, context),
      context,
    );
  }

  /**
   * 获取文档大纲（章节标题列表）。
   * 优先走 lark-cli `docs +fetch --scope outline`，失败时返回空数组（不抛出）。
   */
  async fetchDocumentOutline(documentId: string, context?: GatewayRequestContext): Promise<string[]> {
    try {
      return await this.executeWithPolicy(
        "document.outline",
        "fetchDocumentOutline",
        (adapter) => adapter.fetchDocumentOutline(documentId, context),
        context,
      );
    } catch {
      return [];
    }
  }
}

export const toolGateway = new ToolGateway();

