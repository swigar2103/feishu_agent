import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { env } from "../../config/env.js";
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

const execFileAsync = promisify(execFile);

type LarkCliJson = {
  status?: boolean;
  message?: string;
  data?: {
    doc_id?: string;
    title?: string;
    url?: string;
    content?: string;
    docs?: Array<{ doc_id?: string; id?: string; title?: string; summary?: string; url?: string }>;
    users?: Array<{ user_id?: string; id?: string; name?: string; role?: string; department?: string }>;
    user?: { user_id?: string; id?: string; name?: string; role?: string; department?: string };
    slide_id?: string;
    slides_id?: string;
    id?: string;
  };
};

type LarkCliCapabilities = {
  docsSearch: boolean;
  contactSearch: boolean;
  slidesPublish: boolean;
};

function parseCliJson(raw: string): LarkCliJson {
  const text = raw.trim();
  if (!text) {
    throw new Error("lark-cli 未返回 stdout");
  }
  try {
    return JSON.parse(text) as LarkCliJson;
  } catch {
    throw new Error(`lark-cli stdout 非 JSON: ${text.slice(0, 300)}`);
  }
}

function assertStatus(payload: LarkCliJson): void {
  if (payload.status === false) {
    throw new Error(payload.message || "lark-cli 返回 status=false");
  }
}

export class LarkCliAdapter implements FeishuToolGatewayApi {
  private readonly bin = env.LARK_CLI_BIN;
  private readonly timeoutMs = env.LARK_CLI_TIMEOUT_MS;
  private capabilitiesPromise: Promise<LarkCliCapabilities> | null = null;

  isEnabled(): boolean {
    return env.LARK_CLI_ENABLED;
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
    const out = [...this.defaultAsArg(), ...replaced];
    for (const [flag, value] of fallbackArgs) {
      const key = flag.replace(/^--/, "").replace(/-/g, "_");
      if (used.has(key)) continue;
      if (!value?.trim()) continue;
      out.push(flag, value);
    }
    return out;
  }

