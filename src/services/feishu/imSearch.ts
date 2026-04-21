import { logger } from "../../shared/logger.js";
import type { FeishuClient } from "./client.js";
import { extractTokens, scoreMatch } from "./driveSearch.js";

/**
 * 飞书群聊消息检索服务（Phase 4.3）。
 *
 * 职责：
 *   1. 从指定 chat_id 拉取最近 N 条消息（带时间窗口过滤）
 *   2. 把每条消息的纯文本抽出来
 *   3. 针对用户 query 做关键词打分，取 Top K 条返回
 *
 * 为什么要自己拉消息然后打分：
 *   - Suite Search 的 /search/v2/message 需要搜索权限 + 应用商店发布，门槛高
 *   - /im/v1/messages?container_id_type=chat 用的权限是 im:message，基本所有飞书应用都会有
 *   - 打分逻辑和 Phase 4.2 共用 extractTokens / scoreMatch，保持一致性
 *
 * 失败策略：
 *   - 任何一步失败都向上抛，由 FeishuRealAdapter 捕获（非阻塞主流程）
 *   - 拉到消息但解析失败的单条消息，丢弃该条即可
 */

/** 飞书 IM v1/messages 返回的单条消息（只保留我们用得到的字段） */
type FeishuImMessage = {
  message_id: string;
  chat_id?: string;
  create_time?: string; // 毫秒时间戳（字符串）
  sender?: {
    id?: string;
    id_type?: string;
    sender_type?: string;
  };
  msg_type?: string;
  body?: {
    content?: string; // JSON 字符串，结构因 msg_type 而异
  };
};

type ListMessagesResp = {
  items?: FeishuImMessage[];
  has_more?: boolean;
  page_token?: string;
};

export type ImMessageHit = {
  messageId: string;
  senderId?: string;
  createTime?: string; // ISO 字符串
  msgType: string;
  text: string;
  score: number;
  snippet: string;
};

export type ImSearchOptions = {
  chatId: string;
  query: string;
  /** 最多拉最近多少条（翻页累计） */
  limit: number;
  /** Top K */
  topK: number;
  /** 只看最近多少小时内的消息 */
  windowHours: number;
};

export async function searchMessagesInChat(
  client: FeishuClient,
  opts: ImSearchOptions,
): Promise<ImMessageHit[]> {
  const sinceTs = Date.now() - opts.windowHours * 3600 * 1000;
  const raws = await listRecentMessages(client, opts.chatId, opts.limit, sinceTs);
  if (raws.length === 0) {
    logger.info("[FeishuImSearch] 群内最近窗口无消息", {
      chatId: mask(opts.chatId),
      windowHours: opts.windowHours,
    });
    return [];
  }

  const hits: ImMessageHit[] = [];
  for (const m of raws) {
    const text = extractPlainText(m);
    if (!text) continue;
    const score = scoreMatch(opts.query, text);
    if (score <= 0) continue;
    hits.push({
      messageId: m.message_id,
      senderId: m.sender?.id,
      createTime: parseCreateTime(m.create_time),
      msgType: m.msg_type ?? "text",
      text,
      score,
      snippet: buildSnippet(opts.query, text, 240),
    });
  }

  hits.sort((a, b) => b.score - a.score);
  const topK = hits.slice(0, opts.topK);
  logger.info("[FeishuImSearch] 检索完成", {
    chatId: mask(opts.chatId),
    scanned: raws.length,
    hits: hits.length,
    returned: topK.length,
  });
  return topK;
}

// ============ 低层 API 封装 ============

/**
 * 拉取 chat 里最近 limit 条消息（允许翻页）。
 * 飞书 /im/v1/messages 是按时间倒序返回的——第一页就是最近的。
 * 我们在达到 limit 或翻过 sinceTs 分界点后停止。
 */
