/**
 * 通用「内容污染」识别工具 —— 用于：
 *  1) ToolGateway 深读外部文档后做 evidence 入口过滤（避免把"上次失败日志/报错文档"当真实素材喂给 Writer）；
 *  2) Resource Pool 二次过滤；
 *  3) Memory Writeback 终末门控（已在 memoryWritebackService 内联使用相同语义）。
 *
 * 设计要点：
 * - 关键词必须严格指向"系统失败痕迹"或"占位语"，避免误伤正常业务文档（如真在汇报"docID 治理"的文档）。
 * - 命中阈值采用复合判定：单条关键词不足以丢弃整篇，需出现「错误日志哈希 / VALIDATION 编码 / 多次连续提示语」之一。
 */

const SYSTEM_FAILURE_HASH = /\b\d{14,}[A-F0-9]{6,}\b/i;
const VALIDATION_CODE = /VALIDATION:\d{3,}/i;
const STRUCTURED_FAILURE_KEYWORDS = [
  /文档\s*ID\s*为空/i,
  /document\s*id\s*missing/i,
  /参数\s*校验\s*失败/i,
  /params?\s+error/i,
  /字段\s*校验\s*失败/i,
  /field\s+validation\s+failed/i,
  /工具\s*降级|fallback\s+placeholder/i,
  /Writer\s*JSON\s*生成未通过校验/i,
  /严格真实模式：?Writer\s*失败/i,
  /兜底占位稿/i,
];
const SOFT_HINTS = [/无法获取/, /无法加载/, /无法访问/, /缺失/, /占位/, /TODO/i];

export type DocPollutionVerdict = {
  polluted: boolean;
  reasons: string[];
};

/**
 * 判定一段外部文档正文是否属于"系统失败痕迹/占位文档"。
 * 触发任一硬条件（VALIDATION 编码 / 失败哈希 / 结构化失败关键词出现 ≥1 次）→ 直接丢弃；
 * 仅命中 SOFT_HINTS 时需累计 ≥3 次方丢弃，避免误伤正常文档。
 */
export function detectDocumentPollution(input: {
  title?: string | null;
  content?: string | null;
}): DocPollutionVerdict {
  const reasons: string[] = [];
  const haystack = `${input.title ?? ""}\n${input.content ?? ""}`;
  if (!haystack.trim()) return { polluted: false, reasons };

  if (VALIDATION_CODE.test(haystack)) reasons.push("validation_code");
  if (SYSTEM_FAILURE_HASH.test(haystack)) {
    const hashCount = haystack.match(/\b\d{14,}[A-F0-9]{6,}\b/gi)?.length ?? 0;
    if (hashCount >= 2) reasons.push(`failure_hash_x${hashCount}`);
  }

  const structuralHits = STRUCTURED_FAILURE_KEYWORDS.filter((re) => re.test(haystack)).length;
  if (structuralHits >= 1) reasons.push(`structured_failure_keyword_x${structuralHits}`);

  if (reasons.length === 0) {
    const softHits = SOFT_HINTS.filter((re) => re.test(haystack)).length;
    if (softHits >= 3) reasons.push(`soft_hint_x${softHits}`);
  }

  return { polluted: reasons.length > 0, reasons };
}
