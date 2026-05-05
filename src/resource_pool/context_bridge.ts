import type { HydratedTaskContextPack } from "./context_pack.js";
import type { RetrievalContext } from "../schemas/index.js";
import type { TemplateProfile } from "../schemas/templateProfile.js";
import { excerptProseFromMarkdown } from "./templateStyleExcerpt.js";

/**
 * B3→C/A：把「HydratedPack」转成现有 `RetrievalContext.projectContext[]`。
 * **只追加片段，不写回调，不改写下游已有字段语义。**
 */
export function taskContextPackToProjectSlices(
  pack: HydratedTaskContextPack,
  templateProfiles?: Record<string, TemplateProfile>,
): RetrievalContext["projectContext"] {
  const out: RetrievalContext["projectContext"] = [];

  for (const doc of pack.documents) {
    const hasLevels = doc.outlineLevels && doc.outlineLevels.length > 0;
    const toc = hasLevels
      ? doc.outlineLevels!
          .map(({ level, title }) => `${"  ".repeat(Math.max(0, level - 1))}- ${title}`)
          .join("\n")
      : doc.outline.length > 0 &&
          !(doc.outline.length === 1 && doc.outline[0] === "正文")
        ? doc.outline.map((t) => `- ${t}`).join("\n")
        : "（未检测到模板标题块：请根据下方正文中的 Markdown # 标题归纳小节骨架）";

    const style =
      doc.styleExcerpt?.trim() ||
      excerptProseFromMarkdown(doc.body, 1600);

    const inner = [
      "## 【模板骨架 — Word/文档结构】以下为模板标题层级与顺序；生成报告的 sections 必须与此一致（heading 文本一致或可极小改写；层级含义一致）",
      toc,
      "",
      "## 【模板正文参考 — 版式层级】含 Markdown 标题（#）；请替换时间与事实，保留同款段落节奏与条目密度",
      doc.body,
      "",
      "## 【文风摘录 — 文字风格】模仿语气、句式、标点与详略；禁止照搬日期、项目名称与示例人名",
      style,
    ].join("\n");

    out.push({
      sourceId: `pool_doc:${doc.resourceId}`,
      sourceType: "doc",
      content: `# 模板文档：${doc.title}\n\n${inner}`,
    });
  }

  for (const c of pack.contacts) {
    out.push({
      sourceId: `pool_contact:${c.resourceId}`,
      sourceType: "im",
      content: `[联系人上下文] ${c.name}\n${c.detailText}`,
    });
  }

  for (const p of pack.projects) {
    out.push({
      sourceId: `pool_project:${p.resourceId}`,
      sourceType: "external",
      content: `[项目上下文] ${p.name}\n${p.detailText}`,
    });
  }

  for (const per of pack.personas) {
    out.push({
      sourceId: `persona:${per.userId}`,
      sourceType: "external",
      content: `[用户画像节选]\n${per.briefingText}`,
    });
  }

  if (templateProfiles) {
    for (const doc of pack.documents) {
      const profile = templateProfiles[doc.resourceId];
      if (!profile) continue;
      out.push({
        sourceId: `pool_template_profile:${doc.resourceId}`,
        sourceType: "doc",
        content: [
          `# TEMPLATE_PROFILE (${doc.resourceId})`,
          "Planner/Writer：`sections[].heading` 必须与下方 JSON 的 `sectionOrder` 逐项一致（顺序与字面）；正文按 `slotHints` 填充；遵守 `styleRules`，避开 `forbiddenPatterns`。",
          JSON.stringify(profile, null, 2),
        ].join("\n\n"),
      });
    }
  }

  return out;
}
