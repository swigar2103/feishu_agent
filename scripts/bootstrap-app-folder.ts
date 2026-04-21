/**
 * Phase 4.2 一键 Bootstrap：方案 B（应用托管素材库）
 *
 * 这个脚本做三件事：
 *   1. 应用亲自创建一个文件夹 "Agent 素材库（应用托管）"
 *      （应用是 owner，天然有读写权限，不需要 UI 分享）
 *   2. 调 /drive/v1/permissions/{token}/members 把"你"加成文件夹 editor
 *      （让你在自己的飞书云盘里也能看到这个文件夹、并且能往里加文件）
 *   3. 在文件夹里直接创建 2 篇预置素材：
 *        - 云溪医疗集团 · 本周运营简报
 *        - 新光传媒集团 · 本周新闻播报与舆情简报
 *      （省得你手动复制粘贴）
 *
 * 跑完把输出里的 folder_token 粘到 .env 的 FEISHU_SEARCH_FOLDER_TOKEN=
 * 重启服务器 → 生成报告 → 直接命中素材
 *
 * 用法：
 *   npx tsx scripts/bootstrap-app-folder.ts
 *
 * 依赖权限（应该都已经有了）：
 *   - drive:drive
 *   - docx:document
 */
import { resolveFeishuConfig } from "../src/services/feishu/config.js";
import { FeishuTokenManager } from "../src/services/feishu/tokenManager.js";
import { FeishuClient, FeishuApiError } from "../src/services/feishu/client.js";
import {
  createDocument,
  buildDocUrl,
} from "../src/services/feishu/docxWriter.js";

// ---- 配置 ----
const FOLDER_NAME = "Agent 素材库（应用托管）";
// 邀请这个用户成为文件夹 editor（就是你自己，之前给过的 open_id）
const USER_OPEN_ID = "ou_a1d401994aa81026086ee8c3457d3b1f";

// ---- 两篇预置素材 ----
type Material = { title: string; blocks: Array<Record<string, unknown>> };

function textBlock(content: string): Record<string, unknown> {
  return {
    block_type: 2,
    text: { elements: [{ text_run: { content: content || "—" } }], style: {} },
  };
}
function heading(content: string, level: 1 | 2 | 3): Record<string, unknown> {
  const blockType = level === 1 ? 3 : level === 2 ? 4 : 5;
  const key = `heading${level}` as const;
  return {
    block_type: blockType,
    [key]: { elements: [{ text_run: { content: content || "—" } }], style: {} },
  };
}
function bullet(content: string): Record<string, unknown> {
  return {
    block_type: 12,
    bullet: { elements: [{ text_run: { content: content || "—" } }], style: {} },
  };
}
function divider(): Record<string, unknown> {
  return { block_type: 22, divider: {} };
}

