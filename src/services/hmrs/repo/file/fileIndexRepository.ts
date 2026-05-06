import { L2IndexObjectSchema, type L2IndexObject } from "../../model/layerSchemas.js";
import type { HmrsIndexRepository, LayerQuery } from "../interfaces.js";
import { readJsonFile, writeJsonFile } from "./fileStorage.js";

type IndexSnapshot = {
  updatedAt: string;
  items: L2IndexObject[];
};

function textMatch(item: L2IndexObject, keyword: string): boolean {
  const probe = `${item.title} ${item.structureSummary} ${item.keywords.join(" ")}`.toLowerCase();
  return probe.includes(keyword.toLowerCase());
}

export class FileIndexRepository implements HmrsIndexRepository {
  async query(query: LayerQuery): Promise<L2IndexObject[]> {
    const snapshot = readJsonFile<IndexSnapshot>("hmrs-index.json", {
      updatedAt: new Date(0).toISOString(),
      items: [],
    });
    let rows = snapshot.items
      .map((item) => L2IndexObjectSchema.parse(item))
      .filter((item) => item.owner === query.owner);
    if (query.ids && query.ids.length > 0) {
      const set = new Set(query.ids);
      rows = rows.filter((item) => set.has(item.id));
    }
    if (query.projectTag) {
      rows = rows.filter((item) => item.projectTag === query.projectTag);
    }
    if (query.keyword?.trim()) {
      rows = rows.filter((item) => textMatch(item, query.keyword!));
    }
    return rows.slice(0, query.limit ?? 20);
  }

  async upsert(items: L2IndexObject[]): Promise<void> {
    const snapshot = readJsonFile<IndexSnapshot>("hmrs-index.json", {
      updatedAt: new Date(0).toISOString(),
      items: [],
    });
    const map = new Map(snapshot.items.map((item) => [item.id, L2IndexObjectSchema.parse(item)]));
    for (const item of items) {
      map.set(item.id, L2IndexObjectSchema.parse(item));
    }
    writeJsonFile("hmrs-index.json", {
      updatedAt: new Date().toISOString(),
      items: Array.from(map.values()),
    } satisfies IndexSnapshot);
  }
}
