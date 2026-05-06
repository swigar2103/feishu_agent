import { HmrsRelationSchema, type HmrsRelation } from "../../model/layerSchemas.js";
import type { HmrsRelationRepository } from "../interfaces.js";
import { readJsonFile, writeJsonFile } from "./fileStorage.js";

type RelationSnapshot = {
  updatedAt: string;
  items: HmrsRelation[];
};

export class FileRelationRepository implements HmrsRelationRepository {
  async listByFromIds(fromIds: string[]): Promise<HmrsRelation[]> {
    if (fromIds.length === 0) return [];
    const set = new Set(fromIds);
    const snapshot = readJsonFile<RelationSnapshot>("hmrs-relations.json", {
      updatedAt: new Date(0).toISOString(),
      items: [],
    });
    return snapshot.items
      .map((item) => HmrsRelationSchema.parse(item))
      .filter((item) => set.has(item.fromId));
  }

  async upsert(relations: HmrsRelation[]): Promise<void> {
    const snapshot = readJsonFile<RelationSnapshot>("hmrs-relations.json", {
      updatedAt: new Date(0).toISOString(),
      items: [],
    });
    const map = new Map(snapshot.items.map((item) => [`${item.fromId}:${item.toId}:${item.relationType}`, item]));
    for (const rel of relations) {
      const parsed = HmrsRelationSchema.parse(rel);
      map.set(`${parsed.fromId}:${parsed.toId}:${parsed.relationType}`, parsed);
    }
    writeJsonFile("hmrs-relations.json", {
      updatedAt: new Date().toISOString(),
      items: Array.from(map.values()),
    } satisfies RelationSnapshot);
  }
}
