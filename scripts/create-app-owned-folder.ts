/**
 * 方案 B 辅助工具：应用亲自创建一个文件夹，并返回 folder_token。
 *
 * 使用方法：
 *   npx tsx scripts/create-app-owned-folder.ts
 *
 * 做完以后：
 *   1. 把输出里的 folder_token 粘到 .env 的 FEISHU_SEARCH_FOLDER_TOKEN=
 *   2. 用脚本打印的 "邀请链接" 或者手动到云盘里把自己加成协作者
 *   3. 往那个文件夹里上传/新建素材 docx
 */
import { resolveFeishuConfig } from "../src/services/feishu/config.js";
import { FeishuTokenManager } from "../src/services/feishu/tokenManager.js";
import { FeishuClient, FeishuApiError } from "../src/services/feishu/client.js";

const FOLDER_NAME = "Agent 素材库（应用托管）";

const cfg = resolveFeishuConfig();
const tm = new FeishuTokenManager(cfg);
const client = new FeishuClient(cfg, tm);

console.log(`=== 创建应用托管的云盘文件夹 ===`);
console.log(`folder_name: ${FOLDER_NAME}`);
console.log("");

try {
  const resp = await client.request<{ token: string; url?: string }>(
    "/drive/v1/files/create_folder",
    {
      method: "POST",
      body: { name: FOLDER_NAME },
    },
  );
  const token = resp?.token;
  const url = resp?.url;
  if (!token) {
    console.log("❌ 创建成功但返回里没拿到 token，原始返回：", resp);
    process.exit(1);
  }
  console.log("✅ 创建成功！");
  console.log("");
  console.log(`   folder_token = ${token}`);
  console.log(`   url          = ${url ?? "(飞书未返回 url，自己打开飞书云盘找同名文件夹即可)"}`);
  console.log("");
  console.log("👉 下一步：");
  console.log(`   1. 把 folder_token 粘到 .env：FEISHU_SEARCH_FOLDER_TOKEN=${token}`);
  console.log(`   2. 在飞书云盘里找到这个文件夹（名字："${FOLDER_NAME}"），把自己加成协作者`);
  console.log(`      （它是应用创建的，默认你这个用户看不到，需要应用把你加进去——见 .md 指引）`);
  console.log(`   3. 重启 npm run dev 并生成报告测试`);
} catch (err) {
  if (err instanceof FeishuApiError) {
    console.log(`❌ 创建文件夹失败：code=${err.code} msg=${err.message}`);
    console.log(`   raw=${JSON.stringify(err.raw).slice(0, 500)}`);
    if (err.code === 1061002 || /scope/i.test(err.message)) {
      console.log(`\n💡 看起来缺少权限。确保应用已开 "drive:drive" 或 "drive:drive:readonly"，并发布新版本。`);
    }
  } else {
    console.log("❌ 其他错误:", err);
  }
  process.exit(1);
}

process.exit(0);
