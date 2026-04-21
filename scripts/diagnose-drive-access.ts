import { resolveFeishuConfig } from "../src/services/feishu/config.js";
import { FeishuTokenManager } from "../src/services/feishu/tokenManager.js";
import { FeishuClient, FeishuApiError } from "../src/services/feishu/client.js";
import { env } from "../src/config/env.js";

const cfg = resolveFeishuConfig();
const tm = new FeishuTokenManager(cfg);
const client = new FeishuClient(cfg, tm);
const folderToken = env.FEISHU_SEARCH_FOLDER_TOKEN ?? "";

console.log("=== Phase 4.2 云盘访问权限诊断 ===");
console.log("mode:", cfg.mode);
console.log("folder_token:", folderToken);
console.log("");

if (!folderToken) {
  console.log("❌ FEISHU_SEARCH_FOLDER_TOKEN 未配置");
  process.exit(1);
}

// 测试 1：列出目标文件夹下的文件
console.log("[1/3] 测试 /drive/v1/files?folder_token=...");
try {
  const data = await client.request<{ files?: Array<{ token: string; name: string; type: string }>; has_more?: boolean }>(
    "/drive/v1/files",
    { method: "GET", query: { folder_token: folderToken, page_size: 50 } },
  );
  const files = data?.files ?? [];
  console.log(`  ✅ 成功！文件夹下共 ${files.length} 个文件：`);
  for (const f of files) {
    console.log(`     - type=${f.type.padEnd(8)} name="${f.name}"  token=${f.token.slice(0, 10)}...`);
  }
} catch (err) {
  if (err instanceof FeishuApiError) {
    console.log(`  ❌ 失败`);
    console.log(`     code    = ${err.code}`);
    console.log(`     status  = ${err.httpStatus}`);
    console.log(`     message = ${err.message}`);
    console.log(`     raw     = ${JSON.stringify(err.raw).slice(0, 500)}`);
  } else {
    console.log("  ❌ 其他错误:", err);
  }
}

// 测试 2：列"我的空间"根目录（不指定 folder_token）
console.log("\n[2/3] 测试 /drive/v1/files （不带 folder_token，列根目录）");
try {
  const data = await client.request<{ files?: Array<{ token: string; name: string; type: string }> }>(
    "/drive/v1/files",
    { method: "GET", query: { page_size: 10 } },
  );
  const files = data?.files ?? [];
  console.log(`  ✅ 成功！根目录下 ${files.length} 个文件（前 10 个）`);
  for (const f of files.slice(0, 5)) {
    console.log(`     - type=${f.type.padEnd(8)} name="${f.name}"`);
  }
} catch (err) {
  if (err instanceof FeishuApiError) {
    console.log(`  ❌ code=${err.code} msg=${err.message}`);
    console.log(`     raw=${JSON.stringify(err.raw).slice(0, 500)}`);
  } else {
    console.log("  ❌ 其他错误:", err);
  }
}

// 测试 3：尝试在目标文件夹里创建文件（测写权限）
console.log("\n[3/3] 测试应用是否有该文件夹的写权限（发 /docx/v1/documents 带 folder_token）");
try {
  const data = await client.request<{ document?: { document_id: string } }>(
    "/docx/v1/documents",
    {
      method: "POST",
      body: { folder_token: folderToken, title: "__权限诊断_请手动删除__" },
    },
  );
  console.log(`  ✅ 写成功！临时文档已创建: ${data?.document?.document_id}`);
  console.log(`     这说明：应用有权访问这个文件夹！但读接口却 403，大概率是 drive 权限未发布`);
  console.log(`     请手动到云盘里把标题为 "__权限诊断_请手动删除__" 的文档删掉`);
} catch (err) {
  if (err instanceof FeishuApiError) {
    console.log(`  ❌ 写也失败 code=${err.code} msg=${err.message}`);
  } else {
    console.log("  ❌ 其他错误:", err);
  }
}

process.exit(0);
