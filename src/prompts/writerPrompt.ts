import type { ReviewIssue, WriterInput, WriterOutput } from "../schemas/index.js";

export function buildWriterSystemPrompt(isRevision = false): string {
  const base = [
    "你是企业办公报告生成流程中的 Writer。",
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
  ];

  if (isRevision) {
    base.push(
      "",
      "当前处于 *改写模式*：Reviewer 已指出若干问题，必须逐条解决后再输出。",
      "- 保留上一版中正确的章节和数据，不要全部推翻重来。",
      "- 针对 reviewIssues 中的每条 issue，在对应章节做最小必要修改或补充。",
      "- 改写完成后仍必须满足所有原始要求。",
    );
  }

  return base.join("\n");
}

export function buildWriterUserPrompt(
  writerInput: WriterInput,
  revision?: { previousDraft: WriterOutput | null; issues: ReviewIssue[] } | undefined,
): string {
  const skillHints = writerInput.retrievalContext.styleHints.filter(
    (line) => line.startsWith("SKILL_GUIDE:") || line.startsWith("SKILL_DESC:"),
  );

  const analyst = writerInput.analystOutput;
  const analystBrief = analyst
    ? {
        kpis: analyst.kpis,
        chartCandidates: analyst.chartCandidates,
        highlights: analyst.highlights,
        dataQualityNotes: analyst.dataQualityNotes,
      }
    : null;

  // Phase 3.2：把 userMemory 单独高亮，不再只埋在 retrievalContext 的 JSON 中。
  // 这样 LLM 更容易识别"该用户的历史偏好"这一上下文，并在本次输出中向其收敛。
  const mem = writerInput.retrievalContext.userMemory;
  const memoryProfile = {
    preferredTone: mem.preferredTone ?? null,
    preferredStructure: mem.preferredStructure ?? [],
    commonTerms: mem.commonTerms ?? [],
    styleNotes: mem.styleNotes ?? [],
  };
  const hasAnyMemory =
    Boolean(memoryProfile.preferredTone) ||
    memoryProfile.preferredStructure.length > 0 ||
    memoryProfile.commonTerms.length > 0 ||
    memoryProfile.styleNotes.length > 0;

  const lines = [
    "请依据以下 WriterInput 生成报告 JSON：",
    JSON.stringify({
      userRequest: writerInput.userRequest,
      taskPlan: writerInput.taskPlan,
      retrievalContext: writerInput.retrievalContext,
    }),
    `skillHints=${JSON.stringify(skillHints)}`,
    `analystBrief=${JSON.stringify(analystBrief)}`,
    `userMemoryProfile=${JSON.stringify(memoryProfile)}`,
  ];

  if (hasAnyMemory) {
    lines.push(
      "用户历史偏好（强约束，必须在本次输出里明显体现）：",
      "- 若 userMemoryProfile.preferredTone 非空，本次行文的整体语气必须采用该 tone（与 taskPlan.targetTone 平级；当二者冲突时以用户历史偏好为准）",
      "- userMemoryProfile.commonTerms 是该用户过往报告中反复使用过的术语，遇到同义表达时优先使用这些词，不要用同义词替换",
      "- userMemoryProfile.preferredStructure 中出现过的章节 heading，如果与 taskPlan.targetSections 不冲突，必须原样保留用词（避免把 “执行摘要” 改成 “概述” 等）",
      "- userMemoryProfile.styleNotes 是硬性风格约束（如 “段落前加粗标题”、“百分比保留两位小数”），必须全部满足",
    );
  }

  if (revision) {
    lines.push(
      `previousDraft=${JSON.stringify(revision.previousDraft)}`,
      `reviewIssues=${JSON.stringify(revision.issues)}`,
      "改写要求：",
      "1) 保留 previousDraft 中正确的内容，只对被 reviewIssues 点名的地方做修正",
      "2) 每条 issue 在本轮输出中必须可核查地得到处理（补章节 / 修术语 / 补 KPI 引用等）",
      "3) openQuestions 必须先继承 previousDraft.openQuestions，然后仅在本轮确实发现了新的、未出现过的缺口时才追加；已在 reviewIssues.suggestion 中有明确建议的不要再作为 openQuestion 提出",
      "4) 禁止新增在 previousDraft.openQuestions 中已经存在或语义重复的问题（相似问题合并成一条）",
      "5) 若 reviewIssues 中有 data_quality 类型且提示数据缺失，请把对应的缺失字段名合并写成一条 openQuestion（形如 『需补充：<字段名>』），不要一项一条",
      "6) 仍需满足下面的通用要求",
    );
  }

  lines.push(
    "通用要求：",
    "1) summary 要有管理层可读的结论性表达",
    "2) sections 需覆盖 taskPlan.targetSections，章节内容要引用 analystBrief.kpis / highlights 中的量化信息",
    "3) chartSuggestions 必须优先复用 analystBrief.chartCandidates，只有确有必要才新增",
    "4) 若 analystBrief.dataQualityNotes 非空，请在合适章节或 openQuestions 中提示数据口径风险",
    "5) 明确遵循 skillHints 中的自然语言指导（若有）",
    "6) openQuestions 填写仍缺失或存疑的信息点",
    "7) 仅输出 JSON 对象",
  );

  return lines.join("\n");
}
