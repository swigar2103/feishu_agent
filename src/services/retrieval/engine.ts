import fs from "node:fs";
import path from "node:path";
import type { RetrievalContext, Skill, UserRequest } from "../../schemas/index.js";
import { SkillSchema } from "../../schemas/index.js";
import type { FeishuClient } from "../feishu/client.js";
import type { FeishuConfig } from "../feishu/config.js";
import { getMemoryStore } from "../memory/store.js";
import {
  createFeishuAdapter,
  FeishuRealAdapter,
  type FeishuAdapter,
} from "./feishuAdapter.js";
import { parseSkillDocFromMd, type SkillDoc } from "./mdParser.js";
import { SkillRanker, type RankScore } from "./skillRanker.js";

export class RetrievalEngine {
  private readonly adapter: FeishuAdapter;
  private readonly feishuConfig: FeishuConfig;
  private readonly feishuDegraded: boolean;
  private readonly feishuDegradationReason?: string;
  private skillDocs: SkillDoc[];
  private readonly skillsRoot = path.resolve(process.cwd(), "SKILLS");
  private readonly legacySkillsRoot = path.resolve(process.cwd(), "src", "skills");
  private readonly ranker = new SkillRanker();
  private rankerInitPromise: Promise<void> | null = null;
  private readonly memoryStore = getMemoryStore();

  constructor() {
    const created = createFeishuAdapter();
    this.adapter = created.adapter;
    this.feishuConfig = created.config;
    this.feishuDegraded = created.degraded;
    this.feishuDegradationReason = created.degradationReason;

    // 启动时对 real 模式做一次异步健康检查，失败只记录、不阻塞构造
    if (this.adapter instanceof FeishuRealAdapter) {
      void this.adapter.healthCheck().then((result) => {
        if (!result.healthy) {
          console.warn(`[RetrievalEngine] 飞书健康检查失败: ${result.message}`);
        }
      });
    }

    try {
      this.skillDocs = this.loadSkillDocs();
    } catch (error) {
      console.warn("[RetrievalEngine] SKILLS 读取失败，使用空技能集", error);
      this.skillDocs = [];
    }
  }

  /** 供其他模块（如 Feishu 通知节点）复用鉴权过的 client；mock 模式下返回 null */
  getFeishuClient(): FeishuClient | null {
    if (this.adapter instanceof FeishuRealAdapter) {
      return this.adapter.internalClient();
    }
    return null;
  }

  /** 给 /healthz 用的诊断快照（不含凭证） */
  getFeishuDiagnostic(): {
    mode: "mock" | "real";
    domain: string;
    degraded: boolean;
    degradationReason?: string;
    resolvedReason: string;
    requestedMode: "auto" | "true" | "false";
    hasAppId: boolean;
    hasAppSecret: boolean;
    health?: { healthy: boolean; at: string; message: string };
    token?: { cached: boolean; expiresInMs: number | null };
  } {
    const base = {
      mode: this.adapter.mode,
      domain: this.feishuConfig.domain,
      degraded: this.feishuDegraded,
      degradationReason: this.feishuDegradationReason,
      resolvedReason: this.feishuConfig.diagnostic.resolvedReason,
      requestedMode: this.feishuConfig.diagnostic.requestedMode,
      hasAppId: this.feishuConfig.diagnostic.hasAppId,
      hasAppSecret: this.feishuConfig.diagnostic.hasAppSecret,
    };
    if (this.adapter instanceof FeishuRealAdapter) {
      return {
        ...base,
        health: this.adapter.getLastHealth(),
        token: this.adapter.tokenManager.describe(),
      };
    }
    return base;
  }

  private ensureRankerReady(): Promise<void> {
    if (!this.rankerInitPromise) {
      this.rankerInitPromise = this.ranker.init(this.skillDocs);
    }
    return this.rankerInitPromise;
  }

  private collectSkillFiles(rootAbs: string): string[] {
    if (!fs.existsSync(rootAbs)) return [];
    const entries = fs.readdirSync(rootAbs, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      const abs = path.join(rootAbs, entry.name);
      if (entry.isDirectory()) {
        files.push(...this.collectSkillFiles(abs));
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        files.push(path.relative(process.cwd(), abs));
      }
    }
    return files;
  }

  private listSkillFiles(): string[] {
    const primary = this.collectSkillFiles(this.skillsRoot);
    const legacy = this.collectSkillFiles(this.legacySkillsRoot);
    return Array.from(new Set([...legacy, ...primary]));
  }

  private loadSkillDocs(): SkillDoc[] {
    const files = this.listSkillFiles();
    const docs: SkillDoc[] = [];

    for (const file of files) {
      try {
        const doc = parseSkillDocFromMd(file);
        const parsedSkill = SkillSchema.parse(doc.skill);
        docs.push({
          ...doc,
          skill: parsedSkill,
        });
      } catch (error) {
        console.warn(`[RetrievalEngine] 跳过无效技能文件: ${file}`, error);
      }
    }
    return docs;
  }

