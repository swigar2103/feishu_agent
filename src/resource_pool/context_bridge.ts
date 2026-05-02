import type { HydratedTaskContextPack } from "./context_pack.js";
import type { RetrievalContext } from "../schemas/index.js";

/**
 * B3→C/A：把「HydratedPack」转成现有 `RetrievalContext.projectContext[]`。
 * **只追加片段，不写回调，不改写下游已有字段语义。**
 */
export function taskContextPackToProjectSlices(
  pack: HydratedTaskContextPack,
): RetrievalContext["projectContext"] {
  const out: RetrievalContext["projectContext"] = [];

  for (const doc of pack.documents) {
    const outlineSnippet =
      doc.outline.length > 0
        ? `\n小节标题：${doc.outline.slice(0, 12).join(" / ")}${doc.outline.length > 12 ? " …" : ""}`
        : "";
    out.push({
      sourceId: `pool_doc:${doc.resourceId}`,
      sourceType: "doc",
      content:
        `# ${doc.title}${outlineSnippet}\n\n`.trimEnd() + `\n\n${doc.body}`.trimStart(),
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

  return out;
}
