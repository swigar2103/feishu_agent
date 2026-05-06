import { env } from "../../config/env.js";
import { feishuHttpFetch } from "../../integrations/feishu/httpFetch.js";
import { ensureUserOAuthReady } from "../../integrations/feishu/userOAuthRefresh.js";
import { logger } from "../../shared/logger.js";
import { splitOAuthScopes } from "../../integrations/feishu/userOAuthAuthorizeFlow.js";
import { toolGateway } from "../toolGateway/gateway.js";
import type {
  HmrsManifest,
  HmrsPermissions,
  HmrsRecallBudget,
  HmrsRefreshStatus,
} from "./model/memPalaceTree.js";

type FeishuFolderItem = {
  token: string;
  name: string;
  type: string;
  url: string | undefined;
  modifiedTime: number | undefined;
};

type WriteObjectKind = "json" | "markdown";

async function getUserAccessToken(userId: string): Promise<string> {
  const ensured = await ensureUserOAuthReady(userId);
  const token = ensured.record?.accessToken?.trim();
  if (!token) {
    throw new Error(`用户 ${userId} 无有效飞书用户访问令牌（UAT），请重新完成 OAuth`);
  }
  return token;
}

async function feishuUserRequest<T>(
  userId: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const token = await getUserAccessToken(userId);
  const resp = await feishuHttpFetch(`${env.FEISHU_BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
      ...(init?.headers ?? {}),
    },
  });
  const body = (await resp.json()) as {
    code?: number;
    msg?: string;
    data?: T;
  };
  if (!resp.ok || body.code !== 0 || !body.data) {
    throw new Error(`Feishu API failed: ${path}, msg=${body.msg ?? resp.status}`);
  }
  return body.data;
}

function parseFolderItems(raw: unknown): FeishuFolderItem[] {
  if (!raw || typeof raw !== "object") return [];
  const data = raw as Record<string, unknown>;
  const files = Array.isArray(data.files) ? data.files : [];
  return files
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const row = item as Record<string, unknown>;
      const token = String(row.token ?? row.file_token ?? row.obj_token ?? "");
      const name = String(row.name ?? row.title ?? "");
      const type = String(row.type ?? row.file_type ?? row.obj_type ?? "");
      const url = typeof row.url === "string" ? row.url : undefined;
      const modifiedRaw = row.modified_time ?? row.edit_time ?? row.create_time;
      const modifiedTime =
        typeof modifiedRaw === "number"
          ? modifiedRaw
          : typeof modifiedRaw === "string"
            ? Number(modifiedRaw) || undefined
            : undefined;
      if (!token || !name) return null;
      return { token, name, type, url, modifiedTime };
    })
    .filter((item): item is FeishuFolderItem => item !== null);
}

function toUploadBuffer(content: string): Uint8Array {
  return new TextEncoder().encode(content);
}

async function uploadObjectToFolder(input: {
  userId: string;
  parentFolderToken: string;
  fileName: string;
  content: string;
  kind: WriteObjectKind;
}): Promise<void> {
  const token = await getUserAccessToken(input.userId);
  const form = new FormData();
  form.append("file_name", input.fileName);
  form.append("parent_type", "explorer");
  form.append("parent_node", input.parentFolderToken);
  const mime = input.kind === "json" ? "application/json" : "text/markdown";
  form.append("file", new Blob([toUploadBuffer(input.content)], { type: mime }), input.fileName);
  const resp = await feishuHttpFetch(`${env.FEISHU_BASE_URL}/open-apis/drive/v1/files/upload_all`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: form,
  });
  const body = (await resp.json()) as { code?: number; msg?: string };
  if (!resp.ok || body.code !== 0) {
    throw new Error(`upload_all failed: ${body.msg ?? resp.status}`);
  }
}

export class HmrsRepository {
  async getRootFolderMeta(userId: string): Promise<{ token: string; url?: string; name?: string }> {
    const data = await feishuUserRequest<{ token?: string; url?: string; name?: string }>(
      userId,
      "/open-apis/drive/explorer/v2/root_folder/meta",
      { method: "GET" },
    );
    const token = data.token?.trim();
    if (!token) throw new Error("无法获取用户 root folder token");
    return { token, url: data.url, name: data.name };
  }

  async listFolderItems(userId: string, folderToken: string): Promise<FeishuFolderItem[]> {
    const data = await feishuUserRequest<Record<string, unknown>>(
      userId,
      `/open-apis/drive/v1/files?folder_token=${encodeURIComponent(folderToken)}&page_size=200`,
      { method: "GET" },
    );
    return parseFolderItems(data);
  }

  async listChildFolders(
    userId: string,
    folderToken: string,
  ): Promise<Array<{ token: string; name: string; url?: string }>> {
    const items = await this.listFolderItems(userId, folderToken);
    return items
      .filter((item) => item.type.toLowerCase().includes("folder"))
      .map((item) => ({
        token: item.token,
        name: item.name,
        url: item.url,
      }));
  }

  async findChildFolderByName(
    userId: string,
    parentFolderToken: string,
    folderName: string,
  ): Promise<FeishuFolderItem | null> {
    const items = await this.listFolderItems(userId, parentFolderToken);
    const found = items.find((item) => item.name === folderName && item.type.toLowerCase().includes("folder"));
    return found ?? null;
  }

  async createFolder(
    userId: string,
    parentFolderToken: string,
    folderName: string,
  ): Promise<{ token: string; url?: string; name: string }> {
    const data = await feishuUserRequest<{ token?: string; url?: string; name?: string }>(
      userId,
      "/open-apis/drive/v1/files/create_folder",
      {
        method: "POST",
        body: JSON.stringify({
          name: folderName,
          folder_token: parentFolderToken,
        }),
      },
    );
    const token = data.token?.trim();
    if (!token) throw new Error(`创建文件夹失败: ${folderName}`);
    return {
      token,
      url: data.url,
      name: data.name?.trim() || folderName,
    };
  }

  async ensureFolderPath(
    userId: string,
    rootToken: string,
    path: string,
  ): Promise<{ token: string; path: string }> {
    const segs = path.split("/").map((s) => s.trim()).filter(Boolean);
    let parent = rootToken;
    let built: string[] = [];
    for (const seg of segs) {
      const existed = await this.findChildFolderByName(userId, parent, seg);
      if (existed) {
        parent = existed.token;
        built.push(seg);
        continue;
      }
      const created = await this.createFolder(userId, parent, seg);
      parent = created.token;
      built.push(seg);
    }
    return { token: parent, path: built.join("/") };
  }

  async writeJsonObject(
    userId: string,
    folderToken: string,
    fileName: string,
    payload: unknown,
  ): Promise<void> {
    const content = JSON.stringify(payload, null, 2);
    await uploadObjectToFolder({
      userId,
      parentFolderToken: folderToken,
      fileName,
      content,
      kind: "json",
    });
  }

  async writeMarkdownObject(
    userId: string,
    folderToken: string,
    fileName: string,
    content: string,
  ): Promise<void> {
    await uploadObjectToFolder({
      userId,
      parentFolderToken: folderToken,
      fileName,
      content,
      kind: "markdown",
    });
  }

  async writeSystemObjects(input: {
    userId: string;
    systemFolderToken: string;
    manifest: HmrsManifest;
    refreshStatus: HmrsRefreshStatus;
    recallBudget: HmrsRecallBudget;
    permissions: HmrsPermissions;
  }): Promise<void> {
    await this.writeJsonObject(input.userId, input.systemFolderToken, "hmrs_manifest.json", input.manifest);
    await this.writeJsonObject(input.userId, input.systemFolderToken, "refresh_status.json", input.refreshStatus);
    await this.writeJsonObject(input.userId, input.systemFolderToken, "recall_budget.json", input.recallBudget);
    await this.writeJsonObject(input.userId, input.systemFolderToken, "permissions.json", input.permissions);
  }

  async listDocsInFolder(
    userId: string,
    folderToken: string,
  ): Promise<Array<{ token: string; title: string; modifiedTime?: number }>> {
    const items = await this.listFolderItems(userId, folderToken);
    return items
      .filter((item) => {
        const t = item.type.toLowerCase();
        return t.includes("doc") || t.includes("docx");
      })
      .map((item) => ({ token: item.token, title: item.name, modifiedTime: item.modifiedTime }));
  }

  async markRefreshError(userId: string, systemFolderToken: string, message: string): Promise<void> {
    logger.warn("hmrs refresh error", { userId, message });
    const status: HmrsRefreshStatus = {
      userId,
      managedFolderTokens: [],
      lastError: message,
      lastRefreshAt: new Date().toISOString(),
    };
    await this.writeJsonObject(userId, systemFolderToken, "refresh_status.json", status);
  }

  async readJsonObjectByName<T>(
    userId: string,
    folderToken: string,
    fileName: string,
  ): Promise<T | null> {
    const files = (await this.listFolderItems(userId, folderToken))
      .filter((item) => item.name === fileName)
      .sort((a, b) => (b.modifiedTime ?? 0) - (a.modifiedTime ?? 0));
    for (const file of files) {
      try {
        const content = await toolGateway.getFileContent(file.token, {
          userId,
          preferUserScope: true,
        });
        const text = content.trim();
        if (!text) continue;
        return JSON.parse(text) as T;
      } catch {
        // 兼容不同 adapter 返回形态：解析失败时继续尝试同名旧版本文件。
      }
    }
    return null;
  }
}

