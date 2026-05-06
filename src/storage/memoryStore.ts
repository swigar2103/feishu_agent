import fs from "node:fs";
import path from "node:path";
import { getWritableDataDir } from "./writableDataDir.js";

function memoryFilePath(): string {
  return path.join(getWritableDataDir(), "runtime-memories.json");
}

export type RuntimeMemoryRecord = {
  preferredTone?: string;
  preferredStructure: string[];
  commonTerms: string[];
  styleNotes: string[];
  editStats?: {
    manualEditCount: number;
    aiRewriteCount: number;
    frequentlyEditedSections: string[];
    lastEditedAt?: string;
  };
  updatedAt: string;
};

type RuntimeMemoryMap = Record<string, RuntimeMemoryRecord>;

function loadAllMemories(): RuntimeMemoryMap {
  const file = memoryFilePath();
  if (!fs.existsSync(file)) {
    return {};
  }
  const raw = fs.readFileSync(file, "utf-8");
  return JSON.parse(raw) as RuntimeMemoryMap;
}

function saveAllMemories(memories: RuntimeMemoryMap): void {
  const file = memoryFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(memories, null, 2), "utf-8");
}

export class MemoryStore {
  get(userId: string): RuntimeMemoryRecord | null {
    const all = loadAllMemories();
    return all[userId] ?? null;
  }

  upsert(userId: string, patch: Partial<RuntimeMemoryRecord>): RuntimeMemoryRecord {
    const all = loadAllMemories();
    const prev = all[userId] ?? {
      preferredStructure: [],
      commonTerms: [],
      styleNotes: [],
      editStats: {
        manualEditCount: 0,
        aiRewriteCount: 0,
        frequentlyEditedSections: [],
      },
      updatedAt: new Date(0).toISOString(),
    };

    const merged: RuntimeMemoryRecord = {
      preferredTone: patch.preferredTone ?? prev.preferredTone,
      preferredStructure: Array.from(new Set([...(prev.preferredStructure ?? []), ...(patch.preferredStructure ?? [])])),
      commonTerms: Array.from(new Set([...(prev.commonTerms ?? []), ...(patch.commonTerms ?? [])])),
      styleNotes: Array.from(new Set([...(prev.styleNotes ?? []), ...(patch.styleNotes ?? [])])),
      editStats: {
        manualEditCount: patch.editStats?.manualEditCount ?? prev.editStats?.manualEditCount ?? 0,
        aiRewriteCount: patch.editStats?.aiRewriteCount ?? prev.editStats?.aiRewriteCount ?? 0,
        frequentlyEditedSections: Array.from(
          new Set([
            ...(prev.editStats?.frequentlyEditedSections ?? []),
            ...(patch.editStats?.frequentlyEditedSections ?? []),
          ]),
        ).slice(0, 30),
        lastEditedAt: patch.editStats?.lastEditedAt ?? prev.editStats?.lastEditedAt,
      },
      updatedAt: new Date().toISOString(),
    };

    all[userId] = merged;
    saveAllMemories(all);
    return merged;
  }

  recordEditSignal(input: {
    userId: string;
    sectionHeading?: string;
    mode: "manual_edit" | "ai_partial_rewrite";
  }): RuntimeMemoryRecord {
    const prev = this.get(input.userId) ?? {
      preferredStructure: [],
      commonTerms: [],
      styleNotes: [],
      editStats: {
        manualEditCount: 0,
        aiRewriteCount: 0,
        frequentlyEditedSections: [],
      },
      updatedAt: new Date(0).toISOString(),
    };
    const editStats = {
      manualEditCount:
        (prev.editStats?.manualEditCount ?? 0) + (input.mode === "manual_edit" ? 1 : 0),
      aiRewriteCount:
        (prev.editStats?.aiRewriteCount ?? 0) + (input.mode === "ai_partial_rewrite" ? 1 : 0),
      frequentlyEditedSections: Array.from(
        new Set([
          ...(prev.editStats?.frequentlyEditedSections ?? []),
          ...(input.sectionHeading ? [input.sectionHeading] : []),
        ]),
      ).slice(0, 30),
      lastEditedAt: new Date().toISOString(),
    };
    return this.upsert(input.userId, {
      styleNotes: [
        input.mode === "manual_edit" ? "偏好人工精修" : "偏好AI局部改写",
      ],
      editStats,
    });
  }
}
