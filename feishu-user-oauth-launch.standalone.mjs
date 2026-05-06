#!/usr/bin/env node
/**
 * 飞书「用户 OAuth」授权链接生成器（独立单文件，无 tsx、无相对路径引用）。
 *
 * 与仓库内 `feishu-user-oauth-launch.ts` + `userOAuthAuthorizeFlow.createFeishuUserAuthorizeSession`
 * 行为一致：生成 authUrl、写入 oauth-pending-states.json（与回调共用同一 state）。
 *
 * 使用方式（在**已配置 .env 的项目根目录**执行， cwd 决定读哪个 .env 与默认数据目录）：
 *   node scripts/feishu-user-oauth-launch.standalone.mjs ou_xxxxxxxx
 *   node scripts/feishu-user-oauth-launch.standalone.mjs ou_xxxxxxxx --open
 *
 * 可把本文件单独拷贝到同学项目根目录运行：
 *   node feishu-user-oauth-launch.standalone.mjs ou_xxx --open
 *
 * 依赖：Node 18+（内置 fetch 非必需；仅用 fs/path/crypto/child_process）。
 * 环境变量：与主项目相同，见下方「必填环境变量」。需在进程 cwd 下存在 `.env`，或已由外部注入环境变量。
 *
 * 注意：浏览器里完成授权的必须是该 open_id 对应的真实用户；回调服务须在线且能写入同一路径的 oauth-pending-states.json。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/** ---------- 轻量 .env 加载（不依赖 dotenv 包） ---------- */
function loadEnvFromFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, "utf-8");
  for (const line of raw.split(/\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined || process.env[key] === "") {
      process.env[key] = val;
    }
  }
}

/** 优先：脚本所在目录的上一级（常用于 scripts/xxx.mjs）、再尝试 cwd */
function resolveEnvFiles() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(process.cwd(), ".env"),
    path.join(scriptDir, "..", ".env"),
    path.join(scriptDir, ".env"),
  ];
  for (const p of candidates) {
    loadEnvFromFile(path.resolve(p));
  }
}