const MATERIALS: Material[] = [
  {
    title: "云溪医疗集团 · 本周运营简报",
    blocks: [
      heading("云溪医疗集团 · 本周运营简报", 1),
      textBlock("统计周期：2026 年第 15 周（4 月 6 日 – 4 月 12 日）。所属业务：三级综合医院门急诊与住院运营。"),
      divider(),
      heading("一、核心 KPI 表现", 2),
      bullet("门急诊人次：32,580，环比 +4.8%，同比 +11.2%。周五下午内科拥堵明显。"),
      bullet("住院量：1,204 人次，环比 -2.1%，主要受骨科择期手术周四停机维护影响。"),
      bullet("手术台次：486 台，环比 +1.3%；日间手术占比 37.5%，较上周持平。"),
      bullet("平均住院日：6.8 天，同比 -0.3 天。"),
      bullet("药占比：28.4%，低于考核红线 30%；耗占比 18.9%。"),
      heading("二、重点事项进展", 2),
      bullet("DRG 精细化管理项目：内分泌科试点已完成第二轮病组拆分，入组率提升至 84%。"),
      bullet("互联网医院升级：新版支付链路灰度上线至 30% 流量，平均支付时长由 42s 下降至 27s。"),
      bullet("医保飞检准备：已完成 2025Q4 全部住院病历自查，新发现问题单 11 条，已全部整改闭环。"),
      heading("三、风险与行动项", 2),
      bullet("合规风险：支付流程较竞品多 2 个跳转页面，患者投诉主要集中在老年用户群。拟在第 16 周前完成一次性授权改造。"),
      bullet("质控风险：心内科 CMI 值连续 3 周低于 1.05，需核查编码准确性。"),
      bullet("供应链风险：骨科高值耗材库存周转 62 天，高于目标 45 天，采购部门已启动议价。"),
      heading("四、下周重点", 2),
      bullet("完成互联网医院支付链路 100% 放量。"),
      bullet("启动老年友好型就医流程专项。"),
      bullet("召开季度 DRG 复盘会，拉齐 10 个试点科室指标。"),
    ],
  },
  {
    title: "新光传媒集团 · 本周新闻播报与舆情简报",
    blocks: [
      heading("新光传媒集团 · 本周新闻播报与舆情简报", 1),
      textBlock("统计周期：2026 年第 15 周（4 月 6 日 – 4 月 12 日）。所属业务：新闻内容生产与多端分发。"),
      divider(),
      heading("一、内容生产与分发", 2),
      bullet("本周共发布稿件 1,842 篇，环比 +6.4%；其中原创深度稿 128 篇，占比 6.9%。"),
      bullet("视频号累计播放量 2,310 万次，环比 +18%，《中国制造业走出去》系列贡献 31% 流量。"),
      bullet("公众号图文平均阅读完成率 58.2%，同比上升 4.6pp。"),
      bullet("客户端 DAU 峰值 478 万，出现在 4 月 9 日（突发新闻当日）。"),
      heading("二、舆情与热点事件", 2),
      bullet("重点跟踪事件：某地方政务热点，本周相关话题阅读量累计 1.2 亿，本集团报道占声量 14.3%，高于行业均值。"),
      bullet("负面舆情：一篇财经评论遭部分读者投诉用词过激，评论区关闭 6 小时并发布修正说明；已完成内部复盘。"),
      bullet("正面舆情：乡村振兴系列报道获省级宣传部门转发 3 次，获得行业奖项提名 1 项。"),
      heading("三、业务风险与改进", 2),
      bullet("合规风险：AIGC 辅助稿件占比 11%，需按最新管理办法补足显著标识，预计第 16 周完成改造。"),
      bullet("内容风险：突发新闻首发率 41%，低于年度目标 50%，拟调整 24 小时值班编辑排班。"),
      bullet("商业化风险：品牌广告 RPM 同比 -7%，主要受视频贴片库存下降影响。"),
      heading("四、下周重点", 2),
      bullet("上线 AIGC 稿件统一水印与标识系统。"),
      bullet("启动第二季度大型策划选题会，聚焦消费、科技、医疗三条主线。"),
      bullet("对客户端推送策略做 A/B 测试，目标提升晚间时段打开率 2pp。"),
    ],
  },
];

// ---- 主流程 ----
const cfg = resolveFeishuConfig();
const tm = new FeishuTokenManager(cfg);
const client = new FeishuClient(cfg, tm);

console.log("=== Phase 4.2 一键 Bootstrap（应用托管素材库）===\n");

// Step 1: 创建文件夹（先查应用自己"我的空间"根目录 token 作为 parent）
console.log(`[1/3] 创建文件夹 "${FOLDER_NAME}" ...`);
let folderToken = "";
try {
  // 1a. 查应用"我的空间"根目录 token
  const rootMeta = await client.request<{ token: string; id?: string }>(
    "/drive/explorer/v2/root_folder/meta",
    { method: "GET" },
  );
  const rootToken = rootMeta?.token;
  if (!rootToken) {
    console.log("  ❌ 取应用根目录 token 失败，返回：", rootMeta);
    process.exit(1);
  }
  console.log(`     (parent root folder token = ${rootToken})`);

  // 1b. 在应用根目录下建子文件夹
  const resp = await client.request<{ token: string; url?: string }>(
    "/drive/v1/files/create_folder",
    { method: "POST", body: { name: FOLDER_NAME, folder_token: rootToken } },
  );
  if (!resp?.token) {
    console.log("  ❌ 返回里没拿到 token：", resp);
    process.exit(1);
  }
  folderToken = resp.token;
  console.log(`  ✅ folder_token = ${folderToken}`);
  if (resp.url) console.log(`     url         = ${resp.url}`);
} catch (err) {
  console.log("  ❌ 建文件夹失败：", err instanceof FeishuApiError ? `code=${err.code} msg=${err.message}` : err);
  process.exit(1);
}

