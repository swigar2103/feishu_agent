import type { DocumentSummary } from "../types.js";

export type FeishuDirectoryEntry = {
  level: number;
  title: string;
};

/** B5：资源数据源适配契约，真实飞书实现可替换 Mock，不改变 B3 拼装逻辑 */
export interface ResourceDataAdapter {
  loadDocumentOutlineAndBody(doc: DocumentSummary): Promise<{
    outline: string[];
    bodyMarkdown: string;
    directoryEntries: FeishuDirectoryEntry[];
  }>;

  /** 摘要之上补充职责、协作信息等「详情」段落 */
  loadContactExtendedDetail(contactId: string): Promise<string>;

  /** 摘要之上补充里程碑、风险提示等结构化详情 */
  loadProjectExtendedDetail(projectId: string): Promise<string>;

  /** IM 占位：会话 id → 可读摘要段落 */
  loadMessageThreadDigest(threadId: string): Promise<string>;
}