function getWritableDataDir() {
  const override = (process.env.FEISHU_WRITABLE_DATA_DIR || "").trim();
  const dir = override
    ? path.resolve(override)
    : process.env.VERCEL === "1"
      ? "/tmp/feishu-agent-data"
      : path.resolve(process.cwd(), "src", "data");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function splitOAuthScopes(raw) {
  return (raw || "")
    .split(/[\s,]+/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

function trimToMaxItems(items, maxItems) {
  if (items.length <= maxItems) return items;
  return items
    .slice()
    .sort((a, b) => b.createdAtMs - a.createdAtMs)
    .slice(0, maxItems);
}

function readStore(filePath) {
  if (!fs.existsSync(filePath)) return { items: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (!Array.isArray(parsed.items)) return { items: [] };
    return parsed;
  } catch {
    return { items: [] };
  }
}

function writeStore(filePath, data, maxItems) {
  const trimmed = trimToMaxItems(data.items, maxItems);
  fs.writeFileSync(filePath, JSON.stringify({ items: trimmed }, null, 2), "utf-8");
}

function cleanupPendingOAuthStates(filePath, maxItems, nowMs = Date.now()) {
  const store = readStore(filePath);
  const alive = trimToMaxItems(
    store.items.filter((item) => item.createdAtMs + OAUTH_STATE_TTL_MS >= nowMs),
    maxItems,
  );
  if (alive.length !== store.items.length) {
    writeStore(filePath, { items: alive }, maxItems);
  }
}

function createFeishuUserAuthorizeSession(input) {
  const redirect = (process.env.FEISHU_USER_OAUTH_REDIRECT_URI || "").trim();
  if (!redirect) {
    throw new Error("缺少 FEISHU_USER_OAUTH_REDIRECT_URI，无法启用用户授权通道");
  }
  const appId = (process.env.FEISHU_APP_ID || "").trim();
  if (!appId) {
    throw new Error("缺少 FEISHU_APP_ID");
  }

  const pendingMax = Number.parseInt(process.env.FEISHU_OAUTH_PENDING_STATE_MAX_ITEMS || "200", 10) || 200;
  const storePath = path.join(getWritableDataDir(), "oauth-pending-states.json");

  cleanupPendingOAuthStates(storePath, pendingMax);

  const state = crypto.randomUUID();
  const store = readStore(storePath);
  const current = Date.now();
  const filtered = store.items.filter((item) => item.userId !== input.userId);
  filtered.push({
    state,
    userId: input.userId,
    createdAtMs: current,
    replay: input.replay,
  });
  writeStore(storePath, { items: filtered }, pendingMax);

  const scopes = splitOAuthScopes(
    process.env.FEISHU_USER_OAUTH_SCOPES ||
      "drive:drive drive:drive.search:readonly search:docs:read docx:document",
  );
  const authorizeBase =
    (process.env.FEISHU_USER_OAUTH_AUTHORIZE_URL || "").trim() ||
    "https://open.feishu.cn/open-apis/authen/v1/authorize";

  const authUrl = new URL(authorizeBase);
  authUrl.searchParams.set("client_id", appId);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("app_id", appId);
  authUrl.searchParams.set("redirect_uri", redirect);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("scope", scopes.join(" "));
  if ((process.env.FEISHU_USER_OAUTH_PROMPT || "").trim() === "consent") {
    authUrl.searchParams.set("prompt", "consent");
  }
  if (input.returnTo?.trim()) {
    authUrl.searchParams.set("redirect", input.returnTo.trim());
  }

  return { authUrl: authUrl.toString(), state, expiresInMs: OAUTH_STATE_TTL_MS, storePath };
}

function parseArgs(argv) {
  const raw = argv.slice(2).filter((a) => a !== "--");
  let openBrowser = false;
  const args = raw.filter((a) => {
    if (a === "--open" || a === "-o") {
      openBrowser = true;
      return false;
    }
    return true;
  });
  let userId = "";
  for (const a of args) {
    if (a.startsWith("--userId=")) userId = a.slice("--userId=".length).trim();
    else if (!userId && !a.startsWith("-")) userId = a.trim();
  }
  return { userId, openBrowser };
}

function tryOpenUrl(url) {
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  if (process.platform === "darwin") {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  try {
    spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  } catch {
    console.warn("无法自动打开浏览器，请手动复制下方 URL。");
  }
}

function main() {
  resolveEnvFiles();

  const { userId, openBrowser } = parseArgs(process.argv);
  if (!userId) {
    console.error(
      [
        "缺少 userId（飞书 open_id，须与 IM / 探针使用的 ou_xxx 一致）。",
        "",
        "示例：",
        "  node feishu-user-oauth-launch.standalone.mjs ou_ec074de53e44c0829c0344144e472677",
        "  node feishu-user-oauth-launch.standalone.mjs ou_ec074de53e44c0829c0344144e472677 --open",
        "",
        "必填环境变量（.env 或系统环境）：",
        "  FEISHU_APP_ID",
        "  FEISHU_USER_OAUTH_REDIRECT_URI  （须与开放平台「重定向 URL」一致，且回调服务可访问）",
        "可选：",
        "  FEISHU_USER_OAUTH_SCOPES",
        "  FEISHU_USER_OAUTH_AUTHORIZE_URL",
        "  FEISHU_USER_OAUTH_PROMPT=consent",
        "  FEISHU_OAUTH_PENDING_STATE_MAX_ITEMS",
        "  FEISHU_WRITABLE_DATA_DIR  （oauth-pending-states.json 所在目录，默认 <cwd>/src/data）",
      ].join("\n"),
    );
    process.exit(1);
  }

  try {
    const { authUrl, state, expiresInMs, storePath } = createFeishuUserAuthorizeSession({ userId });
    console.log("userId:", userId);
    console.log("state: ", state);
    console.log("pending file:", storePath);
    console.log("TTL(ms):", expiresInMs, `（约 ${Math.round(expiresInMs / 60_000)} 分钟内需在浏览器完成授权）`);
    console.log("");
    console.log("请在浏览器打开以下链接并完成飞书授权：");
    console.log(authUrl);
    console.log("");
    console.log(
      "完成后须保证回调 URL 对应的服务正在运行，且能读写上述 pending 文件路径上的 oauth-pending-states.json。",
    );

    if (openBrowser) {
      tryOpenUrl(authUrl);
      console.log("（已尝试用系统默认浏览器打开）");
    }
  } catch (e) {
    console.error(
      "生成授权链接失败：",
      e instanceof Error ? e.message : e,
      "\n请检查 FEISHU_APP_ID、FEISHU_USER_OAUTH_REDIRECT_URI、FEISHU_USER_OAUTH_AUTHORIZE_URL 等。",
    );
    process.exit(1);
  }
}

main();
