import { env } from "../../config/env.js";
import { ensureUserOAuthReady } from "../../integrations/feishu/userOAuthRefresh.js";
import { logger } from "../../shared/logger.js";
import { feishuHttpFetch } from "../../integrations/feishu/httpFetch.js";
import { toolGateway } from "../toolGateway/gateway.js";
import type {
  HmrsManifest,
  HmrsPermissions,
  HmrsRecallBudget,
  HmrsRefreshStatus,
} from "./model/memPalaceTree.js";

export type FolderNode = {
  token: string;
  name: string;
  files: { token: string; title: string }[];
  subFolders: FolderNode[];
};

type FeishuFolderItem = {
  token: string;
  name: string;
  type: string;
  url: string | undefined;
  modifiedTime: number | undefined;
};

type WriteObjectKind = "json" | "markdown";
const DRIVE_TASK_POLL_INTERVAL_MS = 1200;
const DRIVE_TASK_MAX_POLLS = 20;

async function getUserAccessToken(userId: string): Promise<string> {
  const ensured = await ensureUserOAuthReady(userId);
  const token = ensured.record?.accessToken?.trim();
  if (!token) {
    throw new Error(`用户 ${userId} 无有效飞书用户访问令牌（UAT），请重新完成 OAuth`);
  }
  return token;
}

function toGatewayContext(userId: string) {
  return {
    userId,
    preferUserScope: true as const,
  };
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
  const bytes = toUploadBuffer(input.content);
  const mime = input.kind === "json" ? "application/json" : "text/markdown";
  const form = new FormData();
  form.append("file_name", input.fileName);
  form.append("parent_type", "explorer");
  form.append("parent_node", input.parentFolderToken);
  // Feishu upload_all 必须提供 size（字节数），否则返回 params error
  form.append("size", String(bytes.byteLength));
  form.append("file", new Blob([bytes], { type: mime }), input.fileName);
  const resp = await feishuHttpFetch(`${env.FEISHU_BASE_URL}/open-apis/drive/v1/files/upload_all`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: form,
  });
  const body = (await resp.json()) as { code?: number; msg?: string };
  if (!resp.ok || body.code !== 0) {
    throw new Error(`upload_all failed: ${body.msg ?? resp.status} (code=${body.code})`);
  }
}

