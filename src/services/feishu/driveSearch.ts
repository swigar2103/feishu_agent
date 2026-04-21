import { logger } from "../../shared/logger.js";
import type { FeishuClient } from "./client.js";

/**
 * 飞书云盘检索服务（Phase 4.2）。
 *
 * 职责：
 *   1. 列出指定文件夹下的 docx 文件（只看 type=docx，忽略 folder / sheet / bitable）
 *   2. 并行拉每个 docx 的 raw_content 纯文本
 *   3. 针对用户 query 做轻量级关键词打分，取 Top K 返回
 *
 * 为什么要自己打分而不是用飞书 Suite Search：
 *   - Suite Search 需要 "search:docs:read_all" 等更高阶权限，且必须经过应用商店发布流程
 *   - 当前 Phase 4.2 的定位是 MVP：只依赖应用已有的 drive + docx 权限就能跑
 *   - 后续 Phase 4.2.x 可以替换成 Suite Search，接口不变
 *
 * 失败策略：
 *   - 任何一步失败都向上抛 → 由 FeishuRealAdapter 捕获并降级 mock
 *   - 单篇 docx 拉 raw_content 失败仅丢弃该篇，不影响其他
 */

type DriveFileType = "doc" | "docx" | "sheet" | "bitable" | "folder" | "file" | "mindnote" | "slides";

type DriveFile = {
  token: string;
  name: string;
  type: DriveFileType;
  parent_token?: string;
  url?: string;
  modified_time?: string;
};

type ListFilesResp = {
  files?: DriveFile[];
  has_more?: boolean;
  next_page_token?: string;
};

type RawContentResp = {
  content?: string;
};

export type DocxSearchHit = {
  token: string;
  name: string;
  url?: string;
  modifiedTime?: string;
  /** 命中得分，高者优先 */
  score: number;
  /** 截断后的 docx 正文，注入到 Retrieval 素材里 */
  snippet: string;
};

export type DocxSearchOptions = {
  folderToken: string;
  query: string;
  /** 最多拉 raw_content 的 docx 数（防止大目录炸接口） */
  maxDocs: number;
  /** 最终返回的 Top K */
  topK: number;
};

export async function searchDocsInFolder(
  client: FeishuClient,
  opts: DocxSearchOptions,
): Promise<DocxSearchHit[]> {
  const files = await listDocxInFolder(client, opts.folderToken);
  if (files.length === 0) {
    logger.info("[FeishuDriveSearch] 目录下无 docx 文件", { folder: opts.folderToken });
    return [];
  }

  const slice = files.slice(0, opts.maxDocs);
  logger.info("[FeishuDriveSearch] 开始拉取 docx 正文", {
    total: files.length,
    fetching: slice.length,
    query: opts.query,
  });

  const settled = await Promise.allSettled(
    slice.map(async (f) => ({ file: f, content: await fetchDocxRawContent(client, f.token) })),
  );

  const hits: DocxSearchHit[] = [];
  for (const r of settled) {
    if (r.status !== "fulfilled") continue;
    const { file, content } = r.value;
    if (!content) continue;

    const score = scoreMatch(opts.query, `${file.name}\n${content}`);
    if (score <= 0) continue;

    hits.push({
      token: file.token,
      name: file.name,
      url: file.url,
      modifiedTime: file.modified_time,
      score,
      snippet: buildSnippet(opts.query, content, 600),
    });
  }

  hits.sort((a, b) => b.score - a.score);
  const topK = hits.slice(0, opts.topK);
  logger.info("[FeishuDriveSearch] 检索完成", {
    hits: hits.length,
    returned: topK.length,
  });
  return topK;
}

// ============ 低层 API 封装 ============

