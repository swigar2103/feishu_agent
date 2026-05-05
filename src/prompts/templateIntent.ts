import type { RetrievalContext, UserRequest } from "../schemas/index.js";

/** 用户是否在语义上要求「以资源池/飞书文档为版式模板」 */
export function userWantsPoolDocumentTemplate(userRequest: UserRequest): boolean {
  const p = userRequest.prompt;
  const keywords = [
    "模板",
    "模版",
    "作为模板",
    "为模板",
    "以该文档",
    "以此文档",
    "这篇文档",
    "这个文档",
    "该文档",
    "按模板",
    "参照模板",
    "对照模板",
    "沿用模板",
    "照着",
    "版式",
  ];
  return keywords.some((k) => p.includes(k));
}

export function poolDocSlices(ctx: RetrievalContext): RetrievalContext["projectContext"] {
  return ctx.projectContext.filter((c) => c.sourceId.startsWith("pool_doc:"));
}

export function shouldHonorPoolDocumentStructure(
  userRequest: UserRequest,
  ctx: RetrievalContext,
): boolean {
  return userWantsPoolDocumentTemplate(userRequest) && poolDocSlices(ctx).length > 0;
}

/** 是否走「严格模板管线」（含蒸馏画像 pool_template_profile） */
export function useStrictTemplatePipeline(
  userRequest: UserRequest,
  ctx: RetrievalContext,
): boolean {
  if (shouldHonorPoolDocumentStructure(userRequest, ctx)) return true;
  const ids = ctx.templateDistillation?.profilesByResourceId;
  return !!ids && Object.keys(ids).length > 0;
}
