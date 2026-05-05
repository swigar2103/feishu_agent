import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type {
  ContactSummary,
  DocumentSummary,
  PersonaSummary,
  PoolTextQuery,
  ProjectSummary,
  ResourcePoolSnapshot,
} from "./types.js";
import { ResourcePoolSnapshotSchema } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function normalizeKeyword(k: string): string {
  return k.trim().toLowerCase();
}

function matchesKeyword(text: string | undefined, keyword: string): boolean {
  if (!keyword) return true;
  const nk = normalizeKeyword(keyword);
  if (!nk) return true;
  return normalizeKeyword(text ?? "").includes(nk);
}

function matchesTags(
  rowTags: string[],
  requested: string[] | undefined,
  mode: "any" | "all",
): boolean {
  if (!requested || requested.length === 0) return true;
  const normalizedRow = rowTags.map((t) => t.toLowerCase());
  const set = new Set(requested.map((t) => t.toLowerCase()));
  if (mode === "all") {
    return [...set].every((t) => normalizedRow.includes(t));
  }
  return [...set].some((t) => normalizedRow.includes(t));
}

function applyLimit<T>(rows: T[], limit?: number): T[] {
  if (limit == null || limit <= 0) return rows;
  return rows.slice(0, limit);
}

/**
 * B1 Resource Pool Manager：统一管理四类摘要并提供查询接口。
 * Mock 数据默认从同级 `mock/*.json` 加载；未来可注入真实飞书同步结果。
 */
export class ResourcePoolManager {
  private snapshot: ResourcePoolSnapshot;

  constructor(snapshot: ResourcePoolSnapshot) {
    this.snapshot = ResourcePoolSnapshotSchema.parse(snapshot);
  }

  /** 从目录加载四个 JSON 文件并构建池（路径缺省为 `src/resource_pool/mock`） */
  static fromMockFiles(baseDir?: string): ResourcePoolManager {
    const dir = baseDir ?? join(__dirname, "mock");
    const read = (name: string) =>
      JSON.parse(readFileSync(join(dir, name), "utf-8")) as unknown;
    const raw = {
      documents: read("documents.json"),
      contacts: read("contacts.json"),
      projects: read("projects.json"),
      personas: read("personas.json"),
      meta: { version: "mock-1", loadedAt: new Date().toISOString() },
    };
    return new ResourcePoolManager(ResourcePoolSnapshotSchema.parse(raw));
  }

  /** 当前完整快照（供 B2 整条池扫描或快照持久化前的只读视图） */
  getPool(): Readonly<ResourcePoolSnapshot> {
    return this.snapshot;
  }

  /** 用新快照替换（供 B4 写回测试或异步刷新后注入） */
  replacePool(snapshot: ResourcePoolSnapshot): void {
    this.snapshot = ResourcePoolSnapshotSchema.parse(snapshot);
  }

  documentById(id: string): DocumentSummary | undefined {
    return this.snapshot.documents.find((d) => d.id === id);
  }

  contactById(id: string): ContactSummary | undefined {
    return this.snapshot.contacts.find((c) => c.id === id);
  }

  projectById(id: string): ProjectSummary | undefined {
    return this.snapshot.projects.find((p) => p.id === id);
  }

  personaByUserId(userId: string): PersonaSummary | undefined {
    return this.snapshot.personas.find((p) => p.userId === userId);
  }

  queryDocuments(q: PoolTextQuery): DocumentSummary[] {
    const kw = q.keyword ?? "";
    const tags = q.tags ?? [];
    const tagMode = q.tagMode ?? "any";
    const rows = this.snapshot.documents.filter((d) => {
      const folder = (d.folderPathSegments ?? []).join(" ");
      const text = `${folder} ${d.title} ${d.summary} ${d.tags.join(" ")}`;
      if (!matchesKeyword(text, kw)) return false;
      return matchesTags(d.tags, tags, tagMode);
    });
    return applyLimit(rows, q.limit);
  }

  queryContacts(q: PoolTextQuery): ContactSummary[] {
    const kw = q.keyword ?? "";
    const tags = q.tags ?? [];
    const tagMode = q.tagMode ?? "any";
    const rows = this.snapshot.contacts.filter((c) => {
      const text = `${c.name} ${c.org ?? ""} ${c.role ?? ""} ${c.summary} ${c.tags.join(" ")}`;
      if (!matchesKeyword(text, kw)) return false;
      return matchesTags(c.tags, tags, tagMode);
    });
    return applyLimit(rows, q.limit);
  }

  queryProjects(q: PoolTextQuery): ProjectSummary[] {
    const kw = q.keyword ?? "";
    const tags = q.tags ?? [];
    const tagMode = q.tagMode ?? "any";
    const rows = this.snapshot.projects.filter((p) => {
      const text = `${p.name} ${p.summary} ${p.status ?? ""} ${p.tags.join(" ")}`;
      if (!matchesKeyword(text, kw)) return false;
      return matchesTags(p.tags, tags, tagMode);
    });
    return applyLimit(rows, q.limit);
  }

  queryPersonas(q: PoolTextQuery & { userId?: string }): PersonaSummary[] {
    const kw = q.keyword ?? "";
    const tags = q.tags ?? [];
    const tagMode = q.tagMode ?? "any";
    let rows = this.snapshot.personas;
    if (q.userId) {
      rows = rows.filter((p) => p.userId === q.userId);
    }
    rows = rows.filter((p) => {
      const tagLike = [...p.domains, ...p.styleNotes, ...p.commonTerms];
      const text = `${p.userId} ${p.preferredTone ?? ""} ${tagLike.join(" ")}`;
      if (!matchesKeyword(text, kw)) return false;
      const virtualTags = tagLike.map((x) => x.toLowerCase());
      return matchesTags(virtualTags, tags, tagMode);
    });
    return applyLimit(rows, q.limit);
  }
}
