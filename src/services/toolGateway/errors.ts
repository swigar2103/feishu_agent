export type GatewayErrorCode =
  | "NOT_CONFIGURED"
  | "NOT_SUPPORTED"
  | "TIMEOUT"
  | "UPSTREAM_TEMPORARY"
  | "VALIDATION"
  | "UNKNOWN";

export class ToolGatewayError extends Error {
  readonly code: GatewayErrorCode;
  readonly causeText?: string;

  constructor(code: GatewayErrorCode, message: string, options?: { causeText?: string }) {
    super(message);
    this.name = "ToolGatewayError";
    this.code = code;
    this.causeText = options?.causeText;
  }
}

export function isFallbackableGatewayError(error: unknown): boolean {
  if (!(error instanceof ToolGatewayError)) return true;
  return (
    error.code === "NOT_CONFIGURED" ||
    error.code === "NOT_SUPPORTED" ||
    error.code === "TIMEOUT" ||
    error.code === "UPSTREAM_TEMPORARY" ||
    error.code === "UNKNOWN"
  );
}

