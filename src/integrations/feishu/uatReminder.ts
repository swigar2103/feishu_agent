import { env } from "../../config/env.js";

const lastRemindedAt = new Map<string, number>();

export function shouldRemindUat(userId: string, chatId?: string): boolean {
  const now = Date.now();
  const key = `${userId}::${chatId ?? "global"}`;
  const cooldownMs = env.FEISHU_UAT_REMIND_COOLDOWN_SECONDS * 1000;
  const last = lastRemindedAt.get(key) ?? 0;
  if (now - last < cooldownMs) return false;
  lastRemindedAt.set(key, now);
  return true;
}

