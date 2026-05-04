import fs from "node:fs";
import path from "node:path";

export type LarkCliGuidance = {
  enabled: boolean;
  sourceRoot: string;
  supportedDocsCommands: string[];
  commandPatterns: string[];
  templateHints: string[];
  qualityChecks: string[];
};

const DEFAULT_GUIDANCE: LarkCliGuidance = {
  enabled: false,
  sourceRoot: "",
  supportedDocsCommands: [],
  commandPatterns: [],
  templateHints: [],
  qualityChecks: [],
};

let cached: LarkCliGuidance | null = null;

function safeRead(filePath: string): string {
  if (!fs.existsSync(filePath)) return "";
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

function collectSupportedCommands(text: string): string[] {
  const result = new Set<string>();
  const cmdRegex = /docs\s+\+([a-z-]+)/gi;
  for (const match of text.matchAll(cmdRegex)) {
    if (match[1]) result.add(`+${match[1]}`);
  }
  return [...result];
}

function collectGoCommandPatterns(text: string): string[] {
  const patterns = new Set<string>();
  const pairRegex = /"docs"\s*,\s*"\+([a-z-]+)"/gi;
  for (const match of text.matchAll(pairRegex)) {
    if (match[1]) {
      patterns.add(`docs +${match[1]}`);
    }
  }
  return [...patterns];
}

export function loadLarkCliGuidance(): LarkCliGuidance {
  if (cached) return cached;

  const sourceRoot = path.resolve(process.cwd(), "cli-main", "tests", "cli_e2e", "docs");
  if (!fs.existsSync(sourceRoot)) {
    cached = DEFAULT_GUIDANCE;
    return cached;
  }

  const coverageText = safeRead(path.join(sourceRoot, "coverage.md"));
  const helpersText = safeRead(path.join(sourceRoot, "helpers_test.go"));
  const updateText = safeRead(path.join(sourceRoot, "docs_update_test.go"));
  const fetchText = safeRead(path.join(sourceRoot, "docs_create_fetch_test.go"));

  const supportedDocsCommands = collectSupportedCommands(coverageText);
  const commandPatterns = [
    ...collectGoCommandPatterns(helpersText),
    ...collectGoCommandPatterns(updateText),
    ...collectGoCommandPatterns(fetchText),
  ];

  cached = {
    enabled: supportedDocsCommands.length > 0 || commandPatterns.length > 0,
    sourceRoot,
    supportedDocsCommands,
    commandPatterns,
    templateHints: [
      "报告输出优先保持标题、摘要、分节三段式结构，正文使用可直接发布的 Markdown 叙述。",
      "分节内容避免占位式提示语，确保每节都是完整可读段落。",
      "文档更新默认采用 overwrite 思路：标题与正文需要保持一致性更新。",
    ],
    qualityChecks: [
      "发布前确保可解析出文档标识（如 data.doc_id）与状态成功字段。",
      "更新后建议执行一次 fetch 校验标题/关键内容是否落地。",
      "支持 dry-run 时，避免把语义告警文案当成最终报告内容输出。",
    ],
  };
  return cached;
}