  private buildFallbackSkill(request: UserRequest): Skill {
    return {
      skillId: "skill-fallback-generic",
      name: "通用报告技能（兜底）",
      industry: request.industry ?? "通用",
      reportType: request.reportType ?? "通用报告",
      requiredInputs: ["统计周期", "关键指标", "重点事项"],
      sections: ["执行摘要", "关键分析", "行动建议"],
      styleRules: ["结论先行", "表达简洁", "尽量量化"],
      chartRules: ["趋势用折线图", "对比用柱状图"],
      terminology: ["关键指标", "同比", "环比"],
    };
  }

  private async pickBestSkillDoc(request: UserRequest): Promise<{
    doc: SkillDoc | null;
    rank: RankScore | null;
  }> {
    if (this.skillDocs.length === 0) return { doc: null, rank: null };

    await this.ensureRankerReady();
    const top = await this.ranker.pickBest(request);
    if (top && top.score > 0) {
      return { doc: top.doc, rank: top };
    }

    // ranker 打分全是 0（既没语义信号也没规则信号），退回首个 skill 保证流程可跑
    return { doc: this.skillDocs[0] ?? null, rank: top };
  }

  async getContextForReport(request: UserRequest): Promise<RetrievalContext> {
    const { doc: matchedSkillDoc, rank } = await this.pickBestSkillDoc(request);
    const matchedSkill = matchedSkillDoc?.skill ?? this.buildFallbackSkill(request);

    // Phase 3：从 MemoryStore 取最新持久化的 userMemory；
    // 若该用户从未落盘，store 会自动从 memories.md 里的 seed 初始化。
    const persistedMemory = this.memoryStore.load(request.userId);
    const userMemory = {
      preferredTone: persistedMemory.preferredTone ?? "Professional",
      preferredStructure: persistedMemory.preferredStructure ?? [],
      commonTerms: persistedMemory.commonTerms ?? [],
      styleNotes: persistedMemory.styleNotes ?? [],
    };

    const retrievedContext = await this.adapter.searchEverything(request.prompt);
    const personalKnowledgeContext = request.personalKnowledge.map((content, idx) => ({
      sourceId: `pk_${idx + 1}`,
      sourceType: "history" as const,
      content,
    }));
    const historyDocsContext = request.historyDocs.map((content, idx) => ({
      sourceId: `history_doc_${idx + 1}`,
      sourceType: "doc" as const,
      content,
    }));
    const imContactsContext = request.imContacts.map((contact, idx) => ({
      sourceId: `im_contact_${idx + 1}`,
      sourceType: "im" as const,
      content: `联系人: ${contact.name} (${contact.id})${contact.role ? `, 角色: ${contact.role}` : ""}`,
    }));
    const calendarPlaceholder = {
      sourceId: "calendar_1",
      sourceType: "calendar" as const,
      content: "日历占位：待接入飞书日历 API 后补充会议纪要与里程碑。",
    };
    const externalPlaceholder = {
      sourceId: "external_1",
      sourceType: "external" as const,
      content: "外部检索占位：待接入搜索/行业数据库后补充外部证据。",
    };
    const projectContext = [
      ...retrievedContext,
      ...personalKnowledgeContext,
      ...historyDocsContext,
      ...imContactsContext,
      calendarPlaceholder,
      externalPlaceholder,
    ];
    const skillGuidanceHints = (matchedSkillDoc?.guidance ?? []).map(
      (line) => `SKILL_GUIDE: ${line}`,
    );

    return {
      matchedSkill,
      userMemory: {
        preferredTone: userMemory.preferredTone,
        preferredStructure: userMemory.preferredStructure,
        commonTerms: userMemory.commonTerms,
        styleNotes: userMemory.styleNotes,
      },
      projectContext,
      glossary: matchedSkill.terminology,
      styleHints: [
        `SKILL_SOURCE: ${matchedSkillDoc?.sourcePath ?? "fallback"}`,
        ...(rank
          ? [
              `SKILL_RANK: score=${rank.score.toFixed(3)} semantic=${rank.breakdown.semantic.toFixed(3)} reportType=${rank.breakdown.reportType.toFixed(3)} industry=${rank.breakdown.industry.toFixed(3)} keyword=${rank.breakdown.keyword.toFixed(3)}`,
            ]
          : []),
        ...(matchedSkillDoc?.meta.description
          ? [`SKILL_DESC: ${matchedSkillDoc.meta.description}`]
          : []),
        ...skillGuidanceHints,
        ...(request.personalKnowledge.length > 0
          ? ["PERSONAL_MEMORY: 已注入用户个人知识库内容"]
          : []),
        ...(request.historyDocs.length > 0
          ? ["PROJECT_HISTORY: 已注入项目历史文档内容"]
          : []),
        ...(request.imContacts.length > 0
          ? [`IM_CONTACTS: 可追问联系人数量=${request.imContacts.length}`]
          : []),
        ...(matchedSkill.styleRules || []),
        ...(userMemory.styleNotes || []),
      ],
    };
  }
}