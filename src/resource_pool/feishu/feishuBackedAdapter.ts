import { logger } from "../../shared/logger.js";
import {
  docxBlocksToOutlineAndMarkdown,
  listAllDocumentBlocks,
} from "../../integrations/feishu/docxBlocks.js";
import { getFeishuMvpConfig } from "../../integrations/feishu/feishuConfig.js";
import type { DocumentSummary } from "../types.js";
import type { FeishuDirectoryEntry, ResourceDataAdapter } from "./adapterTypes.js";
import { MockResourceDataAdapter } from "./mockResourceAdapter.js";

/**
 * B5 真飞书：文档正文走 docx blocks API；其余字段仍复用 mock JSON（联系人/项目详情等）。
 */
export class FeishuBackedResourceDataAdapter implements ResourceDataAdapter {
  private readonly fallback = new MockResourceDataAdapter();

  async loadDocumentOutlineAndBody(doc: DocumentSummary): Promise<{
    outline: string[];
    bodyMarkdown: string;
    directoryEntries: FeishuDirectoryEntry[];
  }> {
    const token = doc.feishuDocToken?.trim();
    if (!token) {
      return this.fallback.loadDocumentOutlineAndBody(doc);
    }

    try {
      const c = getFeishuMvpConfig();
      const blocks = await listAllDocumentBlocks(c, token);
      const { outline, bodyMarkdown } = docxBlocksToOutlineAndMarkdown(blocks);
      const body =
        bodyMarkdown.trim().length > 0
          ? bodyMarkdown.slice(0, 48_000)
          : doc.summary ||
            "（blocks 解析为空，请确认文档可读或回退使用摘要）";
      const directoryEntries: FeishuDirectoryEntry[] = outline
        .slice(0, 48)
        .map((title) => ({ level: 1 as const, title }));
      return { outline, bodyMarkdown: body, directoryEntries };
    } catch (e) {
      logger.warn("[FeishuBackedResourceDataAdapter] 文档拉取失败，回退 mock/details", {
        token,
        error: e instanceof Error ? e.message : String(e),
      });
      return this.fallback.loadDocumentOutlineAndBody(doc);
    }
  }

  loadContactExtendedDetail(contactId: string): Promise<string> {
    return this.fallback.loadContactExtendedDetail(contactId);
  }

  loadProjectExtendedDetail(projectId: string): Promise<string> {
    return this.fallback.loadProjectExtendedDetail(projectId);
  }

  loadMessageThreadDigest(threadId: string): Promise<string> {
    return this.fallback.loadMessageThreadDigest(threadId);
  }
}
