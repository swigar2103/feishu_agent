import { DetailedContextSchema, type CandidateResourceList, type DetailedContext, type ExecutionPlan } from "../../schemas/agentContracts.js";
import type { UserRequest } from "../../schemas/index.js";
import { parseJsonFromMd } from "./mdParser.js";
import { toolGateway } from "../toolGateway/gateway.js";
import { hasValidUserOAuth } from "../../storage/userOAuthStore.js";

type RawAsset = {
  sourceId: string;
  sourceType: "message" | "doc" | "table";
  content: string;
};

function toFact(sourceId: string, content: string, evidence?: string) {
  return {
    sourceId,
    fact: content,
    ...(evidence ? { evidence } : {}),
  };
}

/** 写入 facts 的摘录上限：原 500 过短，Writer 侧若只看 analysis 会几乎丢失云文档正文 */
const EXTERNAL_DOC_FACT_CAP = 12_000;

/** 会话内增量修订：把 latestReport 摘要与用户 extraContext 注入事实层，否则 Analyst/Writer 只看资产池，上一稿等于从未出现。 */
function buildSessionAnchoredFacts(request: UserRequest): Array<{
  sourceId: string;
  fact: string;
  evidence?: string;
}> {
  const out: Array<{ sourceId: string; fact: string; evidence?: string }> = [];
  const cap = (s: string, max: number) =>
    s.length <= max ? s : `${s.slice(0, max)}\n…（已截断，完整内容见用户请求 extraContext）`;

  if (request.chatPriorArtifactDigest?.trim()) {
    out.push(
      toFact(
        "session_latest_report_digest",
        cap(request.chatPriorArtifactDigest.trim(), 18_000),
        "【增量修订基线】当前会话最近一次已定稿报告（JSON 文本）；修订必须以此为出发点改写相应小节，不得无视用户意见重复原句。",
      ),
    );
  }

  const extras = request.extraContext ?? [];
  for (let i = 0; i < extras.length; i++) {
    const block = extras[i]?.trim();
    if (!block) continue;
    out.push(
      toFact(
        `user_extra_context_${i + 1}`,
        cap(block, 18_000),
        "【用户附加】含「对话区引用」及内嵌报告 JSON 片段；与摘要型 digest 冲突时，以用户意见与显式引用文字为准。",
      ),
    );
  }

  return out;
}

export async function deepRetrieveContext(input: {
  request: UserRequest;
  plan: ExecutionPlan;
  screened: CandidateResourceList;
}): Promise<DetailedContext> {
  const context =
    input.request.userId && hasValidUserOAuth(input.request.userId)
      ? { userId: input.request.userId, preferUserScope: true as const }
      : undefined;
  const assets = parseJsonFromMd<RawAsset[]>("src/data/assets.md");
  const screenedSet = new Set(input.screened.candidates.map((r) => r.resourceId));
  // 深读边界：仅允许读取 screening 已入选资源，避免绕过分层无限扩搜
  const selectedIds = screenedSet;

  const matchedAssets = assets.filter((item) => selectedIds.has(item.sourceId));
  const assetFacts = matchedAssets.map((item) => toFact(item.sourceId, item.content));

  const candidateDocs = input.screened.candidates.filter(
    (item) =>
      item.resourceType === "doc_summary" ||
      item.resourceType === "project_memory" ||
      item.resourceType === "table_summary",
  );

  const externalFacts: Array<{ sourceId: string; fact: string; evidence?: string }> = [];
  const externalDetails: Array<{ resourceId: string; detail: string }> = [];

  for (const doc of candidateDocs.slice(0, 6)) {
    const rawId = doc.resourceId.startsWith("ext_doc_")
      ? doc.resourceId.replace("ext_doc_", "")
      : doc.resourceId;
    const viewed = await toolGateway.viewDocument(rawId, context);
    if (viewed?.content) {
      const cap = Math.min(EXTERNAL_DOC_FACT_CAP, viewed.content.length);
      externalFacts.push(
        toFact(
          doc.resourceId,
          viewed.content.slice(0, cap),
          `云文档正文摘录（最多 ${EXTERNAL_DOC_FACT_CAP} 字符）；完整正文见 context.sourceDetails 同 resourceId`,
        ),
      );
      externalDetails.push({
        resourceId: doc.resourceId,
        detail: viewed.content,
      });
    } else {
      const content = await toolGateway.getFileContent(rawId, context);
      if (content) {
        const cap = Math.min(EXTERNAL_DOC_FACT_CAP, content.length);
        externalFacts.push(
          toFact(
            doc.resourceId,
            content.slice(0, cap),
            `附件/文件内容摘录；完整正文见 context.sourceDetails 同 resourceId`,
          ),
        );
        externalDetails.push({
          resourceId: doc.resourceId,
          detail: content,
        });
      }
    }

    const comments = await toolGateway.getComments(rawId, context);
    for (const comment of comments.slice(0, 3)) {
      externalFacts.push(
        toFact(doc.resourceId, `评论(${comment.author ?? "匿名"}): ${comment.content}`),
      );
    }
  }

  const historyFacts = input.request.historyDocs.map((doc, idx) =>
    toFact(`history_doc_${idx + 1}`, doc),
  );

  const contactFacts = input.request.imContacts.map((contact, idx) =>
    toFact(
      `im_contact_${idx + 1}`,
      `联系人 ${contact.name}(${contact.id}) 角色=${contact.role ?? "未知"} 可用于补充任务字段`,
    ),
  );

  const anchored = buildSessionAnchoredFacts(input.request);
  const anchoredDetails = anchored.map((a) => ({
    resourceId: a.sourceId,
    detail: a.fact,
  }));

  return DetailedContextSchema.parse({
    facts: [...anchored, ...assetFacts, ...externalFacts, ...historyFacts, ...contactFacts],
    sourceDetails: [
      ...anchoredDetails,
      ...matchedAssets.map((asset) => ({
        resourceId: asset.sourceId,
        detail: asset.content,
      })),
      ...externalDetails,
      ...input.request.personalKnowledge.map((item, idx) => ({
        resourceId: `pk_${idx + 1}`,
        detail: item,
      })),
    ],
  });
}
