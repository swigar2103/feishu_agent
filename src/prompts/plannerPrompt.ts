import type { RetrievalContext, UserRequest } from "../schemas/index.js";
import { useStrictTemplatePipeline } from "./templateIntent.js";

export function buildPlannerSystemPrompt(): string {
  return [
    "你是企业办公报告流程中的 Orchestrator/Planner。",
    "你的职责只有：做计划与决策，不写长正文。",
    "若用户指定以资源池云文档为模板，targetSections 必须从该文档正文标题抽取，而不是套用技能文件的默认小节列表。",
    "必须输出严格 JSON，不要输出任何解释文本。",
    "禁止使用 markdown 包裹 JSON。",
    "输出字段必须完整且类型正确：",
    "{",
    '  "reportType": string,',
    '  "selectedSkillId": string,',
    '  "missingFields": string[],',
    '  "targetSections": string[],',
    '  "targetTone": string,',
    '  "useSources": string[]',
    "}",
  ].join("\n");
}

export function buildPlannerUserPrompt(
  userRequest: UserRequest,
  retrievalContext: RetrievalContext,
): string {
  const honorTemplate = useStrictTemplatePipeline(userRequest, retrievalContext);
  const templateRules = honorTemplate
    ? [
        "【模板结构优先】上下文含 pool_doc 或 pool_template_profile（JSON）：",
        "  - 若存在 `pool_template_profile:*`，**targetSections 必须与其中 JSON 的 sectionOrder 完全一致**（顺序、字面，含【】）；不得以 skill.sections 顶替。",
        "  - listPatterns / slotHints 仅用于理解列表语法与填空意图；输出仍是合法 TaskPlan JSON。",
        "  - 若模板小节多于 skill 常用三节，允许更长列表；若模板只有少量章节，如实反映即可。",
        "  - useSources 必须包含用到的 pool_doc、以及对应的 pool_template_profile（若存在）的 sourceId。",
      ]
    : [];

  const sectionRule = honorTemplate
    ? "3) targetSections：在满足【模板结构优先】前提下列出章节（忽略 skill.sections 的默认三节约束）"
    : "3) targetSections 优先沿用 skill.sections";

  return [
    "请根据以下输入生成 TaskPlan JSON：",
    `userRequest=${JSON.stringify(userRequest)}`,
    `retrievalContext=${JSON.stringify(retrievalContext)}`,
    `skillStyleHints=${JSON.stringify(retrievalContext.styleHints)}`,
    "要求：",
    "1) selectedSkillId 必须取 matchedSkill.skillId",
    "2) missingFields 根据 requiredInputs 与 userRequest 补全差异",
    sectionRule,
    "4) useSources 填写 projectContext 的 sourceId 列表",
    "5) targetTone 优先参考 userMemory.preferredTone 与 styleHints 中的 SKILL_GUIDE",
    ...templateRules,
    "6) 仅输出 JSON 对象",
  ].join("\n");
}
