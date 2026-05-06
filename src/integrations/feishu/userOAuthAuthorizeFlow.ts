import crypto from "node:crypto";
import { env } from "../../config/env.js";
import fs from "node:fs";
import path from "node:path";
import { getWritableDataDir } from "../../storage/writableDataDir.js";

/** OAuth 完成后是否在 IM 中自动续跑用户刚才的请求 */
export type OAuthReplayPayload = {
  chatId: string;
  text: string;
  messageId: string;
  pipeline: "full" | "phase1";
};

export type PendingOAuthState = {
  userId: string;
  createdAtMs: number;
  replay?: OAuthReplayPayload;
};

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

const FILE_PATH = path.join(getWritableDataDir(), "oauth-pending-states.json");

type PendingOAuthStoreData = {
  items: Array<PendingOAuthState & { state: string }>;
};

function trimToMaxItems(
  items: Array<PendingOAuthState & { state: string }>,
): Array<PendingOAuthState & { state: string }> {
  const maxItems = env.FEISHU_OAUTH_PENDING_STATE_MAX_ITEMS;
  if (items.length <= maxItems) return items;
  return items
    .slice()
    .sort((a, b) => b.createdAtMs - a.createdAtMs)
    .slice(0, maxItems);
}

function readStore(): PendingOAuthStoreData {
  if (!fs.existsSync(FILE_PATH)) {
    return { items: [] };
  }
  try {
    const raw = fs.readFileSync(FILE_PATH, "utf-8");
    const parsed = JSON.parse(raw) as PendingOAuthStoreData;
    if (!Array.isArray(parsed.items)) return { items: [] };
    return parsed;
  } catch {
    return { items: [] };
  }
}

function writeStore(data: PendingOAuthStoreData): void {
  const trimmed = trimToMaxItems(data.items);
  fs.writeFileSync(FILE_PATH, JSON.stringify({ items: trimmed }, null, 2), "utf-8");
}

export function cleanupPendingOAuthStates(nowMs = Date.now()): void {
  const store = readStore();
  const alive = trimToMaxItems(
    store.items.filter((item) => item.createdAtMs + OAUTH_STATE_TTL_MS >= nowMs),
  );
  if (alive.length !== store.items.length) {
    writeStore({ items: alive });
  }
}

export function splitOAuthScopes(raw: string): string[] {
  return raw
    .split(/[,\s]+/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

export type CreateAuthorizeSessionInput = {
  userId: string;
  returnTo?: string;
  replay?: OAuthReplayPayload;
};

/**
 * 生成飞书用户授权页 URL，并登记 state（可选携带 IM 续跑上下文）。
 */
export function createFeishuUserAuthorizeSession(input: CreateAuthorizeSessionInput): {
  authUrl: string;
  state: string;
  expiresInMs: number;
} {
  const redirect = env.FEISHU_USER_OAUTH_REDIRECT_URI.trim();
  if (!redirect) {
    throw new Error("缺少 FEISHU_USER_OAUTH_REDIRECT_URI，无法启用用户授权通道");
  }
  cleanupPendingOAuthStates();
  const state = crypto.randomUUID();
  const store = readStore();
  const current = Date.now();
  // 同一用户仅保留最新授权会话，避免误点旧卡片导致 state 冲突。
  const filtered = store.items.filter((item) => item.userId !== input.userId);
  filtered.push({
    state,
    userId: input.userId,
    createdAtMs: current,
    replay: input.replay,
  });
  writeStore({ items: filtered });
  const scopes = splitOAuthScopes(env.FEISHU_USER_OAUTH_SCOPES);
  const authUrl = new URL(env.FEISHU_USER_OAUTH_AUTHORIZE_URL);
  /** 新版文档以 client_id + response_type=code 为准；部分旧域名校验 app_id，双写兼容 */
  authUrl.searchParams.set("client_id", env.FEISHU_APP_ID);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("app_id", env.FEISHU_APP_ID);
  authUrl.searchParams.set("redirect_uri", redirect);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("scope", scopes.join(" "));
  if (env.FEISHU_USER_OAUTH_PROMPT === "consent") {
    authUrl.searchParams.set("prompt", "consent");
  }
  if (input.returnTo?.trim()) {
    authUrl.searchParams.set("redirect", input.returnTo.trim());
  }
  return { authUrl: authUrl.toString(), state, expiresInMs: OAUTH_STATE_TTL_MS };
}

/** 消费并移除 state；不存在或过期则返回 null */
export function consumePendingOAuthState(state: string): PendingOAuthState | null {
  cleanupPendingOAuthStates();
  const store = readStore();
  const pending = store.items.find((item) => item.state === state);
  if (!pending) return null;
  writeStore({
    items: store.items.filter((item) => item.state !== state),
  });
  return {
    userId: pending.userId,
    createdAtMs: pending.createdAtMs,
    replay: pending.replay,
  };
}
