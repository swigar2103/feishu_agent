import { spawn } from "node:child_process";
import { env } from "../../config/env.js";
import { ToolGatewayError } from "./errors.js";

export type LarkCliExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  elapsedMs: number;
  command: string;
  args: string[];
};

let unavailableBin: { bin: string; reason: string } | null = null;

function isCliEnabled(): boolean {
  if (env.LARK_CLI_ENABLED === "false") return false;
  return true;
}

export async function execLarkCli(args: string[], timeoutMs?: number): Promise<LarkCliExecResult> {
  if (!isCliEnabled()) {
    throw new ToolGatewayError("NOT_CONFIGURED", "LARK_CLI_ENABLED=false，已禁用 lark-cli");
  }

  const cliBin = env.LARK_CLI_BIN.trim() || "lark-cli";
  if (unavailableBin && unavailableBin.bin === cliBin) {
    throw new ToolGatewayError(
      "NOT_CONFIGURED",
      `lark-cli 当前不可执行（已缓存）：${unavailableBin.reason}`,
    );
  }
  const normalizedArgs = [...args];
  if (env.LARK_CLI_PROFILE.trim()) {
    normalizedArgs.push("--profile", env.LARK_CLI_PROFILE.trim());
  }

  const runTimeoutMs = timeoutMs ?? env.LARK_CLI_TIMEOUT_MS;
  const startedAt = Date.now();

  return await new Promise<LarkCliExecResult>((resolve, reject) => {
    const child = spawn(cliBin, normalizedArgs, {
      windowsHide: true,
      shell: false,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, runTimeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      unavailableBin = { bin: cliBin, reason: error.message };
      reject(
        new ToolGatewayError("NOT_CONFIGURED", `lark-cli 执行失败，请确认已安装并可执行: ${cliBin}`, {
          causeText: error.message,
        }),
      );
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const elapsedMs = Date.now() - startedAt;

      if (timedOut) {
        reject(new ToolGatewayError("TIMEOUT", `lark-cli 调用超时(${runTimeoutMs}ms)`));
        return;
      }

      const exitCode = code ?? 1;
      unavailableBin = null;
      resolve({
        stdout,
        stderr,
        exitCode,
        elapsedMs,
        command: cliBin,
        args: normalizedArgs,
      });
    });
  });
}

