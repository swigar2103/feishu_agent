import { getFeishuMvpConfig } from "../../integrations/feishu/feishuConfig.js";
import {
  createTextChildrenBlocks,
  listAllDocumentBlocks,
  replaceBlockWithPlainText,
} from "../../integrations/feishu/docxBlocks.js";
import { fetchDocxRawText } from "../../integrations/feishu/docxRawContent.js";
import { feishuHttpFetch } from "../../integrations/feishu/httpFetch.js";
import { getTenantAccessToken } from "../../integrations/feishu/token.js";
import { ensureUserOAuthReady } from "../../integrations/feishu/userOAuthRefresh.js";
import { parseJsonFromMd } from "../retrieval/mdParser.js";
import { ResourcePoolStore } from "../../storage/resourcePoolStore.js";
import { ToolGatewayError } from "./errors.js";
import type {
  AddCommentInput,
  CreateDocumentInput,
  CreateSlidesInput,
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
  UpdateDocumentInput,
  UpdateWhiteboardInput,
} from "./types.js";

type AssetRecord = {
  sourceId: string;
  sourceType: "message" | "doc" | "table";
  content: string;
};

function normalizeDocxTokenForOpenApi(raw: string): string {
  const s = raw.trim().split("#")[0] ?? "";
  if (!s) return "";
  if (s.startsWith("http://") || s.startsWith("https://")) {
    try {
      const u = new URL(s);
      const segs = u.pathname.split("/").filter(Boolean);
      const idx = segs.indexOf("docx");
      // OpenAPI raw_content 仅支持 docx 文档，不接受 wiki token。
      if (idx >= 0 && segs[idx + 1]) return segs[idx + 1]!;
      return "";
    } catch {
      return s;
    }
  }
  if (s.includes("/")) {
    const parts = s.split("/").filter(Boolean);
    const idx = parts.indexOf("docx");
    if (idx >= 0 && parts[idx + 1]) return parts[idx + 1]!;
    return parts[parts.length - 1] ?? s;
  }
  return s;
}

type UserRecord = {
  id: string;
  name: string;
  role?: string;
  department?: string;
};

export class FeishuOpenApiAdapter implements FeishuToolGatewayApi {
  private readonly poolStore = new ResourcePoolStore();

  private async getUserAccessToken(context?: GatewayRequestContext): Promise<string> {
    const userId = context?.userId?.trim();
    if (!userId) {
      throw new ToolGatewayError("VALIDATION", "drive 操作需要 GatewayRequestContext.userId");
    }
    const ensured = await ensureUserOAuthReady(userId);
    const token = ensured.record?.accessToken?.trim();
    if (!token) {
      throw new ToolGatewayError("PERMISSION_DENIED", `用户 ${userId} 无有效飞书用户访问令牌`);
    }
    return token;
  }

