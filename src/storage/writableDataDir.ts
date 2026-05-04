import fs from "node:fs";
import path from "node:path";
import { env } from "../config/env.js";

/**
 * 可写 JSON 状态目录（记忆、资源池快照等）。
 * - 本地默认：<cwd>/src/data
 * - Vercel Serverless：/tmp/feishu-agent-data（仅 /tmp 可写）
 * - 可用 FEISHU_WRITABLE_DATA_DIR 覆盖
 */
export function getWritableDataDir(): string {
  const override = env.FEISHU_WRITABLE_DATA_DIR?.trim();
  const dir = override
    ? path.resolve(override)
    : process.env.VERCEL === "1"
      ? "/tmp/feishu-agent-data"
      : path.resolve(process.cwd(), "src", "data");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