export class HmrsRepository {
  private async removeFilesByName(
    userId: string,
    folderToken: string,
    fileName: string,
  ): Promise<void> {
    const items = await this.listFolderItems(userId, folderToken);
    const sameName = items.filter((item) => item.name === fileName && !item.type.toLowerCase().includes("folder"));
    for (const item of sameName) {
      // HMRS 自身只写 JSON/Markdown 上传文件，type 统一为 "file"
      await this.deleteFile(userId, item.token, "file").catch((error) => {
        logger.warn("hmrs remove same name file failed", {
          userId,
          folderToken,
          fileName,
          fileToken: item.token,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }

  private async waitForTaskCompletion(input: {
    userId: string;
    task: {
      ticket: string;
      status: "pending" | "success" | "failed";
      errorMessage?: string;
      resultFileToken?: string;
      resultUrl?: string;
    };
    op: string;
  }): Promise<{
    ticket: string;
    status: "pending" | "success" | "failed";
    errorMessage?: string;
    resultFileToken?: string;
    resultUrl?: string;
  }> {
    if (input.task.status !== "pending") return input.task;
    let last = input.task;
    for (let i = 0; i < DRIVE_TASK_MAX_POLLS; i++) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, DRIVE_TASK_POLL_INTERVAL_MS);
      });
      const checked = await this.checkTask(input.userId, input.task.ticket).catch(() => last);
      last = checked;
      if (checked.status !== "pending") {
        if (checked.status === "failed") {
          logger.warn("hmrs drive async task failed", {
            userId: input.userId,
            op: input.op,
            ticket: checked.ticket,
            error: checked.errorMessage,
          });
        }
        return checked;
      }
    }
    logger.warn("hmrs drive async task polling timeout", {
      userId: input.userId,
      op: input.op,
      ticket: input.task.ticket,
      polls: DRIVE_TASK_MAX_POLLS,
    });
    return last;
  }

  async getRootFolderMeta(userId: string): Promise<{ token: string; url?: string; name?: string }> {
    const data = await toolGateway.getRootFolderMeta(toGatewayContext(userId));
    const token = data.token?.trim();
    if (!token) throw new Error("无法获取用户 root folder token");
    return { token, url: data.url, name: data.name };
  }

  async listFolderItems(userId: string, folderToken: string): Promise<FeishuFolderItem[]> {
    const items = await toolGateway.listFolderItems(folderToken, toGatewayContext(userId));
    return items.map((item) => ({
      token: item.token,
      name: item.name,
      type: item.type,
      url: item.url,
      modifiedTime: item.modifiedTime,
    }));
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
    const data = await toolGateway.createFolder(
      {
        parentFolderToken,
        folderName,
      },
      toGatewayContext(userId),
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

  private async hasFolderPath(userId: string, rootToken: string, path: string): Promise<boolean> {
    const segs = path.split("/").map((s) => s.trim()).filter(Boolean);
    let parent = rootToken;
    for (const seg of segs) {
      const existed = await this.findChildFolderByName(userId, parent, seg);
      if (!existed) return false;
      parent = existed.token;
    }
    return true;
  }

  async getMissingFolderPaths(
    userId: string,
    rootToken: string,
    requiredPaths: string[],
  ): Promise<string[]> {
    const missing: string[] = [];
    for (const requiredPath of requiredPaths) {
      const ok = await this.hasFolderPath(userId, rootToken, requiredPath);
      if (!ok) missing.push(requiredPath);
    }
    return missing;
  }

  async ensureRequiredFolderLayout(
    userId: string,
    rootToken: string,
    requiredPaths: string[],
  ): Promise<{ missingPaths: string[]; repairedPaths: string[] }> {
    const missingPaths = await this.getMissingFolderPaths(userId, rootToken, requiredPaths);
    const repairedPaths: string[] = [];
    for (const requiredPath of missingPaths) {
      await this.ensureFolderPath(userId, rootToken, requiredPath);
      repairedPaths.push(requiredPath);
    }
    return { missingPaths, repairedPaths };
  }

  async writeJsonObject(
    userId: string,
    folderToken: string,
    fileName: string,
    payload: unknown,
  ): Promise<void> {
    await this.removeFilesByName(userId, folderToken, fileName);
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
    await this.removeFilesByName(userId, folderToken, fileName);
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

  async getFolderMeta(
    userId: string,
    folderToken: string,
  ): Promise<{ token: string; url?: string; name?: string }> {
    return toolGateway.getFolderMeta(folderToken, toGatewayContext(userId));
  }

  async moveFile(
    userId: string,
    fileToken: string,
    targetFolderToken: string,
  ): Promise<{ ticket: string; status: "pending" | "success" | "failed" } | null> {
    const task = await toolGateway.moveFile({ fileToken, targetFolderToken }, toGatewayContext(userId));
    if (!task) return null;
    const settled = await this.waitForTaskCompletion({
      userId,
      task,
      op: "moveFile",
    });
    return { ticket: settled.ticket, status: settled.status };
  }

  async copyFile(
    userId: string,
    fileToken: string,
    targetFolderToken: string,
    fileName?: string,
  ): Promise<{ fileToken: string; url?: string }> {
    const copied = await toolGateway.copyFile(
      {
        fileToken,
        targetFolderToken,
        fileName,
      },
      toGatewayContext(userId),
    );
    if (copied.fileToken?.trim()) {
      return {
        fileToken: copied.fileToken.trim(),
        url: copied.url,
      };
    }
    if (copied.task?.ticket) {
      const settled = await this.waitForTaskCompletion({
        userId,
        task: copied.task,
        op: "copyFile",
      });
      if (settled.status === "success" && settled.resultFileToken?.trim()) {
        return {
          fileToken: settled.resultFileToken.trim(),
          url: settled.resultUrl ?? copied.url,
        };
      }
      throw new Error(
        `copyFile 未获得可用 file token（status=${settled.status} ticket=${settled.ticket}${settled.errorMessage ? ` error=${settled.errorMessage}` : ""})`,
      );
    }
    throw new Error("copyFile 未返回 file token 或 task ticket");
  }

  async copyDocument(
    userId: string,
    fileToken: string,
    targetFolderToken: string,
    fileName?: string,
  ): Promise<{ fileToken: string; url?: string }> {
    const copied = await toolGateway.copyFile(
      {
        fileToken,
        targetFolderToken,
        fileName,
        copyAsDocx: true,
      },
      toGatewayContext(userId),
    );
    if (copied.fileToken?.trim()) {
      return {
        fileToken: copied.fileToken.trim(),
        url: copied.url,
      };
    }
    if (copied.task?.ticket) {
      const settled = await this.waitForTaskCompletion({
        userId,
        task: copied.task,
        op: "copyDocument",
      });
      if (settled.status === "success" && settled.resultFileToken?.trim()) {
        return {
          fileToken: settled.resultFileToken.trim(),
          url: settled.resultUrl ?? copied.url,
        };
      }
      throw new Error(
        `copyDocument 未获得可用 file token（status=${settled.status} ticket=${settled.ticket}${settled.errorMessage ? ` error=${settled.errorMessage}` : ""})`,
      );
    }
    throw new Error("copyDocument 未返回 file token 或 task ticket");
  }

  async deleteFile(
    userId: string,
    fileToken: string,
    fileType = "file",
  ): Promise<{ ticket: string; status: "pending" | "success" | "failed" } | null> {
    const task = await toolGateway.deleteFile({ fileToken, fileType }, toGatewayContext(userId));
    if (!task) return null;
    const settled = await this.waitForTaskCompletion({
      userId,
      task,
      op: "deleteFile",
    });
    return { ticket: settled.ticket, status: settled.status };
  }

  async checkTask(
    userId: string,
    ticket: string,
  ): Promise<{
    ticket: string;
    status: "pending" | "success" | "failed";
    errorMessage?: string;
    resultFileToken?: string;
    resultUrl?: string;
  }> {
    const task = await toolGateway.checkTask({ ticket }, toGatewayContext(userId));
    return {
      ticket: task.ticket,
      status: task.status,
      errorMessage: task.errorMessage,
      resultFileToken: task.resultFileToken,
      resultUrl: task.resultUrl,
    };
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

  /**
   * 递归扫描文件夹结构，返回带层级的 FolderNode 树。
   * 供 Planner Agent 感知文件夹结构后动态选择目标子文件夹。
   */
  async listFolderStructure(
    userId: string,
    folderToken: string,
    maxDepth = 2,
  ): Promise<FolderNode> {
    return this._buildFolderNode(userId, folderToken, "(root)", maxDepth, 0);
  }

  private async _buildFolderNode(
    userId: string,
    folderToken: string,
    folderName: string,
    maxDepth: number,
    currentDepth: number,
  ): Promise<FolderNode> {
    const items = await this.listFolderItems(userId, folderToken).catch(() => []);
    const files: { token: string; title: string }[] = [];
    const subFolders: FolderNode[] = [];
    for (const item of items) {
      const t = item.type.toLowerCase();
      if (t.includes("folder")) {
        if (currentDepth < maxDepth) {
          const child = await this._buildFolderNode(userId, item.token, item.name, maxDepth, currentDepth + 1).catch(
            () => ({ token: item.token, name: item.name, files: [], subFolders: [] }),
          );
          subFolders.push(child);
        } else {
          subFolders.push({ token: item.token, name: item.name, files: [], subFolders: [] });
        }
      } else if (t.includes("doc") || t.includes("docx") || t.includes("file")) {
        files.push({ token: item.token, title: item.name });
      }
    }
    return { token: folderToken, name: folderName, files, subFolders };
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