async function listRecentMessages(
  client: FeishuClient,
  chatId: string,
  limit: number,
  sinceTs: number,
): Promise<FeishuImMessage[]> {
  const collected: FeishuImMessage[] = [];
  let pageToken: string | undefined;
  const PAGE_SIZE = Math.min(50, limit);

  for (let page = 0; page < 10; page += 1) {
    const data = await client.request<ListMessagesResp>("/im/v1/messages", {
      method: "GET",
      query: {
        container_id_type: "chat",
        container_id: chatId,
        sort_type: "ByCreateTimeDesc",
        page_size: PAGE_SIZE,
        page_token: pageToken,
      },
    });
    const batch = data?.items ?? [];
    if (batch.length === 0) break;

    let hitOld = false;
    for (const m of batch) {
      const createMs = Number(m.create_time ?? 0);
      if (createMs > 0 && createMs < sinceTs) {
        hitOld = true;
        break;
      }
      collected.push(m);
      if (collected.length >= limit) break;
    }

    if (hitOld || collected.length >= limit) break;
    if (!data?.has_more || !data.page_token) break;
    pageToken = data.page_token;
  }

  return collected;
}

// ============ 消息体纯文本抽取 ============

/**
 * 根据 msg_type 把 body.content（JSON 字符串）转成纯文本。
 * 目前覆盖：text、post、interactive（卡片）、其他类型打占位串。
 */
function extractPlainText(m: FeishuImMessage): string {
  const raw = m.body?.content;
  if (!raw) return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "";
  }

  switch (m.msg_type) {
    case "text":
      return typeof (parsed as { text?: string })?.text === "string"
        ? ((parsed as { text: string }).text ?? "").trim()
        : "";
    case "post":
      return extractPostText(parsed);
    case "interactive":
      return extractInteractiveText(parsed);
    default:
      // 图片/语音/文件等非文本消息，暂时忽略
      return "";
  }
}

type PostContent = {
  title?: string;
  content?: Array<Array<{ tag?: string; text?: string }>>;
  [lang: string]: unknown;
};

/** post 消息（富文本）的 content 是 { zh_cn: { title, content: [[{tag,text}...]...] }, en_us: ... } */
function extractPostText(parsed: unknown): string {
  const obj = parsed as Record<string, unknown>;
  const langs = Object.keys(obj ?? {});
  const parts: string[] = [];
  for (const lang of langs) {
    const section = obj[lang] as PostContent | undefined;
    if (!section || typeof section !== "object") continue;
    if (section.title) parts.push(section.title);
    if (Array.isArray(section.content)) {
      for (const line of section.content) {
        if (!Array.isArray(line)) continue;
        for (const seg of line) {
          if (typeof seg?.text === "string" && seg.text) parts.push(seg.text);
        }
      }
    }
  }
  return parts.join(" ").trim();
}

/** 卡片消息内容因模板而异，这里保底走 JSON.stringify 取关键字段 */
function extractInteractiveText(parsed: unknown): string {
  const obj = parsed as { header?: { title?: { content?: string } }; elements?: unknown[] };
  const parts: string[] = [];
  if (typeof obj?.header?.title?.content === "string") parts.push(obj.header.title.content);
  const walk = (node: unknown): void => {
    if (!node) return;
    if (typeof node === "string") {
      parts.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const n of node) walk(n);
      return;
    }
    if (typeof node === "object") {
      const rec = node as Record<string, unknown>;
      for (const k of ["content", "text", "plain_text"]) {
        const v = rec[k];
        if (typeof v === "string") parts.push(v);
      }
      for (const v of Object.values(rec)) {
        if (typeof v === "object") walk(v);
      }
    }
  };
  if (Array.isArray(obj?.elements)) walk(obj.elements);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

// ============ 工具 ============

function parseCreateTime(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return new Date(n).toISOString();
}

function mask(s: string): string {
  if (s.length <= 8) return s;
  return `${s.slice(0, 6)}***${s.slice(-4)}`;
}

function buildSnippet(query: string, content: string, maxLen: number): string {
  const tokens = extractTokens(query);
  const lower = content.toLowerCase();
  let firstHit = -1;
  for (const t of tokens) {
    const idx = lower.indexOf(t);
    if (idx >= 0 && (firstHit === -1 || idx < firstHit)) firstHit = idx;
  }
  const start = firstHit < 0 ? 0 : Math.max(0, firstHit - 60);
  const end = Math.min(content.length, start + maxLen);
  const piece = content.slice(start, end).replace(/\s+/g, " ").trim();
  const prefix = start > 0 ? "…" : "";
  const suffix = end < content.length ? "…" : "";
  return `${prefix}${piece}${suffix}`;
}
