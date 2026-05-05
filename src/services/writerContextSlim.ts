import type { RetrievalContext, UserRequest } from "../schemas/index.js";
import { useStrictTemplatePipeline } from "../prompts/templateIntent.js";

/**
 * Planner/Orchestrator 仍需完整 pool_doc 以抽取 targetSections；
 * Writer 若也喂全文，极易逐句复述模板。**仅在「模板模式」下**去掉正文 prose，只保留骨架目录 + 标题行预览 + 缩短的文风摘录。
 */
export function slimRetrievalContextForWriter(
  ctx: RetrievalContext,
  userRequest: UserRequest,
): RetrievalContext {
  if (!useStrictTemplatePipeline(userRequest, ctx)) return ctx;

  const projectContext = ctx.projectContext.map((slice) => {
    if (slice.sourceType !== "doc" || !slice.sourceId.startsWith("pool_doc:")) {
      return slice;
    }
    return { ...slice, content: slimSinglePoolDocContent(slice.content) };
  });

  return { ...ctx, projectContext };
}

function slimSinglePoolDocContent(full: string): string {
  const skeletonNeedle = "## 【模板骨架";
  const bodyNeedle = "## 【模板正文参考";
  const styleNeedle = "## 【文风摘录";

  const si = full.indexOf(skeletonNeedle);
  const bi = full.indexOf(bodyNeedle);
  const yi = full.indexOf(styleNeedle);
  if (si === -1 || bi === -1 || yi === -1) return full;

  const skeleton = full.slice(si, bi).trim();
  const bodyChunk = full.slice(bi, yi);
  const styleChunk = full.slice(yi).trim();

  const headingLines = bodyChunk
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^#{1,6}\s/.test(l))
    .slice(0, 64);

  const condensedBody = [
    "## 【模板正文参考 — 仅标题层级】",
    "以下为模板中出现的 Markdown 标题行（#），用于对齐章节层级。**禁止**照抄模板正文段落、示例数据、@提及的人名与日期；请根据用户本次任务全新撰写正文。",
    headingLines.length > 0
      ? headingLines.join("\n")
      : "（未能解析到标题行：请依据上方【模板骨架】目录生成）",
  ].join("\n\n");

  const styleBody = styleChunk
    .replace(/^## 【文风摘录[^\n]*\n/, "")
    .trim()
    .slice(0, 1400);

  const condensedStyle = `## 【文风摘录 — 文字风格】（摘录缩短，仅模仿语气句式）\n${styleBody}`;

  const titleLine = full.match(/^#\s[^\n]+/)?.[0] ?? "# 模板文档";

  return `${titleLine}\n\n${skeleton}\n\n${condensedBody}\n\n${condensedStyle}`;
}