  private async requestDriveData<T>(
    path: string,
    context: GatewayRequestContext | undefined,
    init?: RequestInit,
  ): Promise<T> {
    const token = await this.getUserAccessToken(context);
    const res = await feishuHttpFetch(`${getFeishuMvpConfig().baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
        ...(init?.headers ?? {}),
      },
    });
    const body = (await res.json()) as {
      code?: number;
      msg?: string;
      data?: T;
    };
    if (!res.ok || body.code !== 0 || !body.data) {
      throw new ToolGatewayError("UPSTREAM_TEMPORARY", `OpenAPI drive 请求失败: ${path}`, {
        causeText: body.msg ?? String(res.status),
      });
    }
    return body.data;
  }

  private toDriveItems(raw: unknown): GatewayDriveItem[] {
    if (!raw || typeof raw !== "object") return [];
    const data = raw as Record<string, unknown>;
    const files = Array.isArray(data.files) ? data.files : [];
    const items: GatewayDriveItem[] = [];
    for (const item of files) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      const token = String(row.token ?? row.file_token ?? row.obj_token ?? "").trim();
      const name = String(row.name ?? row.title ?? "").trim();
      if (!token || !name) continue;
      const type = String(row.type ?? row.file_type ?? row.obj_type ?? "unknown");
      const modifiedRaw = row.modified_time ?? row.edit_time ?? row.create_time;
      const modifiedTime =
        typeof modifiedRaw === "number"
          ? modifiedRaw
          : typeof modifiedRaw === "string"
            ? Number(modifiedRaw) || undefined
            : undefined;
      items.push({
        token,
        name,
        type,
        ...(typeof row.url === "string" ? { url: row.url } : {}),
        ...(modifiedTime ? { modifiedTime } : {}),
      });
    }
    return items;
  }

  private parseTaskStatus(ticket: string, data: Record<string, unknown>): GatewayDriveTaskStatus {
    const statusRaw = String(data.status ?? data.task_status ?? data.state ?? "").toLowerCase();
    const status: GatewayDriveTaskStatus["status"] = /success|done|completed|succeed/.test(statusRaw)
      ? "success"
      : /fail|error|cancel/.test(statusRaw)
        ? "failed"
        : "pending";
    return {
      ticket,
      status,
      progress: typeof data.progress === "number" ? data.progress : undefined,
      errorMessage: typeof data.error_message === "string" ? data.error_message : undefined,
      resultFileToken:
        typeof data.file_token === "string"
          ? data.file_token
          : typeof data.token === "string"
            ? data.token
            : typeof data.obj_token === "string"
              ? data.obj_token
              : undefined,
      resultUrl: typeof data.url === "string" ? data.url : undefined,
    };
  }

  private getAssets(): AssetRecord[] {
    try {
      return parseJsonFromMd<AssetRecord[]>("src/data/assets.md");
    } catch {
      return [];
    }
  }

  private getUsersFromAssets(): UserRecord[] {
    const resources = this.poolStore.loadAll();
    const users = resources
      .filter((item) => item.resourceType === "contact_summary")
      .map((item) => ({
        id: item.resourceId,
        name: item.title,
        role: item.tags.find((tag) => tag !== "contact"),
      }));
    return users;
  }

  async searchDocuments(query: string, _context?: GatewayRequestContext): Promise<GatewayDocument[]> {
    const text = query.toLowerCase();
    const fromPool = this.poolStore
      .loadAll()
      .filter((item) => item.resourceType === "doc_summary" || item.resourceType === "project_memory")
      .filter(
        (item) =>
          item.title.toLowerCase().includes(text) ||
          item.summary.toLowerCase().includes(text) ||
          item.tags.some((tag) => tag.toLowerCase().includes(text)),
      )
      .slice(0, 8)
      .map((item) => ({
        id: item.resourceId,
        title: item.title,
        summary: item.summary,
        url: item.link,
        source: "openapi" as const,
      }));

    if (fromPool.length > 0) return fromPool;

    return this.getAssets()
      .filter((item) => item.sourceType === "doc")
      .filter((item) => item.content.toLowerCase().includes(text))
      .slice(0, 8)
      .map((item) => ({
        id: item.sourceId,
        title: item.sourceId,
        summary: item.content,
        source: "openapi" as const,
      }));
  }

  async listDocuments(query?: string, _context?: GatewayRequestContext): Promise<GatewayDocument[]> {
    const docs = this.poolStore
      .loadAll()
      .filter((item) => item.resourceType === "doc_summary" || item.resourceType === "project_memory")
      .map((item) => ({
        id: item.resourceId,
        title: item.title,
        summary: item.summary,
        url: item.link,
        source: "openapi" as const,
      }));
    if (!query) return docs.slice(0, 20);
    const text = query.toLowerCase();
    return docs.filter(
      (item) => item.title.toLowerCase().includes(text) || (item.summary ?? "").toLowerCase().includes(text),
    );
  }

  async viewDocument(documentId: string, context?: GatewayRequestContext): Promise<GatewayDocument | null> {
    const poolHit = this.poolStore.loadAll().find((item) => item.resourceId === documentId);
    if (poolHit) {
      return {
        id: poolHit.resourceId,
        title: poolHit.title,
        summary: poolHit.summary,
        content: poolHit.summary,
        url: poolHit.link,
        source: "openapi",
      };
    }

    const asset = this.getAssets().find((item) => item.sourceId === documentId);
    if (asset) {
      return {
        id: asset.sourceId,
        title: asset.sourceId,
        summary: asset.content.slice(0, 200),
        content: asset.content,
        source: "openapi",
      };
    }

    const c = getFeishuMvpConfig();
    if (c.appId?.trim() && c.appSecret?.trim()) {
      const token = normalizeDocxTokenForOpenApi(documentId);
      if (token && !/^https?:\/\//i.test(token)) {
        try {
          const userAccessToken =
            context?.userId && context.preferUserScope
              ? (await ensureUserOAuthReady(context.userId)).record?.accessToken
              : undefined;
          const rawText = await fetchDocxRawText(c, token, { userAccessToken });
          if (rawText.trim().length > 0) {
            return {
              id: token,
              title: token,
              content: rawText,
              summary: rawText.slice(0, 200),
              source: "openapi",
            };
          }
        } catch {
          /* 权限/租户与用户文档不一致时回退为 null */
        }
      }
    }

    return null;
  }

  async getFileContent(fileToken: string, context?: GatewayRequestContext): Promise<string> {
    const doc = await this.viewDocument(fileToken, context);
    return doc?.content ?? "";
  }

  async createDocument(input: CreateDocumentInput, _context?: GatewayRequestContext): Promise<GatewayDocument> {
    const c = getFeishuMvpConfig();
    if (!c.appId || !c.appSecret) {
      const id = `openapi_doc_${Date.now()}`;
      return {
        id,
        title: input.title,
        summary: input.content?.slice(0, 200),
        content: input.content,
        url: `https://mock.feishu.local/docx/${id}`,
        source: "openapi",
      };
    }

