/**
 * 飞书 MCP tools/call 返回的纯解析逻辑（可单测、无 HTTP）。
 * @see README §12.5 P2 回归测试
 */

import { blockPlainText, type BlockItem } from "../../integrations/feishu/docxBlocks.js";

export function parseMcpPayload<T>(payload: unknown): T | null {
  if (!payload) return null;
  try {
    if (typeof payload === "string") {
      return JSON.parse(payload) as T;
    }
    return payload as T;
  } catch {
    return null;
  }
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return null;
}

function pickTrimmedString(r: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = r[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

/** search-doc 单条结果常见字段（多部署/版本字段名不一致） */
function mcpSearchDocIdFromRecord(r: Record<string, unknown>): string | undefined {
  return pickTrimmedString(r, [
    "id",
    "document_id",
    "file_token",
    "doc_id",
    "document_token",
    "doc_token",
    "token",
  ]);
}

function mcpSearchDocTitleFromRecord(r: Record<string, unknown>): string | undefined {
  return pickTrimmedString(r, ["title", "name", "document_title", "doc_title"]);
}

const MCP_SEARCH_DOC_ARRAY_KEYS = [
  "docs",
  "documents",
  "files",
  "items",
  "results",
  "list",
  "records",
  "rows",
  "data_list",
  "search_results",
  "doc_list",
] as const;

function firstDocArrayInRecord(r: Record<string, unknown>): unknown[] | null {
  for (const k of MCP_SEARCH_DOC_ARRAY_KEYS) {
    const v = r[k];
    if (Array.isArray(v)) return v;
  }
  return null;
}

function hasKnownDocArrayInUnknown(v: unknown, depth: number): boolean {
  if (depth > 10 || v === null || v === undefined) return false;
  if (Array.isArray(v)) {
    for (const item of v) {
      if (hasKnownDocArrayInUnknown(item, depth + 1)) return true;
    }
    return false;
  }
  const rec = asRecord(v);
  if (!rec) return false;
  for (const k of MCP_SEARCH_DOC_ARRAY_KEYS) {
    if (Array.isArray(rec[k])) return true;
  }
  for (const k of ["data", "result", "payload", "response"]) {
    if (hasKnownDocArrayInUnknown(rec[k], depth + 1)) return true;
  }
  return false;
}

export type McpSearchDocRow = {
  id: string;
  title: string;
  summary?: string;
  url?: string;
};

/**
 * 解析 search-doc / list-docs 等返回的文档列表（兼容 docs、documents、data.files 等）。
 */
export function extractSearchDocListFromUnknown(data: unknown): McpSearchDocRow[] {
  const root = data === null || data === undefined ? null : (parseMcpPayload<unknown>(data) ?? data);
  if (root === null || root === undefined) return [];

  const collect = (v: unknown, depth: number): McpSearchDocRow[] => {
    if (depth > 10 || v === null || v === undefined) return [];
    if (Array.isArray(v)) {
      const rows: McpSearchDocRow[] = [];
      for (let i = 0; i < v.length; i++) {
        const rec = asRecord(v[i]);
        if (!rec) continue;
        const id = mcpSearchDocIdFromRecord(rec);
        if (!id) continue;
        const title = mcpSearchDocTitleFromRecord(rec) ?? id;
        rows.push({
          id,
          title,
          summary: pickTrimmedString(rec, ["summary", "snippet", "abstract", "description"]),
          url: pickTrimmedString(rec, ["url", "link", "doc_url", "document_url", "href"]),
        });
      }
      return rows;
    }
    const rec = asRecord(v);
    if (!rec) return [];

    const direct = firstDocArrayInRecord(rec);
    if (direct) return collect(direct, depth + 1);

    let merged: McpSearchDocRow[] = [];
    for (const k of ["data", "result", "payload", "response"]) {
      merged = merged.concat(collect(rec[k], depth + 1));
    }
    return merged;
  };

  if (Array.isArray(root)) return collect(root, 0);
  return collect(root, 0);
}

export function hasKnownSearchDocArrayField(data: unknown): boolean {
  const root = data === null || data === undefined ? null : (parseMcpPayload<unknown>(data) ?? data);
  if (root === null || root === undefined) return false;
  return hasKnownDocArrayInUnknown(root, 0);
}

/**
 * MCP search-doc 常在 HTTP 200 的 tool 正文中返回 Unauthorized（用户 OAuth 未含搜索类 scope）。
 */
export function mcpSearchDocResponseIndicatesScopeGap(data: unknown): boolean {
  const text =
    typeof data === "string"
      ? data
      : data !== null && data !== undefined
        ? JSON.stringify(data)
        : "";
  if (!text.trim()) return false;
  return (
    /search:docs:read/i.test(text) ||
    /应用未获取所需的用户授权/i.test(text) ||
    (/Unauthorized/i.test(text) && /failed to search docs/i.test(text))
  );
}

/**
 * 兼容 create-doc 多种 JSON 包装；无 title 时用 fallbackTitle。
 */
export function extractCreateDocMetaFromUnknown(
  data: unknown,
  fallbackTitle?: string,
): { id: string; title: string; url: string } | null {
  const root = data === null || data === undefined ? null : (parseMcpPayload<unknown>(data) ?? data);
  const candidates: Record<string, unknown>[] = [];
  const push = (x: unknown) => {
    const r = asRecord(x);
    if (r) candidates.push(r);
  };
  push(root);
  const top = asRecord(root);
  if (top) {
    for (const k of ["data", "result", "document", "doc", "file", "payload"]) {
      push(top[k]);
    }
    const innerData = asRecord(top["data"]);
    if (innerData) {
      for (const k of ["document", "doc", "file"]) {
        push(innerData[k]);
      }
    }
  }
  const titleFallback = fallbackTitle?.trim();
  for (const obj of candidates) {
    const id = pickTrimmedString(obj, [
      "id",
      "document_id",
      "file_token",
      "doc_id",
      "document_token",
      "doc_token",
    ]);
    if (!id) continue;
    const titleFromApi = pickTrimmedString(obj, ["title", "name", "document_title"]);
    const title = (titleFromApi ?? titleFallback)?.trim();
    if (!title) continue;
    let url = pickTrimmedString(obj, ["url", "link", "doc_url", "document_url", "href"]);
    if (!url) {
      url = id.startsWith("http") ? id : `https://www.feishu.cn/docx/${id}`;
    }
    return { id, title, url };
  }
  return null;
}

const FETCH_DOC_PREFERRED_TEXT_KEYS = [
  "markdown",
  "full_markdown",
  "export_markdown",
  "md",
  "markdown_content",
  "content",
  "text",
  "body",
  "plain_text",
  "full_text",
  "doc_content",
] as const;

function longerNonEmpty(a: string, b: string): string {
  const ta = a.trim();
  const tb = b.trim();
  return ta.length >= tb.length ? ta : tb;
}

/** 在常见嵌套路径上取「最长」的正文字段，避免首遇短 content 预览就返回 */
function extractLongestPreferredDocString(v: unknown, depth: number): string {
  if (depth > 14 || v === null || v === undefined) return "";
  if (typeof v === "string") {
    const t = v.trim();
    return t;
  }
  const r = asRecord(v);
  if (!r) return "";
  let best = "";
  for (const k of FETCH_DOC_PREFERRED_TEXT_KEYS) {
    const s = r[k];
    if (typeof s === "string" && s.trim().length > best.length) {
      best = s.trim();
    }
  }
  for (const k of ["data", "document", "result", "payload", "file", "doc"]) {
    const inner = extractLongestPreferredDocString(r[k], depth + 1);
    if (inner.length > best.length) best = inner;
  }
  return best;
}

function extractPlainFromDocxBlockArray(items: unknown[]): string {
  const parts: string[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    try {
      const t = blockPlainText(item as BlockItem);
      if (t.trim()) parts.push(t.trim());
    } catch {
      /* ignore malformed block */
    }
  }
  return parts.join("\n");
}

/** 从 MCP 可能返回的 docx 块树/块列表拼纯文本 */
function extractFeishuDocxBlocksTree(v: unknown, depth: number): string {
  if (depth > 14 || v === null || v === undefined) return "";
  if (Array.isArray(v)) {
    if (
      v.length > 0 &&
      v.every((x) => {
        if (!x || typeof x !== "object") return false;
        return typeof (x as Record<string, unknown>).block_type === "number";
      })
    ) {
      return extractPlainFromDocxBlockArray(v);
    }
    let best = "";
    for (const el of v) {
      best = longerNonEmpty(best, extractFeishuDocxBlocksTree(el, depth + 1));
    }
    return best;
  }
  const r = asRecord(v);
  if (!r) return "";
  for (const k of ["blocks", "items", "block_list", "document_blocks", "children"]) {
    const inner = extractFeishuDocxBlocksTree(r[k], depth + 1);
    if (inner.trim()) return inner;
  }
  let merged = "";
  for (const k of ["data", "document", "result", "payload"]) {
    merged = longerNonEmpty(merged, extractFeishuDocxBlocksTree(r[k], depth + 1));
  }
  return merged;
}

/** fetch-doc：正文常见字段、嵌套与 docx 块结构（取较长者） */
export function extractFetchDocBodyFromUnknown(data: unknown): string {
  if (typeof data === "string") {
    const t = data.trim();
    if (t) return t;
  }
  const root = data === null || data === undefined ? null : (parseMcpPayload<unknown>(data) ?? data);
  if (root === null || root === undefined) return "";
  const fromBlocks = extractFeishuDocxBlocksTree(root, 0);
  const fromStrings = extractLongestPreferredDocString(root, 0);
  return longerNonEmpty(fromBlocks, fromStrings).trim();
}

function updateDocSuccessFromRecord(rec: Record<string, unknown>): boolean {
  if (typeof rec.ok === "boolean") return rec.ok;
  if (typeof rec.success === "boolean") return rec.success;
  if (rec.code === 0 || rec.code === "0") return true;
  if (rec.error_code === 0 || rec.err_code === 0) return true;
  if (rec.status === 0 || rec.status === "0") return true;
  if (typeof rec.status === "string" && /^(success|ok)$/i.test(rec.status.trim())) return true;
  if (typeof rec.msg === "string" && /^(success|ok)$/i.test(rec.msg.trim())) return true;
  if (typeof rec.message === "string" && /^(success|ok)$/i.test(rec.message.trim())) return true;
  // 部分远端实现仅回写 revision / block 元数据，无 ok 字段
  if (typeof rec.revision_id === "string" && rec.revision_id.trim()) return true;
  if (typeof rec.revision === "number" && rec.revision >= 0) return true;
  return false;
}

/**
 * update-doc：显式布尔 / ok / success / 飞书式 code=0 / 嵌套 data。
 * 仍拒绝裸 `{}` 与含糊 message，避免未写入却放行。
 */
export function interpretMcpUpdateDocResult(data: unknown): boolean {
  if (typeof data === "boolean") return data;
  if (typeof data === "string") {
    const t = data.trim();
    if (t === "" || t === "null") return false;
    if (/^(ok|success)$/i.test(t)) return true;
    try {
      return interpretMcpUpdateDocResult(JSON.parse(t));
    } catch {
      return false;
    }
  }
  const parsed = parseMcpPayload<Record<string, unknown>>(data) ?? asRecord(data);
  if (!parsed) return false;
  if (updateDocSuccessFromRecord(parsed)) return true;
  for (const k of ["data", "result", "payload"]) {
    const inner = asRecord(parsed[k]);
    if (inner && updateDocSuccessFromRecord(inner)) return true;
  }
  return false;
}
