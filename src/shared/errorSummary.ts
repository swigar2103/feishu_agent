type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function truncate(value: string, max = 1_000): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}...(truncated)`;
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name || "Unknown Error";
  }
  if (typeof error === "string") return error;
  if (isPlainObject(error) && typeof error.message === "string") return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function summarizeError(error: unknown): PlainObject {
  if (error instanceof Error) {
    const out: PlainObject = {
      type: error.name || "Error",
      message: truncate(error.message || "Unknown Error"),
    };
    if (error.stack) out.stack = truncate(error.stack, 4_000);
    const maybeCause = (error as Error & { cause?: unknown }).cause;
    if (maybeCause !== undefined) out.cause = summarizeError(maybeCause);
    return out;
  }

  if (isPlainObject(error)) {
    const out: PlainObject = { rawType: "object" };
    const msg = getErrorMessage(error);
    if (msg) out.message = truncate(msg);
    if (typeof error.pregelTaskId === "string") out.pregelTaskId = error.pregelTaskId;
    if (typeof error.code === "string") out.code = error.code;
    if (typeof error.type === "string") out.type = error.type;
    try {
      out.raw = truncate(JSON.stringify(error), 4_000);
    } catch {
      out.raw = truncate(String(error), 4_000);
    }
    return out;
  }

  return {
    rawType: typeof error,
    message: truncate(getErrorMessage(error)),
  };
}
