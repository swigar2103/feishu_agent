import fs from "node:fs";
import path from "node:path";
import { UserMemorySchema, type UserMemory, type UserMemoryView } from "../../schemas/index.js";
import { parseJsonFromMd } from "../retrieval/mdParser.js";

/**
 * 用户记忆持久化存储（Phase 3）。
 *
 * 设计原则：
 *   1. 每个 userId 一个 JSON 文件：data/memory/<userId>.json，便于人工审查和 git 单独忽略
 *   2. 原子写：先写 .tmp 再 rename，避免崩溃时读到半文件
 *   3. 读取兜底：JSON 不存在时从 src/data/memories.md（seed）加载；再不存在则返回空骨架
 *   4. 严格 schema 校验：读到的 JSON 通过 UserMemorySchema.parse；解析失败时回退到 seed + 记录日志
 */

const DEFAULT_ROOT = path.resolve(process.cwd(), "data", "memory");
const SEED_PATH = "src/data/memories.md";

type MemoriesSeed = Record<string, UserMemoryView>;

let seedCache: MemoriesSeed | null = null;

function loadSeed(): MemoriesSeed {
  if (seedCache) return seedCache;
  try {
    seedCache = parseJsonFromMd<MemoriesSeed>(SEED_PATH);
  } catch {
    seedCache = {};
  }
  return seedCache;
}

function emptyMemory(userId: string): UserMemory {
  return UserMemorySchema.parse({
    userId,
    preferredStructure: [],
    commonTerms: [],
    styleNotes: [],
    usageCount: 0,
    recentTones: [],
    recentSkillIds: [],
    schemaVersion: 1,
  });
}

function userFilePath(userId: string, root: string = DEFAULT_ROOT): string {
  const safe = userId.replace(/[^a-zA-Z0-9_\-]/g, "_");
  return path.join(root, `${safe}.json`);
}

export class MemoryStore {
  constructor(private readonly root: string = DEFAULT_ROOT) {}

  private ensureRoot(): void {
    if (!fs.existsSync(this.root)) {
      fs.mkdirSync(this.root, { recursive: true });
    }
  }

  /**
   * 读取用户记忆：
   *   1. 优先 data/memory/<userId>.json（持久化层）
   *   2. 回退到 memories.md 中的 seed（首次冷启动）
   *   3. 再不存在则返回空骨架
   */
  load(userId: string): UserMemory {
    const file = userFilePath(userId, this.root);

    if (fs.existsSync(file)) {
      try {
        const raw = fs.readFileSync(file, "utf-8");
        const parsed = JSON.parse(raw);
        return UserMemorySchema.parse({ ...parsed, userId });
      } catch (err) {
        console.warn(`[MemoryStore] 用户 ${userId} 的 JSON 解析失败，回退到 seed`, err);
      }
    }

    const seed = loadSeed();
    const seeded = seed[userId];
    if (seeded) {
      return UserMemorySchema.parse({
        userId,
        preferredTone: seeded.preferredTone,
        preferredStructure: seeded.preferredStructure ?? [],
        commonTerms: seeded.commonTerms ?? [],
        styleNotes: seeded.styleNotes ?? [],
        usageCount: 0,
        recentTones: seeded.preferredTone ? [seeded.preferredTone] : [],
        recentSkillIds: [],
        schemaVersion: 1,
      });
    }

    return emptyMemory(userId);
  }

  /**
   * 原子写：写入 .tmp 再 rename，避免并发/崩溃时半文件。
   * 写入前再 parse 一次，不合法直接抛错，永不污染已有的持久化状态。
   */
  save(memory: UserMemory): UserMemory {
    const validated = UserMemorySchema.parse(memory);
    this.ensureRoot();

    const final = userFilePath(validated.userId, this.root);
    const tmp = `${final}.tmp`;

    fs.writeFileSync(tmp, JSON.stringify(validated, null, 2), { encoding: "utf-8" });
    fs.renameSync(tmp, final);

    return validated;
  }
}

/** 进程级单例，与 RetrievalEngine 类似 */
let sharedStore: MemoryStore | null = null;

export function getMemoryStore(): MemoryStore {
  if (!sharedStore) sharedStore = new MemoryStore();
  return sharedStore;
}
