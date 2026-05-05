import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { z } from "zod";
import type { DocumentSummary } from "../types.js";
import type { FeishuDirectoryEntry, ResourceDataAdapter } from "./adapterTypes.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const FeishuInlineDetailsSchema = z.object({
  documents: z.record(
    z.object({
      outline: z.array(z.string()),
      body: z.string(),
    }),
  ),
  contacts: z.record(
    z.object({
      detailText: z.string(),
    }),
  ),
  projects: z.record(
    z.object({
      detailText: z.string(),
    }),
  ),
  messageThreads: z
    .record(
      z.object({
        digest: z.string(),
      }),
    )
    .optional()
    .default({}),
  docDirectory: z.record(z.array(z.object({ level: z.number(), title: z.string() }))).optional(),
});

type FeishuInlineDetails = z.infer<typeof FeishuInlineDetailsSchema>;

/**
 * B5 Mock：文件型「飞书」数据，真实落地时以 API 返回替换本实现。
 */
export class MockResourceDataAdapter implements ResourceDataAdapter {
  private readonly details: FeishuInlineDetails;

  constructor(detailsPath?: string) {
    const path = detailsPath ?? join(__dirname, "../mock/feishu_details.json");
    const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    this.details = FeishuInlineDetailsSchema.parse(raw);
  }

  async loadDocumentOutlineAndBody(doc: DocumentSummary): Promise<{
    outline: string[];
    bodyMarkdown: string;
    directoryEntries: FeishuDirectoryEntry[];
  }> {
    const hit = this.details.documents[doc.id];
    const directoryFromFile = this.details.docDirectory?.[doc.id] ?? [];
    if (hit) {
      return {
        outline: hit.outline,
        bodyMarkdown: hit.body,
        directoryEntries: directoryFromFile.map((d) => ({
          level: d.level,
          title: d.title,
        })),
      };
    }

    const fallbackBody = [
      `# ${doc.title}`,
      "",
      doc.summary,
      "",
      "（Mock 提示：未在 `feishu_details.json` 找到对应正文，已回退为摘要扩写，真实接入请同步 Drive 解析。）",
    ].join("\n");

    return {
      outline: ["摘要", "正文（回退）"],
      bodyMarkdown: fallbackBody,
      directoryEntries: directoryFromFile.length
        ? directoryFromFile.map((d) => ({ level: d.level, title: d.title }))
        : [{ level: 1, title: "摘要" }],
    };
  }

  async loadContactExtendedDetail(contactId: string): Promise<string> {
    const hit = this.details.contacts[contactId];
    if (hit) return hit.detailText;
    return `（Mock）未找到联系人详情：${contactId}\n请补充 feishu_details.json 或接入 IM/通讯录 API。`;
  }

  async loadProjectExtendedDetail(projectId: string): Promise<string> {
    const hit = this.details.projects[projectId];
    if (hit) return hit.detailText;
    return `（Mock）未找到项目详情：${projectId}\n请补充 feishu_details.json 或接入项目空间 API。`;
  }

  async loadMessageThreadDigest(threadId: string): Promise<string> {
    const hit = this.details.messageThreads?.[threadId];
    if (hit) return hit.digest;
    return `（Mock）未找到消息线程摘要：${threadId}`;
  }
}
