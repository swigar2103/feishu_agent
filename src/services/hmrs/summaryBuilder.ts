import type { GatewayDocument } from "../toolGateway/types.js";

export type FolderSummary = {
  folderToken: string;
  generatedAt: string;
  docCount: number;
  titles: string[];
  summary: string;
};

export type DocumentIndexEntry = {
  docToken: string;
  title: string;
  summary: string;
  headingHints: string[];
  projectTags: string[];
  sourceUrl?: string;
};

function splitHeadingHints(text: string): string[] {
  return text
    .split(/[。\n]/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 4)
    .slice(0, 10);
}

export function buildFolderSummary(input: {
  folderToken: string;
  docs: GatewayDocument[];
}): FolderSummary {
  const titles = input.docs.map((doc) => doc.title).filter(Boolean).slice(0, 20);
  const summary = titles.length > 0
    ? `纳管文档 ${input.docs.length} 篇，包含：${titles.slice(0, 6).join("、")}`
    : "当前目录无可用文档";
  return {
    folderToken: input.folderToken,
    generatedAt: new Date().toISOString(),
    docCount: input.docs.length,
    titles,
    summary,
  };
}

export function buildDocumentIndexes(docs: GatewayDocument[]): DocumentIndexEntry[] {
  return docs.map((doc) => {
    const body = (doc.content ?? doc.summary ?? "").trim();
    return {
      docToken: doc.id,
      title: doc.title,
      summary: (doc.summary ?? body.slice(0, 240)).trim() || `文档候选：${doc.title}`,
      headingHints: splitHeadingHints(body),
      projectTags: [
        doc.title.includes("周报") ? "weekly_report" : "",
        doc.title.includes("会议") ? "meeting_summary" : "",
        doc.title.includes("项目") ? "project_report" : "",
      ].filter(Boolean),
      sourceUrl: doc.url,
    };
  });
}
