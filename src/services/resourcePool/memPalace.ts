import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export type MemPalaceRoom = {
  id: string;
  label: string;
  keywords: string[];
};

type MemPalaceFile = {
  rooms: MemPalaceRoom[];
};

let cached: MemPalaceFile | null = null;

function loadMemPalace(): MemPalaceFile {
  if (cached) return cached;
  const p = join(__dirname, "../../data/memPalace.json");
  if (!existsSync(p)) {
    cached = { rooms: [] };
    return cached;
  }
  const raw = readFileSync(p, "utf-8");
  cached = JSON.parse(raw) as MemPalaceFile;
  return cached;
}

/**
 * Memory Palace：根据用户 prompt 命中「房间」，返回额外检索词（纳入 B2 规则打分，软增强）。
 */
export function expandMemPalaceTerms(userPrompt: string): {
  matchedRoomIds: string[];
  extraTerms: string[];
} {
  const data = loadMemPalace();
  const text = userPrompt;
  const matchedRoomIds: string[] = [];
  const extraTerms: string[] = [];
  for (const room of data.rooms) {
    const hit = room.keywords.some((k) => k && text.includes(k));
    if (hit) {
      matchedRoomIds.push(room.id);
      extraTerms.push(room.label, ...room.keywords);
    }
  }
  return {
    matchedRoomIds,
    extraTerms: [...new Set(extraTerms)].filter(Boolean),
  };
}
