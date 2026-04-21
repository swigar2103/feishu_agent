import { env } from "../config/env.js";
import { logger } from "../shared/logger.js";

export type EmbeddingVector = number[];

type EmbeddingApiResponse = {
  data?: Array<{
    index?: number;
    embedding?: EmbeddingVector;
  }>;
};

/**
 * 调用百炼 /embeddings（OpenAI compatible-mode）获取一批文本的向量。
 * 失败时抛错，调用方负责优雅降级。
 */
export async function embedTexts(
  texts: string[],
  options?: { timeoutMs?: number },
): Promise<EmbeddingVector[]> {
  if (!env.BAILIAN_MODEL_EMBEDDING) {
    throw new Error("BAILIAN_MODEL_EMBEDDING 未配置");
  }
  if (texts.length === 0) return [];

  const controller = new AbortController();
  const timeoutMs = options?.timeoutMs ?? env.LLM_TIMEOUT_MS;
  const shouldUseTimeout = timeoutMs > 0;
  const timeout = shouldUseTimeout
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;

  try {
    const response = await fetch(`${env.BAILIAN_BASE_URL}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.BAILIAN_API_KEY}`,
      },
      body: JSON.stringify({
        model: env.BAILIAN_MODEL_EMBEDDING,
        input: texts,
        encoding_format: "float",
      }),
      signal: shouldUseTimeout ? controller.signal : undefined,
    });

    if (!response.ok) {
      const body = await response.text();
      logger.error("embedding 接口调用失败", { status: response.status, body });
      throw new Error(`embedding 调用失败: ${response.status}`);
    }

    const data = (await response.json()) as EmbeddingApiResponse;
    const entries = data.data ?? [];
    if (entries.length !== texts.length) {
      throw new Error(
        `embedding 返回数量不匹配: expected=${texts.length} actual=${entries.length}`,
      );
    }

    // 按 index 排序，防止乱序返回
    const sorted = [...entries].sort(
      (a, b) => (a.index ?? 0) - (b.index ?? 0),
    );
    const vectors = sorted.map((e) => e.embedding ?? []);
    if (vectors.some((v) => v.length === 0)) {
      throw new Error("embedding 返回存在空向量");
    }
    return vectors;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("embedding 调用超时");
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function embedSingle(text: string): Promise<EmbeddingVector> {
  const [v] = await embedTexts([text]);
  if (!v) throw new Error("embedding 返回为空");
  return v;
}

export function cosineSim(a: EmbeddingVector, b: EmbeddingVector): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const va = a[i]!;
    const vb = b[i]!;
    dot += va * vb;
    na += va * va;
    nb += vb * vb;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
