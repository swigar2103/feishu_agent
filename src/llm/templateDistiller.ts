import { env } from "../config/env.js";
import { invokeBailianModel } from "./client.js";
import { extractJsonObject } from "../shared/utils.js";
import type { HydratedTaskContextPack } from "../resource_pool/context_pack.js";
import {
  TemplateProfileSchema,
  type TemplateProfile,
} from "../schemas/templateProfile.js";

function heuristicTemplateProfile(
  doc: HydratedTaskContextPack["documents"][number],
): TemplateProfile {
  const sectionOrder =
    doc.outlineLevels && doc.outlineLevels.length > 0
      ? [...doc.outlineLevels]
          .sort((a, b) => a.level - b.level || a.title.localeCompare(b.title))
          .map((x) => x.title)
      : doc.outline.length > 0
        ? [...doc.outline]
        : ["正文"];

  const planLike = sectionOrder.filter((t) => /计划|待办|工作\s*\d/i.test(t));

  return TemplateProfileSchema.parse({
    version: 1,
    resourceId: doc.resourceId,
    sectionOrder,
    fixedLabels: [],
    listPatterns: [],
    styleRules: [
      "小节标题尽量与模板字面一致（含【】）。",
      "条目化叙述，结论简短；避免长篇背景。",
      "责任人、时间点可用「负责人：」「截止：」这类标签模仿版式，但不要抄写模板里的示例姓名与日期。",
    ],
    forbiddenPatterns: [],
    anonymizedStyleSample: doc.styleExcerpt?.slice(0, 800),
    slotHints: sectionOrder.map((title, i) => ({
      slotId: `slot_${i}`,
      sectionHeading: title,
      description: "仅依据用户本期 prompt 中的事实撰写；勿复述模板示例段落",
    })),
    wordExportHints: {
      numberedListForSectionsIncluding:
        planLike.length > 0 ? planLike : ["本周计划", "计划", "待办"],
    },
  });
}

async function distillOneDocument(
  doc: HydratedTaskContextPack["documents"][number],
): Promise<TemplateProfile> {
  const bodySlice = doc.body.slice(0, 14_000);
  const systemPrompt = [
    "你是「周报/工作报告模板蒸馏器」。输入为一篇文档的 Markdown 标题层级与正文节选。",
    "输出唯一 JSON（不要 Markdown 围栏），字段必须齐全：",
    "{",
    '  "version": 1,',
    '  "titlePattern": "可选：含占位符的报告标题模板",',
    '  "sectionOrder": ["按阅读顺序列出全部小节标题，保留原文包括【】"],',
    '  "fixedLabels": ["文中重复出现的字段标签，如：总负责人、验收"],',
    '  "listPatterns": [{ "underSection": "小节名", "formatDescription": "列表行语法模板，用占位符 {task},{mention},{deadline}", "placeholderHints": ["可选"] }],',
    '  "styleRules": ["5条以内：文风、条目密度、口吻"],',
    '  "forbiddenPatterns": ["生成时必须避免的示例话题关键词（从模板示例归纳，勿抄原句）"],',
    '  "anonymizedStyleSample": "≤400字：去掉所有人名/@/日期后的文风示例改写",',
    '  "slotHints": [{ "slotId": "s0", "sectionHeading": "与 sectionOrder 一致", "description": "本节应写什么类型的内容" }],',
    '  "wordExportHints": {',
    '    "sectionHeadingLevels": [{ "headingIncludes": "标题子串", "level": "H1"|"H2"|"H3"|"TITLE" }],',
    '    "numberedListForSectionsIncluding": ["需要对正文按条编号导出的小节标题子串，如：本周计划"],',
    '    "dotxRelativePath": "可选：固定填 docs/templates/report-shell.dotx 占位"',
    "  }",
    "}",
    "硬性要求：sectionOrder.length≥1；slotHints 与 sectionOrder 一一对应；禁止输出模板原文整句抄袭到 anonymizedStyleSample。",
  ].join("\n");

  const userPayload = {
    resourceId: doc.resourceId,
    title: doc.title,
    outlineLevels: doc.outlineLevels ?? [],
    outline: doc.outline,
    bodyMarkdownSlice: bodySlice,
    styleExcerpt: doc.styleExcerpt ?? "",
  };

  try {
    const raw = await invokeBailianModel({
      model: env.BAILIAN_MODEL_ORCHESTRATOR,
      systemPrompt,
      userPrompt: JSON.stringify(userPayload),
      jsonMode: true,
    });
    const json = extractJsonObject(raw);
    const parsed = TemplateProfileSchema.safeParse(JSON.parse(json));
    if (!parsed.success) {
      console.warn("[templateDistiller] JSON 校验失败，使用启发式模板。", parsed.error);
      return heuristicTemplateProfile(doc);
    }
    return TemplateProfileSchema.parse({
      ...parsed.data,
      resourceId: doc.resourceId,
    });
  } catch (e) {
    console.warn("[templateDistiller] LLM 蒸馏失败，使用启发式模板。", e);
    return heuristicTemplateProfile(doc);
  }
}

/** A+C：对每个入选文档蒸馏 TemplateProfile（并行）；失败回落启发式 */
export async function distillTemplateProfilesFromPack(
  documents: HydratedTaskContextPack["documents"],
): Promise<Record<string, TemplateProfile>> {
  if (documents.length === 0) return {};
  const pairs = await Promise.all(
    documents.map(async (doc) => [doc.resourceId, await distillOneDocument(doc)] as const),
  );
  return Object.fromEntries(pairs);
}
