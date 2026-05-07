import { env } from "../config/env.js";
import { logger } from "../shared/logger.js";

let warnedLlmZeroTimeout = false;
const jsonResponseFormatUnsupportedModels = new Set<string>();

export type LlmInvokeOptions = {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  jsonMode?: boolean;
  timeoutMs?: number;
};

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: unknown;
      reasoning_content?: string;
      tool_calls?: Array<{
        function?: {
          arguments?: string;
        };
      }>;
    };
  }>;
};

type ChatMessage = NonNullable<ChatCompletionResponse["choices"]>[number]["message"];
type ChatToolCall = NonNullable<NonNullable<ChatMessage>["tool_calls"]>[number];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 429 || status === 503 || status === 504;
}

/** 百炼侧 RequestTimeOut、限流等可经重试缓解 */
function isRetryableBailianError(status: number, bodyText: string): boolean {
  if (isRetryableHttpStatus(status)) return true;
  if (status !== 500) return false;
  const lower = bodyText.toLowerCase();
  if (lower.includes("request timed out") || lower.includes("requesttimeout")) {
    return true;
  }
  try {
    const j = JSON.parse(bodyText) as {
      error?: { code?: string; type?: string; message?: string };
    };
    const code = `${j.error?.code ?? ""}${j.error?.type ?? ""}`;
    if (code.includes("RequestTimeOut") || code.includes("Timeout")) return true;
    if (String(j.error?.message ?? "")
      .toLowerCase()
      .includes("timed out")) {
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

function isUnsupportedJsonResponseFormat(status: number, bodyText: string): boolean {
  if (status !== 400) return false;
  const lower = bodyText.toLowerCase();
  return lower.includes("response_format.type")
    && lower.includes("json_object")
    && (lower.includes("not supported by this model") || lower.includes("not valid"));
}

function normalizeContent(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    const text = content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") {
          const maybeText = (item as { text?: unknown }).text;
          if (typeof maybeText === "string") return maybeText;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
    return text;
  }

  if (content && typeof content === "object") {
    return JSON.stringify(content);
  }

  return "";
}

function pickMessageText(message: ChatMessage): string {
  if (!message) return "";

  const contentText = normalizeContent(message.content);
  if (contentText) return contentText;

  const reasoningText = message.reasoning_content?.trim();
  if (reasoningText) {
    logger.warn("LLM content 为空，回退使用 reasoning_content");
    return reasoningText;
  }

  const toolArgs = message.tool_calls
    ?.map((call: ChatToolCall) => call.function?.arguments?.trim() ?? "")
    .find(Boolean);
  if (toolArgs) {
    logger.warn("LLM content 为空，回退使用 tool_calls.arguments");
    return toolArgs;
  }

  return "";
}

export async function invokeBailianModel(
  options: LlmInvokeOptions,
): Promise<string> {
  const configured = options.timeoutMs ?? env.LLM_TIMEOUT_MS;
  const timeoutMs =
    configured > 0 ? configured : env.LLM_ZERO_TIMEOUT_FALLBACK_MS;
  if (configured <= 0 && !warnedLlmZeroTimeout) {
    warnedLlmZeroTimeout = true;
    logger.warn(
      "LLM_TIMEOUT_MS 为 0，已改用 LLM_ZERO_TIMEOUT_FALLBACK_MS 作为单次调用超时，避免对百炼的请求永久挂起",
      { fallbackMs: timeoutMs },
    );
  }

  const maxAttempts = 1 + env.LLM_HTTP_RETRIES;
  let lastError: Error = new Error("LLM 调用失败");
  let preferJsonResponseFormat =
    Boolean(options.jsonMode) && !jsonResponseFormatUnsupportedModels.has(options.model);

  for (let attempt = 1; attempt <= maxAttempts;) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const payload: Record<string, unknown> = {
        model: options.model,
        messages: [
          { role: "system", content: options.systemPrompt },
          { role: "user", content: options.userPrompt },
        ],
        temperature: 0.2,
      };

      if (preferJsonResponseFormat) {
        payload.response_format = { type: "json_object" };
      }

      const response = await fetch(`${env.BAILIAN_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.BAILIAN_API_KEY}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      const bodyText = await response.text();

      if (!response.ok) {
        logger.error("百炼接口调用失败", {
          status: response.status,
          body: bodyText.slice(0, 800),
          attempt,
          maxAttempts,
        });
        lastError = new Error(`LLM 调用失败: ${response.status}`);

        if (preferJsonResponseFormat && isUnsupportedJsonResponseFormat(response.status, bodyText)) {
          jsonResponseFormatUnsupportedModels.add(options.model);
          logger.warn("当前模型不支持 response_format=json_object，自动回退为提示词约束 JSON 模式", {
            model: options.model,
          });
          preferJsonResponseFormat = false;
          continue;
        }

        const retryable =
          attempt < maxAttempts && isRetryableBailianError(response.status, bodyText);
        if (retryable) {
          const wait =
            env.LLM_RETRY_BACKOFF_MS > 0 ? env.LLM_RETRY_BACKOFF_MS * attempt : 0;
          logger.warn("百炼返回可重试错误，稍后重试", {
            attempt,
            nextInMs: wait,
            status: response.status,
          });
          if (wait > 0) await sleep(wait);
          attempt += 1;
          continue;
        }

        throw lastError;
      }

      const data = JSON.parse(bodyText) as ChatCompletionResponse;
      const message = data.choices?.[0]?.message;
      const content = pickMessageText(message);
      if (!content) {
        throw new Error("LLM 返回内容为空");
      }
      return content;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        lastError = new Error("LLM 调用超时");
        if (attempt < maxAttempts) {
          const wait =
            env.LLM_RETRY_BACKOFF_MS > 0 ? env.LLM_RETRY_BACKOFF_MS * attempt : 0;
          logger.warn("LLM 单次请求超时（客户端 Abort），准备重试", {
            attempt,
            nextInMs: wait,
            timeoutMs,
          });
          if (wait > 0) await sleep(wait);
          attempt += 1;
          continue;
        }
        throw lastError;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError;
}
