import fs from "node:fs";
import path from "node:path";
import { getWritableDataDir } from "./writableDataDir.js";

export type UserOAuthRecord = {
  userId: string;
  accessToken: string;
  refreshToken?: string;
  expiresAtMs: number;
  scopes: string[];
  grantedAtMs: number;
};

const FILE_PATH = path.join(getWritableDataDir(), "user-oauth-tokens.json");

type UserOAuthStoreData = {
  items: UserOAuthRecord[];
};

function readStore(): UserOAuthStoreData {
  if (!fs.existsSync(FILE_PATH)) {
    return { items: [] };
  }
  try {
    const raw = fs.readFileSync(FILE_PATH, "utf-8");
    const parsed = JSON.parse(raw) as UserOAuthStoreData;
    if (!Array.isArray(parsed.items)) return { items: [] };
    return parsed;
  } catch {
    return { items: [] };
  }
}

function writeStore(data: UserOAuthStoreData): void {
  fs.writeFileSync(FILE_PATH, JSON.stringify(data, null, 2), "utf-8");
}

export function upsertUserOAuthRecord(record: UserOAuthRecord): void {
  const store = readStore();
  const filtered = store.items.filter((item) => item.userId !== record.userId);
  filtered.push(record);
  writeStore({ items: filtered });
}

export function getUserOAuthRecord(userId: string): UserOAuthRecord | null {
  const store = readStore();
  const item = store.items.find((record) => record.userId === userId);
  if (!item) return null;
  return item;
}

export function hasValidUserOAuth(userId: string, nowMs = Date.now()): boolean {
  const record = getUserOAuthRecord(userId);
  if (!record) return false;
  return record.expiresAtMs > nowMs + 60_000;
}