  private async probeCommand(commandTemplate: string): Promise<boolean> {
    if (!commandTemplate.trim()) return false;
    try {
      const args = [...this.defaultAsArg(), ...this.splitCommand(commandTemplate), "--help"];
      await execFileAsync(this.bin, args, {
        timeout: Math.min(this.timeoutMs, 30_000),
        maxBuffer: 1024 * 1024 * 2,
        windowsHide: true,
      });
      return true;
    } catch {
      return false;
    }
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

  private async runCli(args: string[]): Promise<LarkCliJson> {
    if (!this.isEnabled()) {
      throw new Error("LARK_CLI_ENABLED=false");
    }
    const { stdout } = await execFileAsync(this.bin, args, {
      timeout: this.timeoutMs,
      maxBuffer: 1024 * 1024 * 8,
      windowsHide: true,
    });
    const payload = parseCliJson(stdout);
    assertStatus(payload);
    return payload;
  }

  private defaultAsArg(): string[] {
    return ["--as", env.LARK_CLI_DEFAULT_AS];
  }

  async searchDocuments(query: string): Promise<GatewayDocument[]> {
    if (!(await this.hasCapability("docsSearch"))) {
      throw new Error("LarkCliAdapter capability docsSearch=false");
    }
    const payload = await this.runCli(
      this.buildArgs(
        env.LARK_CLI_CMD_DOCS_SEARCH,
        { query },
        [["--query", query]],
      ),
    );
    const docs = payload.data?.docs ?? [];
    return docs.map((doc, idx) => ({
      id: doc.doc_id ?? doc.id ?? `lark_cli_doc_${idx + 1}`,
      title: doc.title ?? `文档${idx + 1}`,
      summary: doc.summary ?? "",
      url: doc.url,
      source: "lark_cli",
    }));
  }

  async listDocuments(query?: string): Promise<GatewayDocument[]> {
    return this.searchDocuments(query ?? "");
  }

  async viewDocument(documentId: string): Promise<GatewayDocument | null> {
    const payload = await this.runCli([
      ...this.defaultAsArg(),
      "docs",
      "+fetch",
      "--doc",
      documentId,
    ]);
    return {
      id: payload.data?.doc_id ?? documentId,
      title: payload.data?.title ?? `文档-${documentId}`,
      content: payload.data?.content,
      summary: payload.data?.content?.slice(0, 200),
      url: payload.data?.url ?? `https://www.feishu.cn/docx/${documentId}`,
      source: "lark_cli",
    };
  }

  async getFileContent(_fileToken: string): Promise<string> {
    throw new Error("LarkCliAdapter 暂不支持 getFileContent");
  }

  async createDocument(input: CreateDocumentInput): Promise<GatewayDocument> {
    const folderToken = env.LARK_CLI_FOLDER_TOKEN || env.FEISHU_TARGET_FOLDER_TOKEN;
    if (!folderToken.trim()) {
      throw new Error("缺少 LARK_CLI_FOLDER_TOKEN/FEISHU_TARGET_FOLDER_TOKEN");
    }

    const payload = await this.runCli([
      ...this.defaultAsArg(),
      "docs",
      "+create",
      "--folder-token",
      folderToken,
      "--title",
      input.title,
      "--markdown",
      input.content ?? "",
    ]);

    const docId = payload.data?.doc_id;
    if (!docId) {
      throw new Error("lark-cli create 未返回 data.doc_id");
    }
    return {
      id: docId,
      title: payload.data?.title ?? input.title,
      summary: input.content?.slice(0, 200),
      content: input.content,
      url: payload.data?.url ?? `https://www.feishu.cn/docx/${docId}`,
      source: "lark_cli",
    };
  }

  async updateDocument(input: UpdateDocumentInput): Promise<boolean> {
    await this.runCli([
      ...this.defaultAsArg(),
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
    throw new Error("LarkCliAdapter 暂不支持 getComments");
  }

  async addComment(_input: AddCommentInput): Promise<boolean> {
    return false;
  }

  async searchUsers(query: string): Promise<GatewayUser[]> {
    if (!(await this.hasCapability("contactSearch"))) {
      throw new Error("LarkCliAdapter capability contactSearch=false");
    }
    const payload = await this.runCli(
      this.buildArgs(
        env.LARK_CLI_CMD_CONTACT_SEARCH,
        { query },
        [["--query", query]],
      ),
    );
    const users = payload.data?.users ?? [];
    return users.map((item, idx) => ({
      id: item.user_id ?? item.id ?? `lark_cli_user_${idx + 1}`,
      name: item.name ?? `用户${idx + 1}`,
      role: item.role,
      department: item.department,
      source: "lark_cli",
    }));
  }

  async getUserInfo(userId: string): Promise<GatewayUser | null> {
    if (!(await this.hasCapability("contactSearch"))) {
      throw new Error("LarkCliAdapter capability contactSearch=false");
    }
    if (env.LARK_CLI_CMD_CONTACT_GET.trim()) {
      const payload = await this.runCli(
        this.buildArgs(
          env.LARK_CLI_CMD_CONTACT_GET,
          { userId },
          [["--user-id", userId]],
        ),
      );
      const user = payload.data?.user;
      if (!user) return null;
      return {
        id: user.user_id ?? user.id ?? userId,
        name: user.name ?? userId,
        role: user.role,
        department: user.department,
        source: "lark_cli",
      };
    }
    const users = await this.searchUsers(userId);
    return users.find((u) => u.id === userId || u.name === userId) ?? users[0] ?? null;
  }

  async createSlides(input: CreateSlidesInput): Promise<GatewaySlides> {
    if (!(await this.hasCapability("slidesPublish"))) {
      throw new Error("LarkCliAdapter capability slidesPublish=false");
    }
    const payload = await this.runCli(
      this.buildArgs(
        env.LARK_CLI_CMD_SLIDES_CREATE,
        { title: input.title, outline: input.outline },
        [
          ["--title", input.title],
          ["--markdown", input.outline],
        ],
      ),
    );
    const id = payload.data?.slide_id ?? payload.data?.slides_id ?? payload.data?.id;
    return {
      id: id ?? `lark_cli_slides_${Date.now()}`,
      title: payload.data?.title ?? input.title,
      outline: input.outline,
      url: payload.data?.url,
      source: "lark_cli",
    };
  }
}

