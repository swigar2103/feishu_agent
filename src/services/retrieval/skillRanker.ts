import type { UserRequest } from "../../schemas/index.js";
import {
  cosineSim,
  embedSingle,
  embedTexts,
  type EmbeddingVector,
} from "../../llm/embeddingClient.js";
import { logger } from "../../shared/logger.js";
import type { SkillDoc } from "./mdParser.js";

type SkillIndexEntry = {
  doc: SkillDoc;
  vector: EmbeddingVector | null; // null 表示该 skill 没能预算到 embedding
};

export type RankScore = {
  doc: SkillDoc;
  score: number;
  breakdown: {
    semantic: number;
    industry: number;
    reportType: number;
    keyword: number;
  };
};

/**
 * 把一个 SkillDoc 折叠成一段可以语义化对齐的文本，用于 embedding 索引。
 */
function flattenSkillForEmbedding(doc: SkillDoc): string {
  const parts = [
    doc.meta.name,
    doc.meta.description,
    `行业=${doc.skill.industry}`,
    `报告类型=${doc.skill.reportType}`,
    `章节=${doc.skill.sections.join("、")}`,
    `术语=${(doc.skill.terminology ?? []).join("、")}`,
    `风格=${(doc.skill.styleRules ?? []).join("；")}`,
    `指导=${doc.guidance.slice(0, 8).join("；")}`,
  ].filter(Boolean);
  return parts.join("\n");
}

function flattenUserRequestForEmbedding(req: UserRequest): string {
  return [
    req.prompt,
    req.industry ? `行业=${req.industry}` : "",
    req.reportType ? `报告类型=${req.reportType}` : "",
    req.extraContext.length > 0 ? `背景=${req.extraContext.join("；")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * 规则层：industry / reportType 的精确或部分匹配加权（0~1）
 */
function structuralScore(doc: SkillDoc, request: UserRequest): {
  industry: number;
  reportType: number;
} {
  const reqInd = (request.industry ?? "").toLowerCase().trim();
  const reqType = (request.reportType ?? "").toLowerCase().trim();
  const skillInd = doc.skill.industry.toLowerCase().trim();
  const skillType = doc.skill.reportType.toLowerCase().trim();

  const industry = !reqInd
    ? 0
    : skillInd === reqInd
      ? 1
      : skillInd.includes(reqInd) || reqInd.includes(skillInd)
        ? 0.6
        : 0;

  const reportType = !reqType
    ? 0
    : skillType === reqType
      ? 1
      : skillType.includes(reqType) || reqType.includes(skillType)
        ? 0.6
        : 0;

  return { industry, reportType };
}

/**
 * 关键词 overlap 作为最弱保底信号（语义 + 规则都失败时，至少能打个平局）
 */
function keywordScore(doc: SkillDoc, request: UserRequest): number {
  const haystack = flattenSkillForEmbedding(doc).toLowerCase();
  const tokens = new Set(
    [request.prompt, request.industry ?? "", request.reportType ?? ""]
      .join(" ")
      .toLowerCase()
      .split(/[\s,，。；;、]+/u)
      .filter((t) => t.length >= 2),
  );
  if (tokens.size === 0) return 0;
  let hit = 0;
  for (const t of tokens) {
    if (haystack.includes(t)) hit += 1;
  }
  return hit / tokens.size;
}

/**
 * 总分 = semantic * 0.55 + reportType * 0.25 + industry * 0.15 + keyword * 0.05
 * 当 semantic 不可用（null）时，按剩余权重归一化：reportType 0.55 + industry 0.35 + keyword 0.10
 */
function combineScore(parts: RankScore["breakdown"], semanticAvailable: boolean): number {
  if (semanticAvailable) {
    return (
      parts.semantic * 0.55 +
      parts.reportType * 0.25 +
      parts.industry * 0.15 +
      parts.keyword * 0.05
    );
  }
  return parts.reportType * 0.55 + parts.industry * 0.35 + parts.keyword * 0.1;
}

export class SkillRanker {
  private index: SkillIndexEntry[] = [];
  private embeddingEnabled = false;
  private ready = false;

  /**
   * 启动时预计算所有 skill 的 embedding；失败时把所有 vector 置 null，后续只走规则+关键词打分。
   */
  async init(docs: SkillDoc[]): Promise<void> {
    if (this.ready) return;

    if (docs.length === 0) {
      this.index = [];
      this.ready = true;
      return;
    }

    try {
      const texts = docs.map(flattenSkillForEmbedding);
      const vectors = await embedTexts(texts);
      this.index = docs.map((doc, i) => ({ doc, vector: vectors[i] ?? null }));
      this.embeddingEnabled = vectors.every((v) => v && v.length > 0);
      logger.info(
        `[SkillRanker] 索引建立完成 total=${docs.length} embedding=${this.embeddingEnabled ? "on" : "off"}`,
      );
    } catch (error) {
      logger.warn("[SkillRanker] embedding 索引失败，回退到规则+关键词打分", {
        error: error instanceof Error ? error.message : String(error),
      });
      this.index = docs.map((doc) => ({ doc, vector: null }));
      this.embeddingEnabled = false;
    } finally {
      this.ready = true;
    }
  }

  /**
   * 对外唯一打分入口。异常情况（索引为空 / embedding 调用失败）都在内部降级，永远返回一个 top 候选或 null。
   */
  async rank(request: UserRequest): Promise<RankScore[]> {
    if (!this.ready) {
      throw new Error("SkillRanker.rank 在 init 前被调用");
    }
    if (this.index.length === 0) return [];

    let queryVec: EmbeddingVector | null = null;
    if (this.embeddingEnabled) {
      try {
        queryVec = await embedSingle(flattenUserRequestForEmbedding(request));
      } catch (error) {
        logger.warn("[SkillRanker] query embedding 失败，本次回退到规则+关键词打分", {
          error: error instanceof Error ? error.message : String(error),
        });
        queryVec = null;
      }
    }

    const scored: RankScore[] = this.index.map((entry) => {
      const semantic =
        queryVec && entry.vector ? Math.max(0, cosineSim(queryVec, entry.vector)) : 0;
      const { industry, reportType } = structuralScore(entry.doc, request);
      const keyword = keywordScore(entry.doc, request);
      const breakdown = { semantic, industry, reportType, keyword };
      const score = combineScore(breakdown, Boolean(queryVec));
      return { doc: entry.doc, score, breakdown };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored;
  }

  async pickBest(request: UserRequest): Promise<RankScore | null> {
    const ranked = await this.rank(request);
    return ranked[0] ?? null;
  }
}
