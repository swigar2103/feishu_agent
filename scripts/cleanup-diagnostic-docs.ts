/**
 * 清理 Phase 4.2 素材库文件夹里的"诊断残留"文档：
 *   - 扫 FEISHU_SEARCH_FOLDER_TOKEN 指向的文件夹
 *   - 找名字里含 "权限诊断" / "诊断" / "请手动删除" / "__test__" 等字样的 docx
 *   - 调 DELETE /drive/v1/files/{token}?type=docx 删除（应用是 owner，有权删）
 *
 * 不会动两篇正经素材 docx（云溪医疗/新光传媒），名字里没有"诊断"字样。
 *
 * 用法：
 *   npx tsx scripts/cleanup-diagnostic-docs.ts           → dry run（只打印不删）
 *   npx tsx scripts/cleanup-diagnostic-docs.ts --yes     → 真删
 */
import { resolveFeishuConfig } from "../src/services/feishu/config.js";
import { FeishuTokenManager } from "../src/services/feishu/tokenManager.js";
import { FeishuClient, FeishuApiError } from "../src/services/feishu/client.js";
import { env } from "../src/config/env.js";

const CONFIRM = process.argv.includes("--yes");
const folderToken = env.FEISHU_SEARCH_FOLDER_TOKEN ?? "";
if (!folderToken) {
  console.log("❌ FEISHU_SEARCH_FOLDER_TOKEN 未配置");
  process.exit(1);
}

const NAME_PATTERNS = [/权限诊断/, /请手动删除/, /__test__/i, /^__.*__$/];

const cfg = resolveFeishuConfig();
const tm = new FeishuTokenManager(cfg);
const client = new FeishuClient(cfg, tm);

console.log(`=== 清理素材库里的诊断残留 ===`);
console.log(`folder_token: ${folderToken}`);
console.log(`mode: ${CONFIRM ? "真删" : "dry-run（加 --yes 才真删）"}\n`);

const listed = await client.request<{ files?: Array<{ token: string; name: string; type: string }> }>(
  "/drive/v1/files",
  { method: "GET", query: { folder_token: folderToken, page_size: 100 } },
);
const files = listed?.files ?? [];
console.log(`文件夹下共 ${files.length} 个文件：`);
for (const f of files) {
  console.log(`  - [${f.type}] "${f.name}"  token=${f.token}`);
}

const toDelete = files.filter((f) => NAME_PATTERNS.some((p) => p.test(f.name)));
console.log(`\n匹配到 ${toDelete.length} 个待清理文件（按名字包含"权限诊断/请手动删除/__xxx__" 判断）：`);
for (const f of toDelete) {
  console.log(`  ✂  [${f.type}] ${f.name}`);
}
if (toDelete.length === 0) {
  console.log("无需清理，收工。");
  process.exit(0);
}
if (!CONFIRM) {
  console.log("\n(dry-run) 加 --yes 参数再跑一次即会真删。");
  process.exit(0);
}

let ok = 0;
let fail = 0;
for (const f of toDelete) {
  try {
    await client.request(`/drive/v1/files/${f.token}`, {
      method: "DELETE",
      query: { type: f.type },
    });
    console.log(`  ✅ 已删除: ${f.name}`);
    ok += 1;
  } catch (err) {
    console.log(
      `  ❌ 删除失败 "${f.name}": `,
      err instanceof FeishuApiError ? `code=${err.code} msg=${err.message}` : err,
    );
    fail += 1;
  }
}
console.log(`\n完成：成功 ${ok} 失败 ${fail}`);
process.exit(fail > 0 ? 1 : 0);
