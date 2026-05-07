import dotenv from "dotenv";
import { performance } from "node:perf_hooks";

dotenv.config({ path: "D:/飞书办公Agent/.env" });
const base = process.env.BAILIAN_BASE_URL;
const key = process.env.BAILIAN_API_KEY;
const model = process.env.BAILIAN_MODEL_ORCHESTRATOR;

if (!base || !key || !model) {
  console.error("missing env", { hasBase: !!base, hasKey: !!key, hasModel: !!model });
  process.exit(1);
}

async function once(i) {
  const started = performance.now();
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: "你是助手。" },
        { role: "user", content: "请用一句话总结：今天完成了代码调试。" },
      ],
      temperature: 0.2,
      max_tokens: 80,
    }),
  });
  const text = await res.text();
  const cost = Math.round(performance.now() - started);
  return { i, status: res.status, cost, body: text.slice(0, 120) };
}

const runs = [];
for (let i = 1; i <= 5; i++) {
  try {
    runs.push(await once(i));
  } catch (e) {
    runs.push({ i, status: 0, cost: -1, body: String(e) });
  }
}
console.log(JSON.stringify({ base, model, runs }, null, 2));