    const access = await getTenantAccessToken(c);
    const url = `${c.baseUrl}/open-apis/docx/v1/documents`;
    const res = await feishuHttpFetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        folder_token: c.targetFolderToken || undefined,
        title: input.title,
      }),
    });
    const data = (await res.json()) as {
      code?: number;
      msg?: string;
      data?: { document?: { document_id?: string } };
    };
    if (!res.ok || data.code !== 0 || !data.data?.document?.document_id) {
      throw new Error(`OpenAPI createDocument 失败: ${data.msg ?? res.status}`);
    }
    const documentId = data.data.document.document_id;
    if (input.content?.trim()) {
      await this.updateDocument({
        documentId,
        content: input.content,
      });
    }
    return {
      id: documentId,
      title: input.title,
      summary: input.content?.slice(0, 200),
      content: input.content,
      url: `https://www.feishu.cn/docx/${documentId}`,
      source: "openapi",
    };
  }

  async updateDocument(input: UpdateDocumentInput, _context?: GatewayRequestContext): Promise<boolean> {
    const c = getFeishuMvpConfig();
    if (!c.appId || !c.appSecret) return false;
    const blocks = await listAllDocumentBlocks(c, input.documentId);
    const pageBlock = blocks.find((item) => item.block_type === 1);
    const textOrHeading = blocks.find(
      (item) =>
        item.block_type === 2 ||
        (typeof item.block_type === "number" && item.block_type >= 3 && item.block_type <= 11),
    );
    if (textOrHeading?.block_id) {
      await replaceBlockWithPlainText(c, input.documentId, textOrHeading.block_id, input.content);
      return true;
    }
    if (!pageBlock?.block_id) return false;

    const lines = input.content
      .replace(/\r/g, "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    await createTextChildrenBlocks(c, input.documentId, pageBlock.block_id, lines);
    return true;
  }

  async getComments(_documentId: string, _context?: GatewayRequestContext): Promise<GatewayComment[]> {
    return [];
  }

  async addComment(_input: AddCommentInput, _context?: GatewayRequestContext): Promise<boolean> {
    return false;
  }

  async searchUsers(query: string, _context?: GatewayRequestContext): Promise<GatewayUser[]> {
    const text = query.toLowerCase();
    return this.getUsersFromAssets()
      .filter((user) => user.name.toLowerCase().includes(text) || (user.role ?? "").toLowerCase().includes(text))
      .slice(0, 8)
      .map((item) => ({
        id: item.id,
        name: item.name,
        department: item.department,
        role: item.role,
        source: "openapi",
      }));
  }

  async getUserInfo(userId: string, _context?: GatewayRequestContext): Promise<GatewayUser | null> {
    const user = this.getUsersFromAssets().find((item) => item.id === userId);
    if (!user) return null;
    return {
      id: user.id,
      name: user.name,
      department: user.department,
      role: user.role,
      source: "openapi",
    };
  }

  async createSlides(input: CreateSlidesInput): Promise<GatewaySlide> {
    return {
      presentationId: `openapi_slides_${Date.now()}`,
      title: input.title,
      url: `https://mock.feishu.local/slides/${Date.now()}`,
      source: "openapi",
    };
  }

  async queryWhiteboard(token: string): Promise<GatewayWhiteboard | null> {
    return {
      token,
      title: `whiteboard-${token}`,
      content: "",
      previewUrl: `https://mock.feishu.local/whiteboard/${token}`,
      source: "openapi",
    };
  }

  async updateWhiteboard(_input: UpdateWhiteboardInput): Promise<boolean> {
    return false;
  }

  async sendMessage(_input: SendMessageInput): Promise<boolean> {
    return false;
  }

  async listMessages(_input: ListMessagesInput): Promise<GatewayMessage[]> {
    return [];
  }

  async getRootFolderMeta(context?: GatewayRequestContext): Promise<GatewayRootFolderMeta> {
    const data = await this.requestDriveData<{ token?: string; url?: string; name?: string }>(
      "/open-apis/drive/explorer/v2/root_folder/meta",
      context,
      { method: "GET" },
    );
    const token = data.token?.trim();
    if (!token) {
      throw new ToolGatewayError("INVALID_RESPONSE", "root_folder/meta 未返回 token");
    }
    return {
      token,
      url: data.url,
      name: data.name,
    };
  }

  async getFolderMeta(folderToken: string, context?: GatewayRequestContext): Promise<GatewayFolderMeta> {
    const data = await this.requestDriveData<{ token?: string; url?: string; name?: string }>(
      `/open-apis/drive/explorer/v2/folder/${encodeURIComponent(folderToken)}/meta`,
      context,
      { method: "GET" },
    );
    const token = data.token?.trim() || folderToken;
    return {
      token,
      url: data.url,
      name: data.name,
    };
  }

  async listFolderItems(folderToken: string, context?: GatewayRequestContext): Promise<GatewayDriveItem[]> {
    const data = await this.requestDriveData<Record<string, unknown>>(
      `/open-apis/drive/v1/files?folder_token=${encodeURIComponent(folderToken)}&page_size=200`,
      context,
      { method: "GET" },
    );
    return this.toDriveItems(data);
  }

  async createFolder(
    input: { parentFolderToken: string; folderName: string },
    context?: GatewayRequestContext,
  ): Promise<GatewayFolderMeta> {
    const data = await this.requestDriveData<{ token?: string; url?: string; name?: string }>(
      "/open-apis/drive/v1/files/create_folder",
      context,
      {
        method: "POST",
        body: JSON.stringify({
          name: input.folderName,
          folder_token: input.parentFolderToken,
        }),
      },
    );
    const token = data.token?.trim();
    if (!token) {
      throw new ToolGatewayError("INVALID_RESPONSE", "create_folder 未返回 token");
    }
    return {
      token,
      url: data.url,
      name: data.name ?? input.folderName,
    };
  }

  async moveFile(
    input: { fileToken: string; targetFolderToken: string },
    context?: GatewayRequestContext,
  ): Promise<GatewayDriveTaskStatus | null> {
    const data = await this.requestDriveData<Record<string, unknown>>(
      `/open-apis/drive/v1/files/${encodeURIComponent(input.fileToken)}/move`,
      context,
      {
        method: "POST",
        body: JSON.stringify({
          folder_token: input.targetFolderToken,
          type: "explorer",
        }),
      },
    );
    const ticket = String(data.ticket ?? data.task_id ?? "").trim();
    if (!ticket) return null;
    return this.parseTaskStatus(ticket, data);
  }

  async copyFile(
    input: { fileToken: string; targetFolderToken: string; fileName?: string; copyAsDocx?: boolean },
    context?: GatewayRequestContext,
  ): Promise<{ fileToken?: string; url?: string; task?: GatewayDriveTaskStatus | null }> {
    const path = input.copyAsDocx
      ? `/open-apis/drive/explorer/v2/file/copy/files/${encodeURIComponent(input.fileToken)}`
      : `/open-apis/drive/v1/files/${encodeURIComponent(input.fileToken)}/copy`;
    const data = await this.requestDriveData<Record<string, unknown>>(path, context, {
      method: "POST",
      body: JSON.stringify({
        folder_token: input.targetFolderToken,
        name: input.fileName,
      }),
    });
    const fileToken = String(data.token ?? data.file_token ?? data.obj_token ?? "").trim();
    const ticket = String(data.ticket ?? data.task_id ?? "").trim();
    if (!fileToken && !ticket) {
      throw new ToolGatewayError("INVALID_RESPONSE", "copy file 未返回 file token/task ticket");
    }
    return {
      ...(fileToken ? { fileToken } : {}),
      ...(typeof data.url === "string" ? { url: data.url } : {}),
      ...(ticket ? { task: this.parseTaskStatus(ticket, data) } : {}),
    };
  }

  async deleteFile(
    input: { fileToken: string },
    context?: GatewayRequestContext,
  ): Promise<GatewayDriveTaskStatus | null> {
    const data = await this.requestDriveData<Record<string, unknown>>(
      `/open-apis/drive/v1/files/${encodeURIComponent(input.fileToken)}`,
      context,
      { method: "DELETE" },
    );
    const ticket = String(data.ticket ?? data.task_id ?? "").trim();
    if (!ticket) return null;
    return this.parseTaskStatus(ticket, data);
  }

  async checkTask(
    input: { ticket: string },
    context?: GatewayRequestContext,
  ): Promise<GatewayDriveTaskStatus> {
    const data = await this.requestDriveData<Record<string, unknown>>(
      `/open-apis/drive/v1/files/task_check?ticket=${encodeURIComponent(input.ticket)}`,
      context,
      { method: "GET" },
    );
    return this.parseTaskStatus(input.ticket, data);
  }
}

