import { logger } from "../../shared/logger.js";
import { env } from "../../config/env.js";
import type {
  AddCommentInput,
  CreateDocumentInput,
  CreateSlidesInput,
  FeishuToolGatewayApi,
  GatewayComment,
  GatewayDocument,
  GatewayMessage,
  GatewaySlide,
  GatewayUser,
  GatewayWhiteboard,
  ListMessagesInput,
  SendMessageInput,
  UpdateDocumentInput,
  UpdateWhiteboardInput,
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

  isEnabled(): boolean {
    return env.LARK_CLI_ENABLED !== "false";
  }

  private withDefaultAs(args: string[]): string[] {
    return ["--as", env.LARK_CLI_DEFAULT_AS, ...args];
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

  private async runCli(args: string[]): Promise<unknown> {
    const result = await execLarkCli(this.withDefaultAs([...args, "--format", "json"]));
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

  private async probeCommand(commandTemplate: string): Promise<boolean> {
    if (!commandTemplate.trim()) return false;
    const helpArgs = this.splitCommand(commandTemplate);
    const result = await execLarkCli(this.withDefaultAs([...helpArgs, "--help"]), 20_000).catch(
      () => null,
    );
    return Boolean(result && result.exitCode === 0);
  }

  private async probeCapabilities(): Promise<LarkCliCapabilities> {
    if (!this.isEnabled()) {
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

  async searchDocuments(query: string): Promise<GatewayDocument[]> {
    const payload = await this.runCli(
      this.buildArgs(env.LARK_CLI_CMD_DOCS_SEARCH, { query }, [["--query", query]]),
    );
    return parseDocuments(payload);
  }

  async listDocuments(query?: string): Promise<GatewayDocument[]> {
    return this.searchDocuments(query ?? "");
  }

  async viewDocument(documentId: string): Promise<GatewayDocument | null> {
    const payload = await this.runCli(["docs", "+fetch", "--doc", documentId]);
    return parseDocuments(payload)[0] ?? null;
  }

  async getFileContent(fileToken: string): Promise<string> {
    const doc = await this.viewDocument(fileToken);
    return doc?.content ?? "";
  }

  async createDocument(input: CreateDocumentInput): Promise<GatewayDocument> {
    const folderToken = env.LARK_CLI_FOLDER_TOKEN || env.FEISHU_TARGET_FOLDER_TOKEN;
    if (!folderToken.trim()) {
      throw new ToolGatewayError("VALIDATION", "缺少 LARK_CLI_FOLDER_TOKEN/FEISHU_TARGET_FOLDER_TOKEN");
    }
    const payload = await this.runCli([
      "docs",
      "+create",
      "--folder-token",
      folderToken,
      "--title",
      input.title,
      "--markdown",
      input.content ?? "",
    ]);
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

  async updateDocument(input: UpdateDocumentInput): Promise<boolean> {
    await this.runCli([
      "docs",
      "+update",
      "--doc",
      input.documentId,
      "--mode",
      "overwrite",
      "--markdown",
      input.content,
    ]);
    return true;
  }

  async getComments(_documentId: string): Promise<GatewayComment[]> {
    throw new ToolGatewayError("NOT_SUPPORTED", "lark-cli 当前未封装评论查询命令");
  }

  async addComment(input: AddCommentInput): Promise<boolean> {
    await this.runCli([
      "drive",
      "+add-comment",
      "--file-token",
      input.documentId,
      "--content",
      input.content,
    ]);
    return true;
  }

  async searchUsers(query: string): Promise<GatewayUser[]> {
    const payload = await this.runCli(
      this.buildArgs(env.LARK_CLI_CMD_CONTACT_SEARCH, { query }, [["--query", query]]),
    );
    return parseUsers(payload);
  }

  async getUserInfo(userId: string): Promise<GatewayUser | null> {
    if (env.LARK_CLI_CMD_CONTACT_GET.trim()) {
      const payload = await this.runCli(
        this.buildArgs(env.LARK_CLI_CMD_CONTACT_GET, { userId }, [["--user-id", userId]]),
      );
      return parseSingleUser(payload);
    }
    const users = await this.searchUsers(userId);
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
}

