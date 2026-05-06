import { env } from "../../../config/env.js";
import { appendJsonLine } from "../repo/file/fileStorage.js";

export type HmrsDiffPayload = {
  sessionId: string;
  userId: string;
  taskType: string;
  legacyTopIds: string[];
  hmrsL1Ids: string[];
  hmrsL2Ids: string[];
  finalExpansionIds: string[];
  budget: {
    maxItems: number;
    maxChars: number;
  };
};

export function logHmrsDiff(payload: HmrsDiffPayload): void {
  if (!env.HMRS_DIFF_LOG_ENABLED) return;
  appendJsonLine("hmrs-diff-log.jsonl", {
    ts: new Date().toISOString(),
    ...payload,
  });
}
