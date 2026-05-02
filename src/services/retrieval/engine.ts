import fs from "node:fs";
import path from "node:path";
import type {
  RetrievalContext,
  Skill,
  TaskPlan,
  UserRequest,
} from "../../schemas/index.js";
import { SkillSchema } from "../../schemas/index.js";
import { env } from "../../config/env.js";
import { taskContextPackToProjectSlices } from "../../resource_pool/context_bridge.js";
import type { ResourceDataAdapter } from "../../resource_pool/feishu/adapterTypes.js";
import { FeishuBackedResourceDataAdapter } from "../../resource_pool/feishu/feishuBackedAdapter.js";
import { MockResourceDataAdapter } from "../../resource_pool/feishu/mockResourceAdapter.js";
import { buildHybridResourcePoolFromFeishuFolder } from "../../resource_pool/feishuHybridPool.js";
import { hydrateTaskContext } from "../../resource_pool/hydrator.js";
import { ResourcePoolManager } from "../../resource_pool/manager.js";
import { runResourceScreening } from "../../resource_pool/screening.js";
import { parseJsonFromMd, parseSkillDocFromMd, type SkillDoc } from "./mdParser.js";

export class RetrievalEngine {
  private resourcePool = ResourcePoolManager.fromMockFiles();
  private readonly mockFeishuData = new MockResourceDataAdapter();
  private skillDocs: SkillDoc[];
  private memories: Record<string, RetrievalContext["userMemory"]>;
  private readonly skillsRoot = path.resolve(process.cwd(), "SKILLS");
  private readonly legacySkillsRoot = path.resolve(process.cwd(), "src", "skills");

  constructor() {
    try {
      this.skillDocs = this.loadSkillDocs();
    } catch (error) {
      console.warn("[RetrievalEngine] SKILLS 读取失败，使用空技能集", error);
      this.skillDocs = [];
    }

    try {
      this.memories = parseJsonFromMd<Record<string, RetrievalContext["userMemory"]>>(
        "src/data/memories.md",
      );
    } catch (error) {
      console.warn("[RetrievalEngine] memories.md 读取失败，使用空记忆集", error);
      this.memories = {};
    }
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

  private pickBestSkillDoc(request: UserRequest): SkillDoc | null {
    if (this.skillDocs.length === 0) return null;

    const reportType = (request.reportType ?? "").toLowerCase().trim();
    const industry = (request.industry ?? "").toLowerCase().trim();

    const exact = this.skillDocs.find((doc) => {
      return (
        doc.skill.reportType.toLowerCase() === reportType &&
        doc.skill.industry.toLowerCase() === industry
      );
    });
    if (exact) return exact;

    const reportMatched = this.skillDocs.find(
      (doc) => doc.skill.reportType.toLowerCase() === reportType,
    );
    if (reportMatched) return reportMatched;

    const industryMatched = this.skillDocs.find(
      (doc) => doc.skill.industry.toLowerCase() === industry,
    );
    if (industryMatched) return industryMatched;

    return this.skillDocs[0] ?? null;
  }

  /** LangGraph 完成记忆/反馈后可将 B4 `applyResourceUsage` 的产物挂回检索引擎实例 */
  replaceResourcePoolManager(nextPool: ResourcePoolManager): void {
    this.resourcePool = nextPool;
  }

  async getContextForReport(request: UserRequest, taskPlan?: TaskPlan | null): Promise<RetrievalContext> {
    const matchedSkillDoc = this.pickBestSkillDoc(request);
    const matchedSkill = matchedSkillDoc?.skill ?? this.buildFallbackSkill(request);

    const memoryData = this.memories[request.userId];
    const userMemory = memoryData || {
      preferredTone: "Professional",
      preferredStructure: [],
      commonTerms: [],
      styleNotes: [],
    };

    let poolMgr: ResourcePoolManager = this.resourcePool;
    let adapter: ResourceDataAdapter = this.mockFeishuData;

    if (
      env.FEISHU_RESOURCE_POOL_SOURCE === "real" &&
      env.FEISHU_RESOURCE_FOLDER_TOKEN.trim().length > 0 &&
      env.FEISHU_APP_ID.trim().length > 0 &&
      env.FEISHU_APP_SECRET.trim().length > 0
    ) {
      try {
        poolMgr = await buildHybridResourcePoolFromFeishuFolder({
          folderToken: env.FEISHU_RESOURCE_FOLDER_TOKEN.trim(),
          maxDocx: env.FEISHU_RESOURCE_MAX_DOCX,
        });
        adapter = new FeishuBackedResourceDataAdapter();
      } catch (error) {
        console.warn("[RetrievalEngine] 真飞书资源池不可用，回退本地 mock。", error);
      }
    }

    const screening = await runResourceScreening({
      manager: poolMgr,
      userRequest: request,
      taskPlan: taskPlan ?? null,
    });

    const pack = await hydrateTaskContext({
      manager: poolMgr,
      screening,
      adapter,
      taskPlan: taskPlan ?? null,
      attachSampleImThreadId: null,
    });

    const poolSlices = taskContextPackToProjectSlices(pack);
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
      ...poolSlices,
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
        `B2_SCREENING(llm_fallback=${screening.llmFallbackUsed};kw=${screening.trace.keywordSignals.length})`,
        `B3_POOL(slices=${poolSlices.length};docs=${pack.documents.length};contacts=${pack.contacts.length};projects=${pack.projects.length};personas=${pack.personas.length})`,
        `RESOURCE_POOL(source=${env.FEISHU_RESOURCE_POOL_SOURCE};pool_docs=${poolMgr.getPool().documents.length})`,
      ],
    };
  }
}