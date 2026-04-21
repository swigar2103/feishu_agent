/**
 * Phase 4.3 IM 群消息读权限诊断。
 *
 * 分 3 步检查：
 *   [1/3] 拉一条消息，确认 im:message(.readonly) 权限是否已开
 *   [2/3] 抽样确认 msg_type 分布和文本长度（防止群里全是图片/表情导致零命中）
 *   [3/3] 针对一个示例 query 跑一遍关键词打分，估计命中率
 *
 * 用法：
 *   npx tsx scripts/diagnose-im-access.ts
 *   npx tsx scripts/diagnose-im-access.ts "支付流程"   # 自定义 query
 */
import { env } from "../src/config/env.js";
import { resolveFeishuConfig } from "../src/services/feishu/config.js";
import { FeishuApiError, FeishuClient } from "../src/services/feishu/client.js";
import { FeishuTokenManager } from "../src/services/feishu/tokenManager.js";
import { searchMessagesInChat } from "../src/services/feishu/imSearch.js";

const queryArg = process.argv[2] ?? "支付流程优化";

const chatId = env.FEISHU_SEARCH_CHAT_ID?.trim() || env.FEISHU_NOTIFY_CHAT_ID?.trim();
if (!chatId) {
  console.log("❌ 没有配置 FEISHU_SEARCH_CHAT_ID，也没有 FEISHU_NOTIFY_CHAT_ID，无从测起");
  process.exit(1);
}

console.log("=== Phase 4.3 IM 群消息检索诊断 ===");
console.log(`chat_id = ${chatId}`);
console.log(`query   = "${queryArg}"`);
console.log(`window  = ${env.FEISHU_SEARCH_IM_WINDOW_HOURS} 小时`);
console.log(`limit   = 最多扫 ${env.FEISHU_SEARCH_IM_LIMIT} 条\n`);

const cfg = resolveFeishuConfig();
const tm = new FeishuTokenManager(cfg);
const client = new FeishuClient(cfg, tm);

// ---- [1/3] 拉一条消息 ----
console.log("[1/3] 拉 1 条最新消息（验证 im:message 或 im:message:readonly 权限）");
try {
  const data = await client.request<{ items?: Array<{ message_id: string; msg_type?: string; create_time?: string }> }>(
    "/im/v1/messages",
    {
      method: "GET",
      query: {
        container_id_type: "chat",
        container_id: chatId,
        sort_type: "ByCreateTimeDesc",
        page_size: 1,
      },
    },
  );
  const items = data?.items ?? [];
  if (items.length === 0) {
    console.log("  ⚠️ 接口返回空——可能群里真的没消息，也可能 chat_id 不对");
  } else {
    const one = items[0];
    const t = one?.create_time ? new Date(Number(one.create_time)).toISOString() : "?";
    console.log(`  ✅ 成功！最新一条: message_id=${one?.message_id?.slice(0, 10)}... msg_type=${one?.msg_type} create_time=${t}`);
  }
} catch (err) {
  if (err instanceof FeishuApiError) {
    console.log(`  ❌ code=${err.code} msg=${err.message}`);
    if (err.code === 230027 || /im:message\.group_msg|im:message\.p2p_msg|necessary permissions/i.test(err.message)) {
      console.log(`\n💡 缺少读取群聊消息的权限 scope。错误信息里 need scope 就是要开的那个。`);
      console.log(`   操作路径：`);
      console.log(`     1. https://open.feishu.cn/app → 你的应用 → "权限管理"`);
      console.log(`     2. 搜 "im:message.group_msg"（读群消息）/ "im:message.p2p_msg"（读私聊，可选）`);
      console.log(`     3. 都勾上 → 保存`);
      console.log(`     4. 回到 "版本管理与发布" → 创建新版本 → 发布（管理员审批）`);
      console.log(`     5. 应用发版审批通过后，再跑这个诊断应该就能过 [1/3] 了`);
    } else if (err.code === 1061002 || /scope/i.test(err.message)) {
      console.log(`\n💡 scope 不够，看错误里的 need scope 去开发者后台开对应权限，发版后重试。`);
    } else if (/bot|chat/i.test(err.message)) {
      console.log(`\n💡 应用可能还没加入这个群，去群里 @机器人 或者 群设置 → 添加成员。`);
    }
    process.exit(1);
  }
  throw err;
}

// ---- [2/3] 抽样 msg_type 分布 ----
console.log("\n[2/3] 抽样最近 30 条消息，看 msg_type 分布");
try {
  const data = await client.request<{ items?: Array<{ msg_type?: string; body?: { content?: string } }> }>(
    "/im/v1/messages",
    {
      method: "GET",
      query: {
        container_id_type: "chat",
        container_id: chatId,
        sort_type: "ByCreateTimeDesc",
        page_size: 30,
      },
    },
  );
  const items = data?.items ?? [];
  const dist = new Map<string, number>();
  let textLen = 0;
  let textCnt = 0;
  for (const m of items) {
    const t = m.msg_type ?? "unknown";
    dist.set(t, (dist.get(t) ?? 0) + 1);
    if (t === "text" && m.body?.content) {
      try {
        const parsed = JSON.parse(m.body.content) as { text?: string };
        if (typeof parsed.text === "string") {
          textLen += parsed.text.length;
          textCnt += 1;
        }
      } catch {
        /* ignore */
      }
    }
  }
  console.log(`  扫到 ${items.length} 条消息，msg_type 分布：`);
  for (const [t, n] of [...dist.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`     ${t.padEnd(14)} ${n}`);
  }
  if (textCnt > 0) {
    console.log(`  文本消息平均长度 = ${Math.round(textLen / textCnt)} 字`);
  } else {
    console.log("  ⚠️ 近 30 条里没有文本消息（全是卡片/图片/系统消息）——检索很难命中");
  }
} catch (err) {
  console.log(
    "  ⚠️ 分布抽样失败：",
    err instanceof FeishuApiError ? `code=${err.code} msg=${err.message}` : err,
  );
}

// ---- [3/3] 跑一次真实打分 ----
console.log(`\n[3/3] 用 query="${queryArg}" 跑一次实际打分`);
try {
  const hits = await searchMessagesInChat(client, {
    chatId,
    query: queryArg,
    limit: env.FEISHU_SEARCH_IM_LIMIT,
    topK: env.FEISHU_SEARCH_IM_TOP_K,
    windowHours: env.FEISHU_SEARCH_IM_WINDOW_HOURS,
  });
  console.log(`  命中 ${hits.length} 条（Top ${env.FEISHU_SEARCH_IM_TOP_K}）：`);
  for (const h of hits) {
    console.log(`     [score=${h.score.toFixed(2)}] ${h.snippet.slice(0, 80)}...`);
  }
  if (hits.length === 0) {
    console.log("  💡 零命中常见原因：");
    console.log("     - 群里最近讨论跟 query 不相关（正常，发几条相关的再试）");
    console.log("     - 群里全是卡片/图片 → 上面 [2/3] msg_type 分布能看出来");
    console.log(`     - 时间窗口 ${env.FEISHU_SEARCH_IM_WINDOW_HOURS}h 太短，调大 FEISHU_SEARCH_IM_WINDOW_HOURS`);
  }
} catch (err) {
  console.log("  ❌ 打分调用失败：", err instanceof FeishuApiError ? `code=${err.code} msg=${err.message}` : err);
}

console.log("\n完成。");
process.exit(0);
