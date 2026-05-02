import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { getFeishuMvpConfig } from "../integrations/feishu/feishuConfig.js";
import { fetchDocxRawText } from "../integrations/feishu/docxRawContent.js";
import {
  listFolderChildrenPaged,
  pickDocxDocumentTokens,
} from "../integrations/feishu/listFolder.js";
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

  const children = await listFolderChildrenPaged(feishu, opts.folderToken.trim());
  const tokens = pickDocxDocumentTokens(children, opts.maxDocx);

  const titleByToken = new Map<string, string>();
  for (const f of children) {
    if (f.type === "docx" && f.token) {
      titleByToken.set(f.token, f.name);
    }
    if (f.type === "shortcut" && f.shortcut_info?.target_type === "docx") {
      const tgt = f.shortcut_info.target_token;
      if (tgt) titleByToken.set(tgt, f.name);
    }
  }

  const documents: DocumentSummary[] = [];
  for (const tok of tokens) {
    let raw = "";
    try {
      raw = await fetchDocxRawText(feishu, tok);
    } catch {
      raw = "";
    }
    const title = titleByToken.get(tok) ?? `飞书云文档 ${tok.slice(0, 8)}`;
    const summarySlice = raw.replace(/\s+/g, " ").trim().slice(0, 520);
    documents.push({
      id: `feishu_doc_${tok}`,
      title,
      summary:
        summarySlice.length > 0
          ? summarySlice
          : "（摘要暂空：请确认应用有云文档读取权限且为新版 docx）",
      tags: ["飞书同步"],
      feishuDocToken: tok,
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
