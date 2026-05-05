import type { WriterInput } from "../schemas/index.js";
import { useStrictTemplatePipeline } from "./templateIntent.js";

export function buildWriterSystemPrompt(): string {
  return [
    "你是企业办公报告生成流程中的 Writer/Analyst。",
    "当输入中含模板文档（pool_doc）且用户要求沿用模板时：须同时还原模板的章节骨架（标题层级与顺序）并在行文上贴近模板的语气、句式与详略；禁止仅用技能默认小节替代模板结构。",
    "请根据输入生成结构化报告内容。",
    "必须输出严格 JSON，不要输出任何解释文本。",
    "禁止使用 markdown 包裹 JSON。",
    "输出字段必须完整且类型正确：",
    "{",
    '  "title": string,',
    '  "summary": string,',
    '  "sections": [{"heading": string, "content": string}],',
    '  "chartSuggestions": [{"type": string, "title": string, "purpose": string, "dataHint": string}],',
    '  "openQuestions": string[]',
    "}",
  ].join("\n");
}

export function buildWriterUserPrompt(writerInput: WriterInput): string {
  const honorTemplate = useStrictTemplatePipeline(
    writerInput.userRequest,
    writerInput.retrievalContext,
  );
  const isWeeklySkill =
    /weekly/i.test(writerInput.taskPlan.selectedSkillId) ||
    writerInput.taskPlan.reportType.includes("周报");
  const skillHints = writerInput.retrievalContext.styleHints.filter(
    (line) => line.startsWith("SKILL_GUIDE:") || line.startsWith("SKILL_DESC:"),
  );

  const templateBlock = honorTemplate
    ? [
        "【模板版式优先】用户指定以资源池云文档（pool_doc）为模板：",
        "- 【TEMPLATE_PROFILE】若上下文中存在 `pool_template_profile` JSON：`sections` 的数量与顺序必须与 `sectionOrder` 一致；`content` 对齐对应 `slotHints.description`。",
        "- sections[].content：结构上对齐模板的小节意图；文风上对齐「文风摘录」的语气、句式与详略；禁止照搬模板旧日期、周期与示例人名；禁止写入与模板示例无关的业务占位（如随机产品线与人名）。",
        "- 【反复述】禁止输出与模板正文连续相同的语句（≥12 个汉字视为复述）；模板中出现的 @昵称、部门名、具体日期区间、百分比数字一律不得写入输出，除非 userRequest.prompt 明确提供了同名事实。",
        "- 【Markdown】sections[].content 使用纯段落或简洁条目即可，少用 `#`/`##` 标题前缀（小节标题已由 heading 字段承载）；避免把 Markdown 标题符号塞进正文造成导出怪异。",
        "- title/summary 反映用户当前写作意图，可采用模板语气但不要复制模板的时间落款。",
      ]
    : [];

  const sectionRule = honorTemplate
    ? "2) sections：逐项对应 taskPlan.targetSections（见【模板版式优先】）；heading 必须用 taskPlan 中的字符串"
    : "2) sections 需覆盖 taskPlan.targetSections";

  const qualityBlock = [
    "【质量与版式（必读）】",
    "- 每一个 sections[].content 必须是非空正文：至少 2 句完整中文句子（或等效信息量的条目组），禁止只写标题、禁止仅输出标点或空白。",
    "- 【去重】同一具体事项（如某 PRD 冻结、某次会议）在全文最多用「完整段落级表述」出现两次：通常在「摘要」与「已完成/关键进展」之一详写，其它小节用短语指代或合并，不要复制粘贴整段。",
    "- 【时间语义】若 userRequest 写明「下周计划」：小节标题含「本周计划」时只写本周安排；下一周期的条目归到「下周计划」或模板中等价章节，勿混用。",
    "- openQuestions 只写真实业务待澄清点；禁止输出「请补充字段」「可通过 IM 联系人收集」等系统提示式话术。",
  ];

  const weeklyBlock = isWeeklySkill
    ? [
        "【周报专规】",
        "- 语气像直属上级可读的一线周报：先事实后评价，避免同一句子在「工作内容」「已完成」「关键进展」之间重复粘贴。",
        "- 「遇到的问题」只写本周实际卡点；若无则写「本周无新增阻塞」一句即可，勿编造。",
      ]
    : [];

  return [
    "请依据以下 WriterInput 生成报告 JSON：",
    JSON.stringify(writerInput),
    `skillHints=${JSON.stringify(skillHints)}`,
    "要求：",
    "1) summary 要有管理层可读的结论性表达",
    sectionRule,
    "3) chartSuggestions 与 chartRules、数据语义一致",
    "4) 明确遵循 skillHints 中的自然语言指导（若有）",
    "5) openQuestions 填写仍缺失的信息点",
    ...qualityBlock,
    ...weeklyBlock,
    ...templateBlock,
    "6) 仅输出 JSON 对象",
  ].join("\n");
}