// Step 2: 把用户加成 editor
console.log(`\n[2/3] 把用户 open_id=${USER_OPEN_ID} 加成该文件夹的 editor ...`);
try {
  const resp = await client.request<unknown>(
    `/drive/v1/permissions/${folderToken}/members`,
    {
      method: "POST",
      query: { type: "folder", need_notification: false },
      body: {
        member_type: "openid",
        member_id: USER_OPEN_ID,
        perm: "edit",
      },
    },
  );
  console.log("  ✅ 协作者添加成功（你现在能在自己的飞书云盘里看到这个文件夹了）");
  void resp;
} catch (err) {
  if (err instanceof FeishuApiError) {
    console.log(`  ⚠️ 加协作者失败 code=${err.code} msg=${err.message}`);
    console.log("     （文件夹已建好，但你在自己云盘里可能看不见。主流程检索不受影响——应用自己读得到。）");
    console.log("     如果你想在飞书云盘里手动往这个文件夹放文件，补一下 drive:drive 或 im:chat:recommend 这类权限再试。");
  } else {
    console.log("  ⚠️ 其他错误（不阻断）：", err);
  }
}

// Step 3: 在文件夹里建两篇素材 docx
console.log(`\n[3/3] 在文件夹里创建 ${MATERIALS.length} 篇预置素材 docx ...`);
const created: Array<{ title: string; id: string; url: string }> = [];
for (const mat of MATERIALS) {
  try {
    const doc = await createDocument(client, { title: mat.title, folderToken });
    // 写入 blocks（30 条一批）
    const BATCH = 30;
    for (let i = 0; i < mat.blocks.length; i += BATCH) {
      const chunk = mat.blocks.slice(i, i + BATCH);
      await client.request(
        `/docx/v1/documents/${doc.documentId}/blocks/${doc.documentId}/children`,
        {
          method: "POST",
          query: { document_revision_id: -1 },
          body: { children: chunk, index: -1 },
        },
      );
    }
    console.log(`  ✅ ${mat.title}`);
    console.log(`     url = ${doc.url}`);
    created.push({ title: mat.title, id: doc.documentId, url: doc.url });
  } catch (err) {
    console.log(
      `  ❌ "${mat.title}" 创建失败：`,
      err instanceof FeishuApiError ? `code=${err.code} msg=${err.message}` : err,
    );
  }
}

// 总结
console.log("\n=== 完成 ===");
console.log(`✅ folder_token = ${folderToken}`);
console.log(`✅ 共创建 ${created.length}/${MATERIALS.length} 篇素材 docx`);
console.log("\n👉 下一步：");
console.log(`   1. 把下面这行粘到 .env（替换现有 FEISHU_SEARCH_FOLDER_TOKEN=）：`);
console.log(`      FEISHU_SEARCH_FOLDER_TOKEN=${folderToken}`);
console.log(`   2. 重启服务器：Ctrl+C 停掉 npm run dev，再 npm run dev`);
console.log(`   3. 跑诊断确认：npx tsx scripts/diagnose-drive-access.ts`);
console.log(`      预期测试 [1/3] ✅ 返回 ${created.length} 个 docx 文件`);
console.log(`   4. 浏览器 http://localhost:3000 生成一份医疗运营周报，看命中情况`);
console.log("");
void buildDocUrl;
process.exit(0);
