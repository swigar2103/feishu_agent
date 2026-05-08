import { logger } from "../../shared/logger.js";
import { env } from "../../config/env.js";
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
  GatewayUser,
  GatewayRootFolderMeta,
  GatewaySlide,
  GatewayWhiteboard,
  GatewayRequestContext,
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
import { execLarkCli } from "./larkCliExecutor.js";
import {
  parseCliJson,
  parseDocuments,
  parseMessages,
  parseSingleUser,
  parseSlides,
  parseUsers,
  parseWhiteboard,
} from "./larkCliParsers.js";

type LarkCliCapabilities = {
  docsSearch: boolean;
  contactSearch: boolean;
  slidesPublish: boolean;
};

function stringifyJson(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

function buildMarkdownCreateContent(title: string, body?: string): string {
  const trimmedBody = (body ?? "").trim();
  if (!trimmedBody) {
    return `# ${title}`;
  }
  if (trimmedBody.startsWith("#")) {
    return trimmedBody;
  }
  return `# ${title}\n\n${trimmedBody}`;
}

/**
 * 从 lark-cli `docs +fetch --scope outline` 的输出中提取章节标题列表。
 * lark-cli 可能返回 { outline: "## 摘要\n## 进展" } 或 { items: [...] } 等多种形态。
 */
function extractOutlineSections(raw: unknown): string[] {
  if (!raw || typeof raw !== "object") {
    if (typeof raw === "string") {
      return (raw as string)
        .split(/\r?\n/)
        .map((line) => line.replace(/^#+\s*/, "").trim())
        .filter(Boolean);
    }
    return [];
  }
  const rec = raw as Record<string, unknown>;

  // 形态1：{ outline: "## 章节1\n## 章节2" }
  if (typeof rec["outline"] === "string") {
    return (rec["outline"] as string)
      .split(/\r?\n/)
      .map((line) => line.replace(/^#+\s*/, "").trim())
      .filter(Boolean);
  }

  // 形态2：{ items: [{ title: "..." }, ...] }
  if (Array.isArray(rec["items"])) {
    return (rec["items"] as unknown[])
      .map((item) => {
        if (typeof item === "string") return item.trim();
        if (item && typeof item === "object") {
          const o = item as Record<string, unknown>;
          const t = o["title"] ?? o["heading"] ?? o["name"] ?? o["text"] ?? "";
          return typeof t === "string" ? t.trim() : "";
        }
        return "";
      })
      .filter(Boolean);
  }

  // 形态3：{ sections: [...] }
  if (Array.isArray(rec["sections"])) {
    return (rec["sections"] as unknown[])
      .map((s) => {
        if (typeof s === "string") return s.trim();
        if (s && typeof s === "object") {
          const o = s as Record<string, unknown>;
          const t = o["title"] ?? o["heading"] ?? o["name"] ?? "";
          return typeof t === "string" ? t.trim() : "";
        }
        return "";
      })
      .filter(Boolean);
  }

  // 形态4：第一层 key 即为 data/result 包装
  const firstVal = Object.values(rec)[0];
  if (firstVal && typeof firstVal === "object" && !Array.isArray(firstVal)) {
    return extractOutlineSections(firstVal);
  }

  return [];
}

function classifyCliFailure(stderr: string, exitCode: number): ToolGatewayError {
  const text = stderr.toLowerCase();
  if (text.includes("unknown command") || text.includes("not found")) {
    return new ToolGatewayError("NOT_SUPPORTED", "lark-cli 不支持当前子命令", {
      causeText: stderr,
    });
  }
  if (text.includes("required") || text.includes("invalid") || text.includes("must")) {
    return new ToolGatewayError("VALIDATION", "lark-cli 参数校验失败", {
      causeText: stderr,
    });
  }
  return new ToolGatewayError("UPSTREAM_TEMPORARY", `lark-cli 调用失败，exitCode=${exitCode}`, {
    causeText: stderr,
  });
}

export class LarkCliAdapter implements FeishuToolGatewayApi {
  private capabilitiesPromise: Promise<LarkCliCapabilities> | null = null;
  private runtimeReadyPromise: Promise<boolean> | null = null;

  isEnabled(): boolean {
    return env.LARK_CLI_ENABLED !== "false";
  }

  private withIdentity(args: string[], identityAs?: "bot" | "user"): string[] {
    return ["--as", identityAs ?? env.LARK_CLI_DEFAULT_AS, ...args];
  }

  private splitCommand(command: string): string[] {
    const matches = command.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
    return matches.map((s) => s.replace(/^"(.*)"$/, "$1"));
  }

  private buildArgs(
    commandTemplate: string,
    values: Record<string, string>,
    fallbackArgs: Array<[string, string]>,
  ): string[] {
    const tokens = this.splitCommand(commandTemplate);
    const used = new Set<string>();
    const replaced = tokens.map((token) =>
      token.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key: string) => {
        used.add(key);
        return values[key] ?? "";
      }),
    );
    const out = [...replaced];
    for (const [flag, value] of fallbackArgs) {
      const key = flag.replace(/^--/, "").replace(/-/g, "_");
      if (used.has(key)) continue;
      if (!value?.trim()) continue;
      out.push(flag, value);
    }
    return out;
  }

  private async runCli(args: string[], identityAs?: "bot" | "user"): Promise<unknown> {
    const result = await execLarkCli(this.withIdentity([...args, "--format", "json"], identityAs));
    if (result.exitCode !== 0) {
      throw classifyCliFailure(result.stderr, result.exitCode);
    }
    logger.info("[tool-gateway] lark-cli command success", {
      command: result.command,
      args: result.args.join(" "),
      elapsedMs: result.elapsedMs,
    });
    if (result.stderr.trim()) {
      logger.warn("[tool-gateway] lark-cli stderr", {
        stderr: result.stderr.slice(0, 200),
      });
    }
    return parseCliJson(result.stdout);
  }

  private async runtimeReady(): Promise<boolean> {
    if (!this.runtimeReadyPromise) {
      this.runtimeReadyPromise = execLarkCli(["--version"], 10_000)
        .then((res) => res.exitCode === 0)
        .catch(() => false);
    }
    return this.runtimeReadyPromise;
  }

  private inferIdentityFromContext(context?: GatewayRequestContext): "bot" | "user" | undefined {
    if (context?.preferUserScope) return "user";
    return undefined;
  }

  private async probeCommand(commandTemplate: string): Promise<boolean> {
    if (!commandTemplate.trim()) return false;
    const helpArgs = this.splitCommand(commandTemplate);
    const result = await execLarkCli(this.withIdentity([...helpArgs, "--help"]), 20_000).catch(
      () => null,
    );
    return Boolean(result && result.exitCode === 0);
  }

  private async probeCapabilities(): Promise<LarkCliCapabilities> {
    if (!this.isEnabled()) {
      return { docsSearch: false, contactSearch: false, slidesPublish: false };
    }
    if (!(await this.runtimeReady())) {
      return { docsSearch: false, contactSearch: false, slidesPublish: false };
    }
    return {
      docsSearch: await this.probeCommand(env.LARK_CLI_CMD_DOCS_SEARCH),
      contactSearch: await this.probeCommand(env.LARK_CLI_CMD_CONTACT_SEARCH),
      slidesPublish: await this.probeCommand(env.LARK_CLI_CMD_SLIDES_CREATE),
    };
  }

  async hasCapability(name: keyof LarkCliCapabilities): Promise<boolean> {
    if (!this.capabilitiesPromise) {
      this.capabilitiesPromise = this.probeCapabilities();
    }
    const caps = await this.capabilitiesPromise;
    return caps[name];
  }

  async isRuntimeAvailable(): Promise<boolean> {
    return this.runtimeReady();
  }

  async searchDocuments(query: string, context?: GatewayRequestContext): Promise<GatewayDocument[]> {
    const payload = await this.runCli(
      this.buildArgs(env.LARK_CLI_CMD_DOCS_SEARCH, { query }, [["--query", query]]),
      this.inferIdentityFromContext(context),
    );
    return parseDocuments(payload);
  }

  async listDocuments(query?: string, context?: GatewayRequestContext): Promise<GatewayDocument[]> {
    return this.searchDocuments(query ?? "", context);
  }

  async viewDocument(documentId: string, context?: GatewayRequestContext): Promise<GatewayDocument | null> {
    const payload = await this.runCli(
      ["docs", "+fetch", "--doc", documentId],
      this.inferIdentityFromContext(context),
    );
    return parseDocuments(payload)[0] ?? null;
  }

  async fetchDocumentOutline(documentId: string, context?: GatewayRequestContext): Promise<string[]> {
    try {
      const result = await execLarkCli(
        this.withIdentity(
          ["docs", "+fetch", "--api-version", "v2", "--scope", "outline", "--doc", documentId, "--format", "json"],
          this.inferIdentityFromContext(context),
        ),
      );
      if (result.exitCode !== 0) return [];
      const raw = parseCliJson(result.stdout);
      return extractOutlineSections(raw);
    } catch {
      return [];
    }
  }

  async getFileContent(fileToken: string, context?: GatewayRequestContext): Promise<string> {
    const doc = await this.viewDocument(fileToken, context);
    return doc?.content ?? "";
  }

  async createDocument(input: CreateDocumentInput, context?: GatewayRequestContext): Promise<GatewayDocument> {
    const folderToken = env.LARK_CLI_FOLDER_TOKEN || env.FEISHU_TARGET_FOLDER_TOKEN;
    const identityAs = this.inferIdentityFromContext(context) ?? (input.preferUserScope ? "user" : undefined);
    const args = [
      "docs",
      "+create",
      "--api-version",
      "v2",
      "--doc-format",
      "markdown",
      "--content",
      buildMarkdownCreateContent(input.title, input.content),
    ];
    if (folderToken.trim()) {
      args.push("--parent-token", folderToken);
    } else if (identityAs === "user" || env.LARK_CLI_DEFAULT_AS === "user") {
      // user 身份下，允许直接落到个人知识库，避免强制要求手工配置 folder token。
      args.push("--parent-position", "my_library");
    } else {
      throw new ToolGatewayError(
        "NOT_CONFIGURED",
        "lark-cli(bot) 缺少目标目录：请配置 LARK_CLI_FOLDER_TOKEN/FEISHU_TARGET_FOLDER_TOKEN，或改用 --as user",
      );
    }
    const payload = await this.runCli(args, identityAs);
    return (
      parseDocuments(payload)[0] ?? {
        id: `lark_cli_doc_${Date.now()}`,
        title: input.title,
        content: input.content,
        summary: input.content?.slice(0, 200),
        source: "lark_cli",
      }
    );
  }

  async updateDocument(input: UpdateDocumentInput, context?: GatewayRequestContext): Promise<boolean> {
    await this.runCli([
      "docs",
      "+update",
      "--doc",
      input.documentId,
      "--mode",
      "overwrite",
      "--markdown",
      input.content,
    ], this.inferIdentityFromContext(context));
    return true;
  }

  async getComments(_documentId: string, _context?: GatewayRequestContext): Promise<GatewayComment[]> {
    throw new ToolGatewayError("NOT_SUPPORTED", "lark-cli 当前未封装评论查询命令");
  }

  async addComment(input: AddCommentInput, context?: GatewayRequestContext): Promise<boolean> {
    await this.runCli([
      "drive",
      "+add-comment",
      "--file-token",
      input.documentId,
      "--content",
      input.content,
    ], this.inferIdentityFromContext(context));
    return true;
  }

  async searchUsers(query: string, context?: GatewayRequestContext): Promise<GatewayUser[]> {
    const payload = await this.runCli(
      this.buildArgs(env.LARK_CLI_CMD_CONTACT_SEARCH, { query }, [["--query", query]]),
      this.inferIdentityFromContext(context),
    );
    return parseUsers(payload);
  }

  async getUserInfo(userId: string, context?: GatewayRequestContext): Promise<GatewayUser | null> {
    if (env.LARK_CLI_CMD_CONTACT_GET.trim()) {
      const payload = await this.runCli(
        this.buildArgs(env.LARK_CLI_CMD_CONTACT_GET, { userId }, [["--user-id", userId]]),
        this.inferIdentityFromContext(context),
      );
      return parseSingleUser(payload);
    }
    const users = await this.searchUsers(userId, context);
    return users.find((item) => item.id === userId || item.name === userId) ?? users[0] ?? null;
  }

  async createSlides(input: CreateSlidesInput): Promise<GatewaySlide> {
    const payload = await this.runCli(
      this.buildArgs(
        env.LARK_CLI_CMD_SLIDES_CREATE,
        { title: input.title, outline: input.outline ?? "" },
        [
          ["--title", input.title],
          ["--markdown", input.outline ?? ""],
        ],
      ),
    );
    return parseSlides(payload);
  }

  async queryWhiteboard(token: string): Promise<GatewayWhiteboard | null> {
    const payload = await this.runCli(["whiteboard", "+query", "--token", token]);
    return parseWhiteboard(payload, token);
  }

  async updateWhiteboard(input: UpdateWhiteboardInput): Promise<boolean> {
    await this.runCli([
      "whiteboard",
      "+update",
      "--token",
      input.token,
      "--content",
      input.content,
      "--syntax",
      input.syntax ?? "mermaid",
    ]);
    return true;
  }

  async sendMessage(input: SendMessageInput): Promise<boolean> {
    if (!input.chatId && !input.userId) {
      throw new ToolGatewayError("VALIDATION", "sendMessage 需要 chatId 或 userId");
    }
    const args = [
      "im",
      "+messages-send",
      "--msg-type",
      input.msgType ?? "text",
      "--content",
      input.content,
    ];
    if (input.chatId) args.push("--chat-id", input.chatId);
    if (input.userId) args.push("--user-id", input.userId);
    await this.runCli(args);
    return true;
  }

  async listMessages(input: ListMessagesInput): Promise<GatewayMessage[]> {
    if (!input.chatId && !input.userId) {
      throw new ToolGatewayError("VALIDATION", "listMessages 需要 chatId 或 userId");
    }
    const args = ["im", "+chat-messages-list"];
    if (input.chatId) args.push("--chat-id", input.chatId);
    if (input.userId) args.push("--user-id", input.userId);
    if (typeof input.limit === "number" && input.limit > 0) {
      args.push("--page-size", String(input.limit));
    }
    const payload = await this.runCli(args);
    return parseMessages(payload);
  }

  async getRootFolderMeta(_context?: GatewayRequestContext): Promise<GatewayRootFolderMeta> {
    throw new ToolGatewayError("NOT_SUPPORTED", "lark-cli 当前未封装 drive root meta 命令");
  }

  async getFolderMeta(_folderToken: string, _context?: GatewayRequestContext): Promise<GatewayFolderMeta> {
    throw new ToolGatewayError("NOT_SUPPORTED", "lark-cli 当前未封装 folder meta 命令");
  }

  async listFolderItems(
    _folderToken: string,
    _context?: GatewayRequestContext,
  ): Promise<GatewayDriveItem[]> {
    throw new ToolGatewayError("NOT_SUPPORTED", "lark-cli 当前未封装 folder list 命令");
  }

  async createFolder(
    _input: { parentFolderToken: string; folderName: string },
    _context?: GatewayRequestContext,
  ): Promise<GatewayFolderMeta> {
    throw new ToolGatewayError("NOT_SUPPORTED", "lark-cli 当前未封装 create folder 命令");
  }

  async moveFile(
    _input: { fileToken: string; targetFolderToken: string },
    _context?: GatewayRequestContext,
  ): Promise<GatewayDriveTaskStatus | null> {
    throw new ToolGatewayError("NOT_SUPPORTED", "lark-cli 当前未封装 move file 命令");
  }

  async copyFile(
    _input: { fileToken: string; targetFolderToken: string; fileName?: string; copyAsDocx?: boolean },
    _context?: GatewayRequestContext,
  ): Promise<{ fileToken?: string; url?: string; task?: GatewayDriveTaskStatus | null }> {
    throw new ToolGatewayError("NOT_SUPPORTED", "lark-cli 当前未封装 copy file 命令");
  }

  async deleteFile(
    _input: { fileToken: string; fileType?: string },
    _context?: GatewayRequestContext,
  ): Promise<GatewayDriveTaskStatus | null> {
    throw new ToolGatewayError("NOT_SUPPORTED", "lark-cli 当前未封装 delete file 命令");
  }

  async checkTask(
    _input: { ticket: string },
    _context?: GatewayRequestContext,
  ): Promise<GatewayDriveTaskStatus> {
    throw new ToolGatewayError("NOT_SUPPORTED", "lark-cli 当前未封装 task check 命令");
  }

  async uploadImageMedia(
    _input: UploadImageMediaInput,
    _context?: GatewayRequestContext,
  ): Promise<UploadImageMediaResult> {
    throw new ToolGatewayError("NOT_SUPPORTED", "lark-cli 当前未封装 media upload 命令");
  }

  async insertDocxImageBlock(
    _input: DocxImageBlockInsertInput,
    _context?: GatewayRequestContext,
  ): Promise<DocxBlockInsertResult> {
    throw new ToolGatewayError("NOT_SUPPORTED", "lark-cli 当前未封装 docx image block 命令");
  }

  async insertDocxEmbedBlock(
    _input: DocxEmbedBlockInsertInput,
    _context?: GatewayRequestContext,
  ): Promise<DocxBlockInsertResult> {
    throw new ToolGatewayError("NOT_SUPPORTED", "lark-cli 当前未封装 docx embed block 命令");
  }

  async createSheet(
    input: SheetCreateInput,
    _context?: GatewayRequestContext,
  ): Promise<SheetCreateResult> {
    const args = ["sheets", "+create", "--title", input.title];
    if (input.parentFolderToken) {
      args.push("--folder-token", input.parentFolderToken);
    }
    const payload = (await this.runCli(args)) as
      | { spreadsheet_token?: string; sheet_id?: string; url?: string }
      | null;
    if (!payload?.spreadsheet_token) {
      throw new ToolGatewayError("INVALID_RESPONSE", "lark-cli sheets +create 未返回 spreadsheet_token");
    }
    return {
      spreadsheetToken: payload.spreadsheet_token,
      sheetId: payload.sheet_id,
      url: payload.url,
      source: "lark_cli",
    };
  }

  async writeSheet(input: SheetWriteInput, _context?: GatewayRequestContext): Promise<boolean> {
    await this.runCli([
      "sheets",
      "+write",
      "--spreadsheet-token",
      input.spreadsheetToken,
      "--sheet-id",
      input.sheetId,
      "--range",
      input.range,
      "--values",
      JSON.stringify(input.values),
    ]);
    return true;
  }

  async createSheetChart(
    _input: SheetChartInput,
    _context?: GatewayRequestContext,
  ): Promise<SheetChartResult> {
    throw new ToolGatewayError(
      "NOT_SUPPORTED",
      "lark-cli 当前未封装电子表格图表创建命令；请改用 OpenAPI 或上传图片回退",
    );
  }

  async createWhiteboard(
    input: WhiteboardCreateInput,
    _context?: GatewayRequestContext,
  ): Promise<WhiteboardCreateResult> {
    const args = [
      "whiteboard",
      "+create",
      "--title",
      input.title,
      "--syntax",
      input.syntax,
      "--content",
      input.body,
    ];
    if (input.parentFolderToken) {
      args.push("--parent-token", input.parentFolderToken);
    }
    const payload = (await this.runCli(args)) as { token?: string; url?: string } | null;
    if (!payload?.token) {
      throw new ToolGatewayError(
        "INVALID_RESPONSE",
        "lark-cli whiteboard +create 未返回 token；请检查 lark-whiteboard skill 安装",
      );
    }
    return {
      whiteboardToken: payload.token,
      url: payload.url,
      source: "lark_cli",
    };
  }
}

