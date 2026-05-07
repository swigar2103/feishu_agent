import { z } from "zod";
import { env } from "../../config/env.js";
import { logger } from "../../shared/logger.js";
import { extractJsonObject } from "../../shared/utils.js";
import { invokeBailianModel } from "../../llm/client.js";
import { toolGateway } from "../toolGateway/gateway.js";
import { MemoryStore } from "../../storage/memoryStore.js";
import { HmrsRepository } from "./hmrsRepository.js";
import { HMRS_FOLDER_NAMES } from "./hmrsStructureBuilder.js";

export const StyleProfileSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string(),
  ownerUserId: z.string(),
  toneTags: z.array(z.string()).default([]),
  sentencePatterns: z.array(z.string()).default([]),
  preferredSectionOrder: z.array(z.string()).default([]),
  preferredVisualKinds: z
    .array(z.enum(["gantt", "timeline", "line", "bar", "pie", "table", "image"]))
    .default([]),
  commonTerms: z.array(z.string()).default([]),
  forbiddenWords: z.array(z.string()).default([]),
  anonymizedStyleSample: z.string().default(""),
  observedSampleCount: z.number().default(0),
  editSignalSummary: z
    .object({
      manualEditCount: z.number().default(0),
      aiRewriteCount: z.number().default(0),
      frequentlyEditedSections: z.array(z.string()).default([]),
    })
    .default({
      manualEditCount: 0,
      aiRewriteCount: 0,
      frequentlyEditedSections: [],
    }),
});

export type StyleProfile = z.infer<typeof StyleProfileSchema>;

export type StyleDistillerInput = {
  userId: string;
  hmrsRootToken: string;
  /** 最多读多少篇用户已纳管文档作为风格语料 */
  maxDocs?: number;
  /** 单篇正文截断长度，避免上下文爆量 */
  maxCharsPerDoc?: number;
  /** 触发口径（手动 vs 编辑信号驱动），仅写入埋点 */
  trigger?: "refresh" | "edit_feedback";
};

export type StyleDistillerOutput = {
  profile: StyleProfile;
  observedDocs: number;
  trigger: "refresh" | "edit_feedback";
};

const DEFAULT_MAX_DOCS = 8;
const DEFAULT_MAX_CHARS_PER_DOC = 6_000;
const PROFILE_FILE_NAME = "style_profile.json";
const THOUGHT_FILE_NAME = "writing_thought.md";
const FALLBACK_STYLE_FILE_NAME = "style_identity.md";

function fallbackStyleProfile(input: {
  userId: string;
  observedSampleCount: number;
  editSignalSummary: StyleProfile["editSignalSummary"];
}): StyleProfile {
  return StyleProfileSchema.parse({
    version: 1,
    generatedAt: new Date().toISOString(),
    ownerUserId: input.userId,
    toneTags: ["专业", "清晰", "行动导向"],
    sentencePatterns: ["先给结论再给证据", "数字与时间精确"],
    preferredSectionOrder: ["执行摘要", "关键进展", "风险与待办", "下一步计划"],
    preferredVisualKinds: ["timeline", "gantt", "bar"],
    commonTerms: [],
    forbiddenWords: [],
    anonymizedStyleSample: "",
    observedSampleCount: input.observedSampleCount,
    editSignalSummary: input.editSignalSummary,
  });
}

function buildSystemPrompt(): string {
  return [
    "你是写作风格画像蒸馏器（Hermes-style）。",
    "输入是同一作者最近的若干篇工作文档（已截断的原文），以及该用户在编辑工作台的编辑信号统计。",
    "请输出 JSON，描述这位作者的稳定写作风格画像，使用以下字段：",
    "{",
    '  "toneTags": ["不超过 6 个语气/口吻关键词"],',
    '  "sentencePatterns": ["不超过 6 条典型句式与组织偏好"],',
    '  "preferredSectionOrder": ["按出现频率推断的常用章节顺序"],',
    '  "preferredVisualKinds": ["从 gantt/timeline/line/bar/pie/table/image 中挑出至多 4 项"],',
    '  "commonTerms": ["该作者反复使用的术语，去掉具体姓名/项目代号"],',
    '  "forbiddenWords": ["如发现明显被反复修改/删除的措辞，列出避免词"],',
    '  "anonymizedStyleSample": "≤300 字：去掉所有人名/日期/项目名后的文风示例改写"',
    "}",
    "硬性要求：仅输出严格 JSON；不可输出 Markdown 围栏；不可抄写原文整句到 anonymizedStyleSample。",
  ].join("\n");
}

