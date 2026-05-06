import {
  L1CatalogObjectSchema,
  L2IndexObjectSchema,
  type L1CatalogObject,
  type L2IndexObject,
} from "../model/layerSchemas.js";
import type { HmrsRepositories } from "../repo/interfaces.js";
import { HmrsRefreshService } from "../hmrsRefreshService.js";
import { HmrsRepository } from "../hmrsRepository.js";

function splitKeywords(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[，。,\s/\\|:：;；\-_.]+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2)
    .slice(0, 12);
}

function scoreByKeyword(title: string, keywords: string[]): number {
  if (keywords.length === 0) return 0.3;
  const text = title.toLowerCase();
  const hit = keywords.reduce((sum, kw) => sum + (text.includes(kw) ? 1 : 0), 0);
  return Math.min(0.95, 0.35 + hit * 0.12);
}

export class SummaryQueryService {
  private readonly refreshService = new HmrsRefreshService();
  private readonly hmrsRepo = new HmrsRepository();

  constructor(private readonly repos: HmrsRepositories) {}

  private async queryFeishuManagedL1(input: {
    owner: string;
    keyword: string;
    projectTag?: string;
    limit?: number;
  }): Promise<L1CatalogObject[]> {
    const statusResult = await this.refreshService
      .getRefreshStatus({ userId: input.owner })
      .catch(() => null);
    const managed = statusResult?.status.managedFolderTokens ?? [];
    if (managed.length === 0) return [];
    const keywords = splitKeywords(input.keyword);
    const rows: L1CatalogObject[] = [];
    for (const folderToken of managed.slice(0, 6)) {
      const docs = await this.hmrsRepo.listDocsInFolder(input.owner, folderToken).catch(() => []);
      for (const doc of docs.slice(0, 20)) {
        rows.push(
          L1CatalogObjectSchema.parse({
            id: `l1_ext_doc_${doc.token}`,
            type: "DocIndexSummary",
            layer: "L1",
            wingId: "resources_wing",
            roomId: "imported_docs_room",
            drawerId: "docs_drawer",
            owner: input.owner,
            projectTag: input.projectTag ?? "managed_folder_ingest",
            timeRange: { end: new Date().toISOString() },
            keywords: [...keywords, doc.title].slice(0, 12),
            qualityScore: scoreByKeyword(doc.title, keywords),
            sourceRef: {
              sourceType: "doc",
              docToken: doc.token,
            },
            title: doc.title,
            summary: `来自飞书纳管目录(${folderToken})的文档索引`,
          }),
        );
      }
    }
    return rows.slice(0, input.limit ?? 12);
  }

  private async queryFeishuManagedL2(input: {
    owner: string;
    keyword: string;
    projectTag?: string;
    limit?: number;
  }): Promise<L2IndexObject[]> {
    const statusResult = await this.refreshService
      .getRefreshStatus({ userId: input.owner })
      .catch(() => null);
    const managed = statusResult?.status.managedFolderTokens ?? [];
    if (managed.length === 0) return [];
    const keywords = splitKeywords(input.keyword);
    const rows: L2IndexObject[] = [];
    for (const folderToken of managed.slice(0, 6)) {
      const docs = await this.hmrsRepo.listDocsInFolder(input.owner, folderToken).catch(() => []);
      for (const doc of docs.slice(0, 20)) {
        rows.push(
          L2IndexObjectSchema.parse({
            id: `l2_ext_doc_${doc.token}`,
            type: "DocStructureIndex",
            layer: "L2",
            wingId: "resources_wing",
            roomId: "imported_docs_room",
            drawerId: "docs_drawer",
            owner: input.owner,
            projectTag: input.projectTag ?? "managed_folder_ingest",
            parentId: `l1_ext_doc_${doc.token}`,
            timeRange: { end: new Date().toISOString() },
            keywords: [...keywords, doc.title].slice(0, 12),
            qualityScore: scoreByKeyword(doc.title, keywords),
            sourceRef: {
              sourceType: "doc",
              docToken: doc.token,
            },
            title: doc.title,
            structureSummary: `飞书纳管目录文档索引：${doc.title}`,
          }),
        );
      }
    }
    return rows.slice(0, input.limit ?? 20);
  }

  private mergeL1(localRows: L1CatalogObject[], managedRows: L1CatalogObject[], limit: number): L1CatalogObject[] {
    const map = new Map<string, L1CatalogObject>();
    for (const row of [...managedRows, ...localRows]) {
      const existed = map.get(row.id);
      if (!existed || row.qualityScore > existed.qualityScore) map.set(row.id, row);
    }
    return [...map.values()].sort((a, b) => b.qualityScore - a.qualityScore).slice(0, limit);
  }

  private mergeL2(localRows: L2IndexObject[], managedRows: L2IndexObject[], limit: number): L2IndexObject[] {
    const map = new Map<string, L2IndexObject>();
    for (const row of [...managedRows, ...localRows]) {
      const existed = map.get(row.id);
      if (!existed || row.qualityScore > existed.qualityScore) map.set(row.id, row);
    }
    return [...map.values()].sort((a, b) => b.qualityScore - a.qualityScore).slice(0, limit);
  }

  async queryL1(input: {
    owner: string;
    keyword: string;
    projectTag?: string;
    limit?: number;
  }): Promise<L1CatalogObject[]> {
    const limit = input.limit ?? 8;
    const localRows = await this.repos.catalog.query({
      owner: input.owner,
      keyword: input.keyword,
      projectTag: input.projectTag,
      limit,
    });
    const managedRows = await this.queryFeishuManagedL1({
      owner: input.owner,
      keyword: input.keyword,
      projectTag: input.projectTag,
      limit,
    });
    return this.mergeL1(localRows, managedRows, limit);
  }

  async queryWingSummaries(input: {
    owner: string;
    keyword: string;
    wings?: string[];
    limit?: number;
  }): Promise<L1CatalogObject[]> {
    const rows = await this.queryL1({
      owner: input.owner,
      keyword: input.keyword,
      limit: input.limit ?? 12,
    });
    if (!input.wings || input.wings.length === 0) return rows;
    const set = new Set(input.wings);
    return rows.filter((row) => row.wingId && set.has(row.wingId));
  }

  async queryL2(input: {
    owner: string;
    keyword: string;
    limit?: number;
    ids?: string[];
    projectTag?: string;
  }): Promise<L2IndexObject[]> {
    const limit = input.limit ?? 12;
    const localRows = await this.repos.index.query({
      owner: input.owner,
      keyword: input.keyword,
      projectTag: input.projectTag,
      ids: input.ids,
      limit,
    });
    const managedRows = await this.queryFeishuManagedL2({
      owner: input.owner,
      keyword: input.keyword,
      projectTag: input.projectTag,
      limit,
    });
    return this.mergeL2(localRows, managedRows, limit);
  }

  async queryRoomIndexes(input: {
    owner: string;
    keyword: string;
    rooms?: string[];
    limit?: number;
  }): Promise<L2IndexObject[]> {
    const rows = await this.queryL2({
      owner: input.owner,
      keyword: input.keyword,
      limit: input.limit ?? 20,
    });
    if (!input.rooms || input.rooms.length === 0) return rows;
    const set = new Set(input.rooms);
    return rows.filter((row) => row.roomId && set.has(row.roomId));
  }
}
