import {
  L1CatalogObjectSchema,
  L2IndexObjectSchema,
  type L1CatalogObject,
  type L2IndexObject,
} from "../model/layerSchemas.js";
import type { HmrsRepositories } from "../repo/interfaces.js";
import { HmrsRefreshService } from "../hmrsRefreshService.js";
import { HmrsRepository, type FolderNode } from "../hmrsRepository.js";
import { env } from "../../../config/env.js";

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

  /**
   * 合并 HMRS 刷新状态中的 managedFolderTokens 与 env 配置。
   * 即使 HMRS 尚未刷新，env 中的 token 也能立即生效。
   */
  private async resolveManagedFolderTokens(userId: string): Promise<string[]> {
    const statusResult = await this.refreshService
      .getRefreshStatus({ userId })
      .catch(() => null);
    const fromStatus = statusResult?.status.managedFolderTokens ?? [];
    const fromEnv = env.HMRS_MANAGED_FOLDER_TOKENS
      ? env.HMRS_MANAGED_FOLDER_TOKENS.split(",").map((t) => t.trim()).filter(Boolean)
      : [];
    return [...new Set([...fromStatus, ...fromEnv])].slice(0, 6);
  }

  /**
   * 将 FolderNode 树平铺为 L1 条目：
   * - 根文件夹的直接文档 → roomId = "imported_docs_room"
   * - 每个子文件夹 → 独立 L1 Room 条目（folderRoomId = "subfolder_<token>"），便于 Planner 感知并按需选择
   * - 子文件夹中的文档 → roomId = "subfolder_<parentToken>"
   */
  private flattenFolderToL1(
    node: FolderNode,
    owner: string,
    keywords: string[],
    projectTag: string,
    parentRoomId?: string,
  ): L1CatalogObject[] {
    const rows: L1CatalogObject[] = [];
    const roomId = parentRoomId ?? "imported_docs_room";

    // 若是子文件夹，先推入代表文件夹本身的 L1 Room 条目
    if (parentRoomId !== undefined) {
      rows.push(
        L1CatalogObjectSchema.parse({
          id: `l1_folder_${node.token}`,
          type: "DocIndexSummary",
          layer: "L1",
          wingId: "resources_wing",
          roomId: `subfolder_${node.token}`,
          drawerId: "folder_drawer",
          owner,
          projectTag,
          timeRange: { end: new Date().toISOString() },
          keywords: [...keywords, node.name].slice(0, 12),
          qualityScore: scoreByKeyword(node.name, keywords),
          sourceRef: { sourceType: "folder", docToken: node.token },
          title: `[文件夹] ${node.name}`,
          summary: `飞书子文件夹：${node.name}（token: ${node.token}），含 ${node.files.length} 个文档，${node.subFolders.length} 个子文件夹`,
        }),
      );
    }

    // 当前文件夹的直接文件
    for (const doc of node.files.slice(0, 20)) {
      rows.push(
        L1CatalogObjectSchema.parse({
          id: `l1_ext_doc_${doc.token}`,
          type: "DocIndexSummary",
          layer: "L1",
          wingId: "resources_wing",
          roomId,
          drawerId: "docs_drawer",
          owner,
          projectTag,
          timeRange: { end: new Date().toISOString() },
          keywords: [...keywords, doc.title].slice(0, 12),
          qualityScore: scoreByKeyword(doc.title, keywords),
          sourceRef: { sourceType: "doc", docToken: doc.token },
          title: doc.title,
          summary: `来自飞书文件夹「${node.name}」(${node.token})的文档`,
        }),
      );
    }

    // 递归处理子文件夹
    for (const sub of node.subFolders) {
      rows.push(...this.flattenFolderToL1(sub, owner, keywords, projectTag, `subfolder_${node.token}`));
    }

    return rows;
  }

  private async queryFeishuManagedL1(input: {
    owner: string;
    keyword: string;
    projectTag?: string;
    limit?: number;
  }): Promise<L1CatalogObject[]> {
    const managed = await this.resolveManagedFolderTokens(input.owner);
    if (managed.length === 0) return [];
    const keywords = splitKeywords(input.keyword);
    const projectTag = input.projectTag ?? "managed_folder_ingest";
    const rows: L1CatalogObject[] = [];
    for (const folderToken of managed) {
      const tree = await this.hmrsRepo.listFolderStructure(input.owner, folderToken, 2).catch(() => null);
      if (!tree) continue;
      rows.push(...this.flattenFolderToL1(tree, input.owner, keywords, projectTag));
    }
    return rows.slice(0, input.limit ?? 24);
  }

  /**
   * 获取纳管文件夹的完整树状结构，供 Planner Agent 注入 prompt 进行 LLM 动态选择。
   */
  async getManagedFolderStructure(userId: string): Promise<FolderNode[]> {
    const managed = await this.resolveManagedFolderTokens(userId);
    const trees: FolderNode[] = [];
    for (const folderToken of managed) {
      const tree = await this.hmrsRepo.listFolderStructure(userId, folderToken, 2).catch(() => null);
      if (tree) trees.push(tree);
    }
    return trees;
  }

  private flattenFolderToL2(
    node: FolderNode,
    owner: string,
    keywords: string[],
    projectTag: string,
    parentRoomId?: string,
  ): L2IndexObject[] {
    const rows: L2IndexObject[] = [];
    const roomId = parentRoomId ?? "imported_docs_room";

    for (const doc of node.files.slice(0, 20)) {
      rows.push(
        L2IndexObjectSchema.parse({
          id: `l2_ext_doc_${doc.token}`,
          type: "DocStructureIndex",
          layer: "L2",
          wingId: "resources_wing",
          roomId,
          drawerId: "docs_drawer",
          owner,
          projectTag,
          parentId: `l1_ext_doc_${doc.token}`,
          timeRange: { end: new Date().toISOString() },
          keywords: [...keywords, doc.title].slice(0, 12),
          qualityScore: scoreByKeyword(doc.title, keywords),
          sourceRef: { sourceType: "doc", docToken: doc.token },
          title: doc.title,
          structureSummary: `飞书文件夹「${node.name}」文档索引：${doc.title}`,
        }),
      );
    }

    for (const sub of node.subFolders) {
      rows.push(...this.flattenFolderToL2(sub, owner, keywords, projectTag, `subfolder_${node.token}`));
    }

    return rows;
  }

  private async queryFeishuManagedL2(input: {
    owner: string;
    keyword: string;
    projectTag?: string;
    limit?: number;
  }): Promise<L2IndexObject[]> {
    const managed = await this.resolveManagedFolderTokens(input.owner);
    if (managed.length === 0) return [];
    const keywords = splitKeywords(input.keyword);
    const projectTag = input.projectTag ?? "managed_folder_ingest";
    const rows: L2IndexObject[] = [];
    for (const folderToken of managed) {
      const tree = await this.hmrsRepo.listFolderStructure(input.owner, folderToken, 2).catch(() => null);
      if (!tree) continue;
      rows.push(...this.flattenFolderToL2(tree, input.owner, keywords, projectTag));
    }
    return rows.slice(0, input.limit ?? 30);
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