/** 列出文件夹下的所有 docx（自动翻页，最多 200 条） */
async function listDocxInFolder(client: FeishuClient, folderToken: string): Promise<DriveFile[]> {
  const collected: DriveFile[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 5; page += 1) {
    const data = await client.request<ListFilesResp>("/drive/v1/files", {
      method: "GET",
      query: {
        folder_token: folderToken,
        page_size: 50,
        page_token: pageToken,
      },
    });
    const batch = data?.files ?? [];
    for (const f of batch) {
      if (f.type === "docx") collected.push(f);
    }
    if (!data?.has_more || !data.next_page_token) break;
    pageToken = data.next_page_token;
  }
  return collected;
}

/** 获取 docx 的纯文本正文 */
async function fetchDocxRawContent(client: FeishuClient, documentId: string): Promise<string | null> {
  try {
    const data = await client.request<RawContentResp>(
      `/docx/v1/documents/${documentId}/raw_content`,
      { method: "GET", query: { lang: 0 } },
    );
    return typeof data?.content === "string" ? data.content : null;
  } catch (err) {
    logger.warn("[FeishuDriveSearch] 单篇 docx 拉取失败，已忽略该篇", {
      documentId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ============ 关键词打分 ============

/**
 * 针对 query 在 text 中的命中度打分。
 * 中文按 2~3 字滑动窗口抽 n-gram，英文按空白/标点切词。
 * 打分方式：命中的 unique token 数 / 有效 token 总数，保证结果在 [0,1] 区间。
 */
export function scoreMatch(query: string, text: string): number {
  const tokens = extractTokens(query);
  if (tokens.length === 0) return 0;
  const lowerText = text.toLowerCase();
  let hit = 0;
  for (const t of tokens) {
    if (lowerText.includes(t)) hit += 1;
  }
  return hit / tokens.length;
}

const STOP_WORDS = new Set([
  "请", "帮", "我", "的", "了", "和", "与", "或", "也", "是", "要", "给", "生成", "这个", "那个",
  "报告", "分析", "写一份",
  "please", "write", "give", "generate", "report", "the", "and", "for", "with", "this",
]);

export function extractTokens(query: string): string[] {
  const raw = query.trim();
  if (!raw) return [];
  const out = new Set<string>();

  // 英文/数字：按空白、标点切
  for (const w of raw.split(/[\s,.;:!?，。；：！？、（）()\-]+/u)) {
    if (!w) continue;
    const low = w.toLowerCase();
    if (low.length >= 2 && !STOP_WORDS.has(low) && /^[a-z0-9]+$/.test(low)) {
      out.add(low);
    }
  }

  // 中文：先剥掉标点与 ASCII，拿连续汉字段，再做 2/3 字 n-gram
  const chineseSegments = raw
    .replace(/[\s\p{P}a-zA-Z0-9]+/gu, "|")
    .split("|")
    .filter(Boolean);
  for (const seg of chineseSegments) {
    // 2-gram
    for (let i = 0; i + 2 <= seg.length; i += 1) {
      const tok = seg.slice(i, i + 2);
      if (!STOP_WORDS.has(tok)) out.add(tok);
    }
    // 3-gram（对长度>=3 的段有意义，能捕捉更确定的短语，如"满意度"、"退款率"）
    for (let i = 0; i + 3 <= seg.length; i += 1) {
      const tok = seg.slice(i, i + 3);
      if (!STOP_WORDS.has(tok)) out.add(tok);
    }
  }

  return [...out];
}

/** 截取与 query 最相关的一段作为 snippet（找首个命中 token 附近的 window） */
function buildSnippet(query: string, content: string, maxLen: number): string {
  const tokens = extractTokens(query);
  const lower = content.toLowerCase();
  let firstHit = -1;
  for (const t of tokens) {
    const idx = lower.indexOf(t);
    if (idx >= 0 && (firstHit === -1 || idx < firstHit)) firstHit = idx;
  }
  const start = firstHit < 0 ? 0 : Math.max(0, firstHit - 120);
  const end = Math.min(content.length, start + maxLen);
  const piece = content.slice(start, end).replace(/\s+/g, " ").trim();
  const prefix = start > 0 ? "…" : "";
  const suffix = end < content.length ? "…" : "";
  return `${prefix}${piece}${suffix}`;
}
