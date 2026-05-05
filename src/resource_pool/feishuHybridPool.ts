import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { env } from "../config/env.js";
import { getFeishuMvpConfig } from "../integrations/feishu/feishuConfig.js";
import { fetchDocxRawText } from "../integrations/feishu/docxRawContent.js";
import { collectDocxEntriesUnderFolder } from "../integrations/feishu/listFolder.js";
import { ResourcePoolManager } from "./manager.js";
import {
  ContactSummarySchema,
  PersonaSummarySchema,
  ProjectSummarySchema,
  ResourcePoolSnapshotSchema,
  type DocumentSummary,
} from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function readMockJson<T>(name: string): T {
  const p = join(__dirname, "mock", name);
  return JSON.parse(readFileSync(p, "utf-8")) as T;
}

/** 文档列表来自飞书文件夹；联系人/项目/画像仍用本地 mock（可逐步换成 API） */
export async function buildHybridResourcePoolFromFeishuFolder(opts: {
  folderToken: string;
  maxDocx: number;
}): Promise<ResourcePoolManager> {
  const feishu = getFeishuMvpConfig();
  if (!feishu.appId.trim() || !feishu.appSecret.trim()) {
    throw new Error("真飞书资源池需要配置 FEISHU_APP_ID 与 FEISHU_APP_SECRET");
  }

  const entries = await collectDocxEntriesUnderFolder(feishu, opts.folderToken.trim(), {
    maxDocx: opts.maxDocx,
    maxDepth: env.FEISHU_RESOURCE_MAX_FOLDER_DEPTH,
  });

  const documents: DocumentSummary[] = [];
  for (const entry of entries) {
    let raw = "";
    try {
      raw = await fetchDocxRawText(feishu, entry.token);
    } catch {
      raw = "";
    }
    const title = entry.name.trim().length > 0 ? entry.name : `飞书云文档 ${entry.token.slice(0, 8)}`;
    const summarySlice = raw.replace(/\s+/g, " ").trim().slice(0, 520);
    documents.push({
      id: `feishu_doc_${entry.token}`,
      folderPathSegments: entry.folderPathSegments,
      title,
      summary:
        summarySlice.length > 0
          ? summarySlice
          : "（摘要暂空：请确认应用有云文档读取权限且为新版 docx）",
      tags: ["飞书同步"],
      feishuDocToken: entry.token,
      weight: 1,
    });
  }

  const contacts = readMockJson<unknown[]>("contacts.json").map((row) =>
    ContactSummarySchema.parse(row),
  );
  const projects = readMockJson<unknown[]>("projects.json").map((row) =>
    ProjectSummarySchema.parse(row),
  );
  const personas = readMockJson<unknown[]>("personas.json").map((row) =>
    PersonaSummarySchema.parse(row),
  );

  const snapshot = ResourcePoolSnapshotSchema.parse({
    documents,
    contacts,
    projects,
    personas,
    meta: {
      version: `feishu-folder:${opts.folderToken.slice(0, 8)}`,
      loadedAt: new Date().toISOString(),
    },
  });

  return new ResourcePoolManager(snapshot);
}
