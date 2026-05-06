import type { HmrsWritebackPayload, HmrsWritebackRepository } from "../interfaces.js";
import { appendJsonLine } from "./fileStorage.js";

export class FileWritebackRepository implements HmrsWritebackRepository {
  async write(payload: HmrsWritebackPayload): Promise<void> {
    appendJsonLine("hmrs-writeback.jsonl", {
      ts: new Date().toISOString(),
      owner: payload.owner,
      l1Count: payload.l1Patches?.length ?? 0,
      l2Count: payload.l2Patches?.length ?? 0,
      l3Count: payload.l3Patches?.length ?? 0,
      payload,
    });
  }
}
