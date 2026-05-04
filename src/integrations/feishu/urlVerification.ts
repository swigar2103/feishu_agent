import { env } from "../../config/env.js";

/**
 * 事件订阅「请求地址」校验：须在极短时间内返回 { challenge }。
 * 兼容：顶层 type；以及 schema 2.0（header.event_type 含 url_verification + event.challenge）。
 */
export function takeUrlVerificationChallenge(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, unknown>;

  const header =
    b.header && typeof b.header === "object" && !Array.isArray(b.header)
      ? (b.header as Record<string, unknown>)
      : undefined;
  const headerEventType =
    header && typeof header.event_type === "string" ? header.event_type : "";

  if (b.type === "url_verification" && typeof b.challenge === "string" && b.challenge.length > 0) {
    return b.challenge;
  }

  const ev = b.event;
  if (ev && typeof ev === "object" && !Array.isArray(ev)) {
    const e = ev as Record<string, unknown>;
    if (e.type === "url_verification" && typeof e.challenge === "string" && e.challenge.length > 0) {
      return e.challenge;
    }
    if (
      headerEventType.includes("url_verification") &&
      typeof e.challenge === "string" &&
      e.challenge.length > 0
    ) {
      return e.challenge;
    }
  }
  return null;
}

/** 若配置了 FEISHU_VERIFICATION_TOKEN，则请求中 token（顶层或 header）须一致。 */
export function feishuVerificationTokenMatches(raw: unknown): boolean {
  const expected = env.FEISHU_VERIFICATION_TOKEN?.trim();
  if (!expected) return true;
  if (!raw || typeof raw !== "object") return false;
  const b = raw as Record<string, unknown>;
  let token: string | undefined;
  if (typeof b.token === "string") token = b.token;
  else if (b.header && typeof b.header === "object" && !Array.isArray(b.header)) {
    const t = (b.header as Record<string, unknown>).token;
    if (typeof t === "string") token = t;
  }
  return token === expected;
}
