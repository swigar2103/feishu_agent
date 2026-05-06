import { logger } from "../../shared/logger.js";
import type { FeishuMvpConfig } from "./feishuConfig.js";
import { getTenantAccessToken } from "./token.js";

type RawContentResponse = {
  code?: number;
  msg?: string;
  data?: { content?: string | { text?: string } };
};

function extractRawContent(parsed: RawContentResponse): string {
  if (parsed.code !== 0 || !parsed.data?.content) return "";
  const c = parsed.data.content;
  if (typeof c === "string") return c;
  if (typeof c === "object" && c !== null && "text" in c) {
    const t = (c as { text?: unknown }).text;
    if (typeof t === "string") return t;
  }
  return "";
}

/**
 * 拉取新版云文档纯文本（适合快速摘要；大文档可能较长）。
 * @see https://open.feishu.cn/document/server-docs/docs/docs/docx-v1/document/raw_content
 */
export async function fetchDocxRawText(
  c: FeishuMvpConfig,
  documentId: string,
  opts?: { userAccessToken?: string },
): Promise<string> {
  const access = opts?.userAccessToken?.trim() || (await getTenantAccessToken(c));
  const id = encodeURIComponent(documentId);
  const url = `${c.baseUrl}/open-apis/docx/v1/documents/${id}/raw_content`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${access}` } });
  const data = (await res.json()) as RawContentResponse;
  if (!res.ok || data.code !== 0) {
    throw new Error(
      `飞书 raw_content: ${data.msg ?? res.status} (code=${data.code})`,
    );
  }
  const text = extractRawContent(data).trim();
  if (!text) {
    logger.warn("飞书 raw_content 返回空文本", { documentId });
  }
  return text;
}
