/**
 * 端到端快速 smoke：跑一次 searchEverything，看真实检索 sources 字段里出现
 * drive_docx(N) + im_messages(error) 两路并存，证明降级链路没踩到坑。
 */
import { createFeishuAdapter, FeishuRealAdapter } from "../src/services/retrieval/feishuAdapter.js";

const { adapter } = createFeishuAdapter();
console.log("adapter mode:", adapter.mode);
if (adapter instanceof FeishuRealAdapter) {
  console.log("(health check)", await adapter.healthCheck());
}

const query = "支付流程优化 门急诊量";
console.log(`\n跑 searchEverything("${query}") ...`);
const results = await adapter.searchEverything(query);
console.log(`\n返回 ${results.length} 条素材：`);
for (const r of results) {
  console.log(`  [${r.sourceType}] ${r.sourceId}`);
  console.log(`      ${r.content.split("\n")[0].slice(0, 80)}...`);
}
process.exit(0);
