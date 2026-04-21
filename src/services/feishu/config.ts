import { env } from "../../config/env.js";

export type FeishuMode = "mock" | "real";

export type FeishuConfig = {
  mode: FeishuMode;
  appId: string;
  appSecret: string;
  domain: string;
  baseUrl: string;
  tokenRefreshBufferMs: number;
  /** 仅用于向用户/运维诊断，不含 secret */
  diagnostic: {
    requestedMode: "auto" | "true" | "false";
    hasAppId: boolean;
    hasAppSecret: boolean;
    resolvedReason: string;
  };
};

/**
 * 解析飞书运行模式：
 *   FEISHU_USE_MOCK = "true"           → mock（无论是否有凭证）
 *   FEISHU_USE_MOCK = "false"          → real（缺凭证会在工厂里降级回 mock 并打警告）
 *   FEISHU_USE_MOCK = "auto"（默认）   → 有完整凭证走 real，否则 mock
 */
export function resolveFeishuConfig(): FeishuConfig {
  const appId = env.FEISHU_APP_ID ?? "";
  const appSecret = env.FEISHU_APP_SECRET ?? "";
  const hasAppId = appId.length > 0;
  const hasAppSecret = appSecret.length > 0;
  const hasFullCreds = hasAppId && hasAppSecret;

  let mode: FeishuMode;
  let reason: string;

  switch (env.FEISHU_USE_MOCK) {
    case "true":
      mode = "mock";
      reason = "FEISHU_USE_MOCK=true（强制 mock）";
      break;
    case "false":
      mode = "real";
      reason = hasFullCreds
        ? "FEISHU_USE_MOCK=false 且凭证完整"
        : "FEISHU_USE_MOCK=false 但凭证缺失，适配器层会自动降级 mock";
      break;
    case "auto":
    default:
      mode = hasFullCreds ? "real" : "mock";
      reason = hasFullCreds
        ? "auto 模式：AppID + AppSecret 均已配置，启用真实飞书"
        : "auto 模式：飞书凭证缺失，使用 mock 数据源（这是正常开发态）";
      break;
  }

  const domain = env.FEISHU_DOMAIN;

  return {
    mode,
    appId,
    appSecret,
    domain,
    baseUrl: `https://${domain}/open-apis`,
    tokenRefreshBufferMs: env.FEISHU_TOKEN_REFRESH_BUFFER_MS,
    diagnostic: {
      requestedMode: env.FEISHU_USE_MOCK,
      hasAppId,
      hasAppSecret,
      resolvedReason: reason,
    },
  };
}
