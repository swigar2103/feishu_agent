import fs from "node:fs";
import path from "node:path";

export type LarkCliGuidance = {
  enabled: boolean;
  sourceRoot: string;
  supportedDocsCommands: string[];
  commandPatterns: string[];
  hardRules: string[];
  styleHints: string[];
  templateHints: string[];
  qualityChecks: string[];
};

const DEFAULT_GUIDANCE: LarkCliGuidance = {
  enabled: false,
  sourceRoot: "",
  supportedDocsCommands: [],
  commandPatterns: [],
  hardRules: [],
  styleHints: [],
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

function collectDocSkillHardRules(skillText: string, fetchRefText: string): string[] {
  const hardRules = new Set<string>();
  if (/docs\s*\+create[\s\S]*--api-version v2/i.test(skillText)) {
    hardRules.add("docs +create/+fetch/+update 必须携带 --api-version v2。");
  }
  if (/默认使用 DocxXML 格式/i.test(skillText)) {
    hardRules.add("未明确要求 Markdown 时，文档创建与精准编辑优先采用 XML/DocxXML。");
  }
  if (/精准编辑场景[\s\S]*优先使用 XML/i.test(skillText)) {
    hardRules.add("对局部精修指令（str_replace/block_replace 等）必须使用 XML，避免结构损坏。");
  }
  if (/局部获取优于全量获取/i.test(fetchRefText)) {
    hardRules.add("读取文档内容时优先局部读取（outline/section/range/keyword），避免整篇拉取。");
  }
  return [...hardRules];
}

function collectDocSkillStyleHints(skillText: string): string[] {
  const hints = new Set<string>();
  if (/创建 \/ 导入场景[\s\S]*XML 和 Markdown 都可以/i.test(skillText)) {
    hints.add("整段写入可使用 XML 或 Markdown；用户明确要求 Markdown 时再切换。");
  }
  if (/drive \+search[\s\S]*统一入口/i.test(skillText)) {
    hints.add("资源发现优先走 drive +search，不依赖已废弃的 docs +search 新流程。");
  }
  hints.add("先保证文档标题、摘要、分节结构完整，再进行样式增强。");
  hints.add("更新文档后建议执行一次 fetch 校验标题与关键段落是否落地。");
  return [...hints];
}

export function loadLarkCliGuidance(): LarkCliGuidance {
  if (cached) return cached;

  const e2eRoot = path.resolve(process.cwd(), "cli-main", "tests", "cli_e2e", "docs");
  const skillRoot = path.resolve(process.cwd(), "cli-main", "skills", "lark-doc");
  const sourceRoots = [e2eRoot, skillRoot].filter((root) => fs.existsSync(root));
  if (sourceRoots.length === 0) {
    cached = DEFAULT_GUIDANCE;
    return cached;
  }

  const coverageText = safeRead(path.join(e2eRoot, "coverage.md"));
  const helpersText = safeRead(path.join(e2eRoot, "helpers_test.go"));
  const updateText = safeRead(path.join(e2eRoot, "docs_update_test.go"));
  const fetchText = safeRead(path.join(e2eRoot, "docs_create_fetch_test.go"));
  const skillText = safeRead(path.join(skillRoot, "SKILL.md"));
  const fetchRefText = safeRead(path.join(skillRoot, "references", "lark-doc-fetch.md"));

  const supportedDocsCommands = Array.from(
    new Set([...collectSupportedCommands(coverageText), ...collectSupportedCommands(skillText)]),
  );
  const commandPatterns = [
    ...collectGoCommandPatterns(helpersText),
    ...collectGoCommandPatterns(updateText),
    ...collectGoCommandPatterns(fetchText),
  ];
  const hardRules = collectDocSkillHardRules(skillText, fetchRefText);
  const styleHints = collectDocSkillStyleHints(skillText);

  cached = {
    enabled:
      supportedDocsCommands.length > 0 ||
      commandPatterns.length > 0 ||
      hardRules.length > 0 ||
      styleHints.length > 0,
    sourceRoot: sourceRoots.join(";"),
    supportedDocsCommands,
    commandPatterns,
    hardRules,
    styleHints,
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

