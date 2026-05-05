import type {
  GatewayDocument,
  GatewayMessage,
  GatewaySlide,
  GatewayUser,
  GatewayWhiteboard,
} from "./types.js";
import { ToolGatewayError } from "./errors.js";

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function pickArray(record: Record<string, unknown>, keys: string[]): unknown[] {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function pickRecord(record: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  for (const key of keys) {
    const value = record[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  }
  return {};
}

function buildDoc(item: Record<string, unknown>, fallbackId: string): GatewayDocument {
  const id = asString(item.obj_token) || asString(item.document_id) || asString(item.token) || fallbackId;
  const title = asString(item.title) || id;
  const content = asString(item.content);
  const summary = asString(item.summary) || (content ? content.slice(0, 200) : "");
  const url = asString(item.url) || asString(item.doc_url);
  return {
    id,
    title,
    content: content || undefined,
    summary: summary || undefined,
    url: url || undefined,
    source: "lark_cli",
  };
}

export function parseCliJson(stdout: string): unknown {
  const text = stdout.trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ToolGatewayError("UPSTREAM_TEMPORARY", "lark-cli 返回非 JSON 输出");
  }
}

export function parseDocuments(payload: unknown): GatewayDocument[] {
  const root = asRecord(payload);
  const data = pickRecord(root, ["data"]);
  const candidates = [
    ...pickArray(root, ["items", "docs", "documents"]),
    ...pickArray(data, ["items", "docs", "documents", "data"]),
  ];

  if (candidates.length === 0) {
    const single = buildDoc({ ...data, ...root }, "lark_cli_doc_1");
    if (single.id === "lark_cli_doc_1" && !single.title && !single.content) return [];
    return [single];
  }

  return candidates
    .map((item, idx) => buildDoc(asRecord(item), `lark_cli_doc_${idx + 1}`))
    .filter((item) => !!item.id);
}

export function parseUsers(payload: unknown): GatewayUser[] {
  const root = asRecord(payload);
  const data = pickRecord(root, ["data"]);
  const candidates = [
    ...pickArray(root, ["items", "users"]),
    ...pickArray(data, ["items", "users", "user_list"]),
  ];

  return candidates
    .map((item, idx) => {
      const r = asRecord(item);
      return {
        id: asString(r.user_id) || asString(r.open_id) || asString(r.union_id) || `lark_cli_user_${idx + 1}`,
        name: asString(r.name) || asString(r.en_name) || `用户${idx + 1}`,
        department: asString(r.department_name) || undefined,
        role: asString(r.job_title) || asString(r.role) || undefined,
        source: "lark_cli" as const,
      };
    })
    .filter((item) => !!item.id);
}

export function parseSingleUser(payload: unknown): GatewayUser | null {
  const root = asRecord(payload);
  const data = pickRecord(root, ["data"]);
  const user = pickRecord(data, ["user"]);
  const merged = Object.keys(user).length > 0 ? user : { ...data, ...root };
  const id = asString(merged.user_id) || asString(merged.open_id) || asString(merged.union_id);
  if (!id) return null;
  return {
    id,
    name: asString(merged.name) || id,
    department: asString(merged.department_name) || undefined,
    role: asString(merged.job_title) || asString(merged.role) || undefined,
    source: "lark_cli",
  };
}

export function parseSlides(payload: unknown): GatewaySlide {
  const root = asRecord(payload);
  const data = pickRecord(root, ["data"]);
  const item = { ...data, ...root };
  const presentationId =
    asString(item.presentation_id) || asString(item.slide_id) || asString(item.token) || `slides_${Date.now()}`;
  return {
    presentationId,
    title: asString(item.title) || undefined,
    url: asString(item.url) || undefined,
    source: "lark_cli",
  };
}

export function parseWhiteboard(payload: unknown, token: string): GatewayWhiteboard | null {
  const root = asRecord(payload);
  const data = pickRecord(root, ["data"]);
  const item = { ...data, ...root };
  const resolvedToken = asString(item.token) || asString(item.whiteboard_token) || token;
  if (!resolvedToken) return null;
  return {
    token: resolvedToken,
    title: asString(item.title) || undefined,
    content: asString(item.content) || undefined,
    previewUrl: asString(item.preview_url) || undefined,
    source: "lark_cli",
  };
}

export function parseMessages(payload: unknown): GatewayMessage[] {
  const root = asRecord(payload);
  const data = pickRecord(root, ["data"]);
  const candidates = [
    ...pickArray(root, ["items", "messages"]),
    ...pickArray(data, ["items", "messages"]),
  ];

  return candidates.map((item, idx) => {
    const r = asRecord(item);
    const sender = pickRecord(r, ["sender"]);
    return {
      id: asString(r.message_id) || `lark_cli_msg_${idx + 1}`,
      chatId: asString(r.chat_id) || undefined,
      sender: asString(sender.name) || asString(r.sender_id) || undefined,
      content: asString(r.body) || asString(r.content) || "",
      createdAt: asString(r.create_time) || undefined,
      source: "lark_cli",
    };
  });
}