type RawDocSample = {
  title: string;
  body: string;
};

async function loadRecentUserDocs(input: {
  userId: string;
  hmrsRootToken: string;
  repo: HmrsRepository;
  maxDocs: number;
  maxCharsPerDoc: number;
}): Promise<RawDocSample[]> {
  const importedRoom = await input.repo.ensureFolderPath(
    input.userId,
    input.hmrsRootToken,
    `${HMRS_FOLDER_NAMES.resourcesWing}/${HMRS_FOLDER_NAMES.importedDocsRoom}`,
  );
  const items = await input.repo.listFolderItems(input.userId, importedRoom.token).catch(() => []);
  const folderTokens = items
    .filter((item) => item.type.toLowerCase().includes("folder"))
    .map((item) => item.token);
  const docCandidates: Array<{ token: string; title: string; modifiedTime?: number }> = [];
  for (const folderToken of [importedRoom.token, ...folderTokens]) {
    const docs = await input.repo.listDocsInFolder(input.userId, folderToken).catch(() => []);
    docCandidates.push(...docs);
    if (docCandidates.length >= input.maxDocs * 3) break;
  }
  const sorted = docCandidates
    .sort((a, b) => (b.modifiedTime ?? 0) - (a.modifiedTime ?? 0))
    .slice(0, input.maxDocs);
  const samples: RawDocSample[] = [];
  for (const doc of sorted) {
    try {
      const detail = await toolGateway.viewDocument(doc.token, {
        userId: input.userId,
        preferUserScope: true,
      });
      const body = (detail?.content ?? detail?.summary ?? "").trim();
      if (!body) continue;
      samples.push({
        title: detail?.title ?? doc.title,
        body: body.slice(0, input.maxCharsPerDoc),
      });
    } catch (error) {
      logger.warn("style distill load doc failed", {
        userId: input.userId,
        docToken: doc.token,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return samples;
}

function buildUserPrompt(input: {
  samples: RawDocSample[];
  editSignalSummary: StyleProfile["editSignalSummary"];
}): string {
  return [
    "请基于以下文档样本与编辑信号，蒸馏作者写作风格画像。",
    `editSignalSummary=${JSON.stringify(input.editSignalSummary)}`,
    "samples=[",
    ...input.samples.map((s, idx) =>
      JSON.stringify({ index: idx + 1, title: s.title, body: s.body }),
    ),
    "]",
  ].join("\n");
}

async function callDistillerLlm(input: {
  userId: string;
  samples: RawDocSample[];
  editSignalSummary: StyleProfile["editSignalSummary"];
}): Promise<StyleProfile> {
  const raw = await invokeBailianModel({
    model: env.BAILIAN_MODEL_ORCHESTRATOR,
    systemPrompt: buildSystemPrompt(),
    userPrompt: buildUserPrompt({
      samples: input.samples,
      editSignalSummary: input.editSignalSummary,
    }),
    jsonMode: true,
  });
  const json = extractJsonObject(raw);
  const parsedJson = JSON.parse(json) as Record<string, unknown>;
  const profile = StyleProfileSchema.parse({
    version: 1,
    generatedAt: new Date().toISOString(),
    ownerUserId: input.userId,
    observedSampleCount: input.samples.length,
    editSignalSummary: input.editSignalSummary,
    toneTags: parsedJson.toneTags ?? [],
    sentencePatterns: parsedJson.sentencePatterns ?? [],
    preferredSectionOrder: parsedJson.preferredSectionOrder ?? [],
    preferredVisualKinds: parsedJson.preferredVisualKinds ?? [],
    commonTerms: parsedJson.commonTerms ?? [],
    forbiddenWords: parsedJson.forbiddenWords ?? [],
    anonymizedStyleSample: parsedJson.anonymizedStyleSample ?? "",
  });
  return profile;
}

function renderWritingThoughtMd(profile: StyleProfile): string {
  return [
    `# 写作思路画像（自动蒸馏）`,
    `> 由系统从最近 ${profile.observedSampleCount} 篇工作样本与编辑信号自动总结，请勿手工编辑。`,
    "",
    `## 语气`,
    ...(profile.toneTags.length > 0
      ? profile.toneTags.map((x) => `- ${x}`)
      : ["- 暂无足够样本"]),
    "",
    `## 典型句式与组织`,
    ...(profile.sentencePatterns.length > 0
      ? profile.sentencePatterns.map((x) => `- ${x}`)
      : ["- 暂无足够样本"]),
    "",
    `## 偏好章节顺序`,
    ...(profile.preferredSectionOrder.length > 0
      ? profile.preferredSectionOrder.map((x, i) => `${i + 1}. ${x}`)
      : ["1. 暂无足够样本"]),
    "",
    `## 偏好可视化形式`,
    ...(profile.preferredVisualKinds.length > 0
      ? profile.preferredVisualKinds.map((x) => `- ${x}`)
      : ["- 暂无足够样本"]),
    "",
    `## 编辑信号统计`,
    `- 手动精修次数：${profile.editSignalSummary.manualEditCount}`,
    `- AI 局部改写次数：${profile.editSignalSummary.aiRewriteCount}`,
    `- 高频被编辑章节：${profile.editSignalSummary.frequentlyEditedSections.join("、") || "（无）"}`,
  ].join("\n");
}

const PROFILE_CACHE_TTL_MS = 5 * 60 * 1000;
const profileCache = new Map<string, { value: StyleProfile | null; expiresAt: number }>();

export class StyleDistillationService {
  constructor(private readonly repo: HmrsRepository = new HmrsRepository()) {}

  async distillAndPersist(input: StyleDistillerInput): Promise<StyleDistillerOutput | null> {
    const trigger = input.trigger ?? "refresh";
    const maxDocs = input.maxDocs ?? DEFAULT_MAX_DOCS;
    const maxCharsPerDoc = input.maxCharsPerDoc ?? DEFAULT_MAX_CHARS_PER_DOC;
    const memoryStore = new MemoryStore();
    const memory = memoryStore.get(input.userId);
    const editSignalSummary: StyleProfile["editSignalSummary"] = {
      manualEditCount: memory?.editStats?.manualEditCount ?? 0,
      aiRewriteCount: memory?.editStats?.aiRewriteCount ?? 0,
      frequentlyEditedSections: memory?.editStats?.frequentlyEditedSections ?? [],
    };

    const samples = await loadRecentUserDocs({
      userId: input.userId,
      hmrsRootToken: input.hmrsRootToken,
      repo: this.repo,
      maxDocs,
      maxCharsPerDoc,
    });

    let profile: StyleProfile;
    if (samples.length === 0) {
      profile = fallbackStyleProfile({
        userId: input.userId,
        observedSampleCount: 0,
        editSignalSummary,
      });
      logger.info("[style-distill] no user samples found, using fallback profile", {
        userId: input.userId,
        trigger,
      });
    } else {
      try {
        profile = await callDistillerLlm({
          userId: input.userId,
          samples,
          editSignalSummary,
        });
        logger.info("[style-distill] llm distill success", {
          userId: input.userId,
          trigger,
          observedSampleCount: profile.observedSampleCount,
          toneTagsCount: profile.toneTags.length,
          preferredVisualKinds: profile.preferredVisualKinds,
        });
      } catch (error) {
        logger.warn("[style-distill] llm distill failed, using fallback profile", {
          userId: input.userId,
          trigger,
          error: error instanceof Error ? error.message : String(error),
        });
        profile = fallbackStyleProfile({
          userId: input.userId,
          observedSampleCount: samples.length,
          editSignalSummary,
        });
      }
    }

    const styleFolder = await this.repo.ensureFolderPath(
      input.userId,
      input.hmrsRootToken,
      `${HMRS_FOLDER_NAMES.peopleWing}/${HMRS_FOLDER_NAMES.selfRoom}/${HMRS_FOLDER_NAMES.styleDrawer}`,
    );
    const thoughtFolder = await this.repo.ensureFolderPath(
      input.userId,
      input.hmrsRootToken,
      `${HMRS_FOLDER_NAMES.peopleWing}/${HMRS_FOLDER_NAMES.selfRoom}/${HMRS_FOLDER_NAMES.writingThoughtDrawer}`,
    );
    await this.repo.writeJsonObject(input.userId, styleFolder.token, PROFILE_FILE_NAME, profile);
    await this.repo.writeMarkdownObject(
      input.userId,
      styleFolder.token,
      FALLBACK_STYLE_FILE_NAME,
      [
        `# 风格画像（自动蒸馏摘要）`,
        `> 详细 JSON 见 ${PROFILE_FILE_NAME}；本文件供人工速读。`,
        "",
        ...(profile.toneTags.length > 0
          ? [`- 语气：${profile.toneTags.join("、")}`]
          : ["- 语气：暂无足够样本"]),
        ...(profile.sentencePatterns.length > 0
          ? [`- 句式：${profile.sentencePatterns.join("；")}`]
          : []),
        ...(profile.preferredSectionOrder.length > 0
          ? [`- 章节顺序：${profile.preferredSectionOrder.join(" -> ")}`]
          : []),
        ...(profile.preferredVisualKinds.length > 0
          ? [`- 偏好可视化：${profile.preferredVisualKinds.join("、")}`]
          : []),
      ].join("\n"),
    );
    await this.repo.writeMarkdownObject(
      input.userId,
      thoughtFolder.token,
      THOUGHT_FILE_NAME,
      renderWritingThoughtMd(profile),
    );

    profileCache.set(input.userId, {
      value: profile,
      expiresAt: Date.now() + PROFILE_CACHE_TTL_MS,
    });

    return {
      profile,
      observedDocs: samples.length,
      trigger,
    };
  }

  async readProfile(input: { userId: string; hmrsRootToken: string }): Promise<StyleProfile | null> {
    const styleFolder = await this.repo.ensureFolderPath(
      input.userId,
      input.hmrsRootToken,
      `${HMRS_FOLDER_NAMES.peopleWing}/${HMRS_FOLDER_NAMES.selfRoom}/${HMRS_FOLDER_NAMES.styleDrawer}`,
    );
    const json = await this.repo.readJsonObjectByName<unknown>(
      input.userId,
      styleFolder.token,
      PROFILE_FILE_NAME,
    );
    if (!json) return null;
    const parsed = StyleProfileSchema.safeParse(json);
    return parsed.success ? parsed.data : null;
  }
}

/**
 * 软读取：用于 Planner/Writer 注入；读取失败或超时不影响主链路。
 * 命中缓存时立即返回，未命中则尝试读 HMRS（若失败返回 null）。
 */
export async function readStyleProfileSoft(input: { userId: string }): Promise<StyleProfile | null> {
  const now = Date.now();
  const cached = profileCache.get(input.userId);
  if (cached && cached.expiresAt > now) return cached.value;
  try {
    const { HmrsRefreshService } = await import("./hmrsRefreshService.js");
    const status = await new HmrsRefreshService().getRefreshStatus({ userId: input.userId });
    if (!status.rootFolderToken) {
      profileCache.set(input.userId, { value: null, expiresAt: now + PROFILE_CACHE_TTL_MS });
      return null;
    }
    const profile = await getStyleDistillationService().readProfile({
      userId: input.userId,
      hmrsRootToken: status.rootFolderToken,
    });
    profileCache.set(input.userId, { value: profile, expiresAt: now + PROFILE_CACHE_TTL_MS });
    return profile;
  } catch (error) {
    logger.warn("readStyleProfileSoft failed", {
      userId: input.userId,
      error: error instanceof Error ? error.message : String(error),
    });
    profileCache.set(input.userId, { value: null, expiresAt: now + PROFILE_CACHE_TTL_MS });
    return null;
  }
}

export function invalidateStyleProfileCache(userId: string): void {
  profileCache.delete(userId);
}

let cachedService: StyleDistillationService | null = null;

export function getStyleDistillationService(): StyleDistillationService {
  if (!cachedService) cachedService = new StyleDistillationService();
  return cachedService;
}
