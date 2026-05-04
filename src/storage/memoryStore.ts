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
      updatedAt: new Date(0).toISOString(),
    };

    const merged: RuntimeMemoryRecord = {
      preferredTone: patch.preferredTone ?? prev.preferredTone,
      preferredStructure: Array.from(new Set([...(prev.preferredStructure ?? []), ...(patch.preferredStructure ?? [])])),
      commonTerms: Array.from(new Set([...(prev.commonTerms ?? []), ...(patch.commonTerms ?? [])])),
      styleNotes: Array.from(new Set([...(prev.styleNotes ?? []), ...(patch.styleNotes ?? [])])),
      updatedAt: new Date().toISOString(),
    };

    all[userId] = merged;
    saveAllMemories(all);
    return merged;
  }
}
