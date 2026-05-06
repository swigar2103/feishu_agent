import { L1CatalogObjectSchema, type L1CatalogObject } from "../../model/layerSchemas.js";
import type { HmrsCatalogRepository, LayerQuery } from "../interfaces.js";
import { readJsonFile, writeJsonFile } from "./fileStorage.js";

type CatalogSnapshot = {
  updatedAt: string;
  items: L1CatalogObject[];
};

function textMatch(item: L1CatalogObject, keyword: string): boolean {
  const probe = `${item.title} ${item.summary} ${item.keywords.join(" ")}`.toLowerCase();
  return probe.includes(keyword.toLowerCase());
}

export class FileCatalogRepository implements HmrsCatalogRepository {
  async query(query: LayerQuery): Promise<L1CatalogObject[]> {
    const snapshot = readJsonFile<CatalogSnapshot>("hmrs-catalog.json", {
      updatedAt: new Date(0).toISOString(),
      items: [],
    });
    let rows = snapshot.items
      .map((item) => L1CatalogObjectSchema.parse(item))
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

  async upsert(items: L1CatalogObject[]): Promise<void> {
    const snapshot = readJsonFile<CatalogSnapshot>("hmrs-catalog.json", {
      updatedAt: new Date(0).toISOString(),
      items: [],
    });
    const map = new Map(snapshot.items.map((item) => [item.id, L1CatalogObjectSchema.parse(item)]));
    for (const item of items) {
      map.set(item.id, L1CatalogObjectSchema.parse(item));
    }
    writeJsonFile("hmrs-catalog.json", {
      updatedAt: new Date().toISOString(),
      items: Array.from(map.values()),
    } satisfies CatalogSnapshot);
  }
}
