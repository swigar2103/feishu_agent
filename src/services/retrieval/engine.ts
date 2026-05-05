import fs from "node:fs";
import path from "node:path";
import {
  SkillSchema,
  RetrievalContextSchema,
  type RetrievalContext,
  type Skill,
  type TaskPlan,
  type UserRequest,
} from "../../schemas/index.js";
import { env } from "../../config/env.js";
import {
  TemplateDistillationSchema,
} from "../../schemas/templateProfile.js";
import { distillTemplateProfilesFromPack } from "../../llm/templateDistiller.js";
import { taskContextPackToProjectSlices } from "../../resource_pool/context_bridge.js";
import type { ResourceDataAdapter } from "../../resource_pool/feishu/adapterTypes.js";
import { FeishuBackedResourceDataAdapter } from "../../resource_pool/feishu/feishuBackedAdapter.js";
import { MockResourceDataAdapter } from "../../resource_pool/feishu/mockResourceAdapter.js";
import { buildHybridResourcePoolFromFeishuFolder } from "../../resource_pool/feishuHybridPool.js";
import { hydrateTaskContext } from "../../resource_pool/hydrator.js";
import { ResourcePoolManager } from "../../resource_pool/manager.js";
import { runResourceScreening } from "../../resource_pool/screening.js";
import { parseJsonFromMd, parseSkillDocFromMd, type SkillDoc } from "./mdParser.js";
import { toolGateway } from "../toolGateway/gateway.js";

export class RetrievalEngine {
  private referenceSkillDocs: SkillDoc[];
  private anchorSkillDocs: SkillDoc[];
  private resourcePool = ResourcePoolManager.fromMockFiles();
  private readonly mockFeishuData = new MockResourceDataAdapter();
  private memories: Record<string, RetrievalContext["userMemory"]>;
  private readonly referenceSkillsRoot = path.resolve(process.cwd(), "src", "skills");
  private readonly anchorSkillsRoot = path.resolve(process.cwd(), "SKILLS");

  constructor() {
    try {
      this.referenceSkillDocs = this.loadSkillDocs(this.referenceSkillsRoot);
      this.anchorSkillDocs = this.loadSkillDocs(this.anchorSkillsRoot);
    } catch (error) {
      console.warn("[RetrievalEngine] 技能文件读取失败，使用空技能集", error);
      this.referenceSkillDocs = [];
      this.anchorSkillDocs = [];
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

  private loadSkillDocs(rootAbs: string): SkillDoc[] {
    const files = this.collectSkillFiles(rootAbs);
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

  private pickBestSkillDocFrom(
    docs: SkillDoc[],
    request: UserRequest,
    taskIntent?: string | null,
  ): SkillDoc | null {
    if (docs.length === 0) return null;

    const intent = (taskIntent ?? "").toLowerCase();
    if (intent.includes("weekly")) {
      const weekly = docs.find(
        (doc) =>
          doc.skill.skillId.toLowerCase().includes("weekly") ||
          doc.skill.reportType.includes("周报") ||
          doc.skill.name.includes("周报"),
      );
      if (weekly) return weekly;
    }

    const reportType = (request.reportType ?? "").toLowerCase().trim();
    const industry = (request.industry ?? "").toLowerCase().trim();

    const exact = docs.find((doc) => {
      return (
        doc.skill.reportType.toLowerCase() === reportType &&
        doc.skill.industry.toLowerCase() === industry
      );
    });
    if (exact) return exact;

    const reportMatched = docs.find(
      (doc) => doc.skill.reportType.toLowerCase() === reportType,
    );
    if (reportMatched) return reportMatched;

    const industryMatched = docs.find(
      (doc) => doc.skill.industry.toLowerCase() === industry,
    );
    if (industryMatched) return industryMatched;

    return docs[0] ?? null;
  }

  private pickBestSkillDoc(
    request: UserRequest,
    taskIntent?: string | null,
  ): {
    doc: SkillDoc | null;
    source: "reference" | "anchor" | "none";
  } {
    const referenceMatched = this.pickBestSkillDocFrom(
      this.referenceSkillDocs,
      request,
      taskIntent,
    );
    if (referenceMatched) {
      return { doc: referenceMatched, source: "reference" };
    }

    const anchorMatched = this.pickBestSkillDocFrom(
      this.anchorSkillDocs,
      request,
      taskIntent,
    );
    if (anchorMatched) {
      return { doc: anchorMatched, source: "anchor" };
    }

    return { doc: null, source: "none" };
  }

  private async fetchGatewayContext(query: string): Promise<RetrievalContext["projectContext"]> {
    const [docs, users] = await Promise.all([
      toolGateway.searchDocuments(query).catch(() => []),
      toolGateway.searchUsers(query).catch(() => []),
    ]);
    const docContexts = docs.slice(0, 5).map((doc) => ({
      sourceId: `gateway_doc_${doc.id}`,
      sourceType: "doc" as const,
      content: doc.content ?? doc.summary ?? doc.title,
    }));
    const userContexts = users.slice(0, 3).map((user) => ({
      sourceId: `gateway_user_${user.id}`,
      sourceType: "im" as const,
      content: `联系人: ${user.name}${user.role ? `, 角色: ${user.role}` : ""}${user.department ? `, 部门: ${user.department}` : ""}`,
    }));
    if (docContexts.length + userContexts.length > 0) {
      return [...docContexts, ...userContexts];
    }
    const fallback = parseJsonFromMd<Array<{ sourceId: string; sourceType: "message" | "doc" | "table"; content: string }>>(
      "src/data/assets.md",
    );
    return fallback.slice(0, 3).map((item) => ({
      sourceId: item.sourceId,
      sourceType: item.sourceType,
      content: item.content,
    }));
  }

  /** LangGraph 完成记忆/反馈后可将 B4 `applyResourceUsage` 的产物挂回检索引擎实例 */
  replaceResourcePoolManager(nextPool: ResourcePoolManager): void {
    this.resourcePool = nextPool;
  }

  async getContextForReport(
    request: UserRequest,
    taskPlan?: TaskPlan | null,
    opts?: { taskIntent?: string | null },
  ): Promise<RetrievalContext> {
    const matched = this.pickBestSkillDoc(request, opts?.taskIntent ?? null);
    const matchedSkillDoc = matched.doc;
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

    const ts = screening.trace.threeStageDocs;
    const threeStageStr = ts
      ? `afterFolderPath=${ts.afterFolderPath};afterFileTitle=${ts.afterFileTitle};afterContentSummary=${ts.afterContentSummary}`
      : "skipped(no_docs_or_trace)";
    const docPickLines = screening.candidates
      .filter((c) => c.kind === "document")
      .map((c) => {
        const d = poolMgr.documentById(c.id);
        const pathSeg = d ? (d.folderPathSegments ?? []).join("/") : "";
        const title = d?.title ?? c.id;
        return `id=${c.id}|path=${pathSeg}|title=${title}|score=${c.coarseScore.toFixed(4)}`;
      });
    const kwPreview = screening.trace.keywordSignals.slice(0, 10).join("|");

    const pack = await hydrateTaskContext({
      manager: poolMgr,
      screening,
      adapter,
      taskPlan: taskPlan ?? null,
      attachSampleImThreadId: null,
    });

    const profilesByResourceId = await distillTemplateProfilesFromPack(pack.documents);
    const templateDistillation =
      Object.keys(profilesByResourceId).length > 0
        ? TemplateDistillationSchema.parse({ profilesByResourceId })
        : undefined;

    const poolSlices = taskContextPackToProjectSlices(
      pack,
      templateDistillation ? profilesByResourceId : undefined,
    );
    const retrievedContext = await this.fetchGatewayContext(request.prompt);
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

    return RetrievalContextSchema.parse({
      matchedSkill,
      userMemory: {
        preferredTone: userMemory.preferredTone,
        preferredStructure: userMemory.preferredStructure,
        commonTerms: userMemory.commonTerms,
        styleNotes: userMemory.styleNotes,
      },
      projectContext,
      glossary: matchedSkill.terminology,
      templateDistillation,
      styleHints: [
        `SKILL_SOURCE: ${matchedSkillDoc?.sourcePath ?? "fallback"}`,
        `SKILL_SOURCE_TYPE: ${matched.source}`,
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
        `B2_THREE_STAGE(${threeStageStr})`,
        docPickLines.length > 0
          ? `B2_SELECTED_DOCS: ${docPickLines.join(" :: ")}`
          : "B2_SELECTED_DOCS: (none)",
        `B2_SCREENING(llm_fallback=${screening.llmFallbackUsed};signals_preview=${kwPreview || "(empty)"};signal_count=${screening.trace.keywordSignals.length})`,
        `B3_POOL(slices=${poolSlices.length};docs=${pack.documents.length};contacts=${pack.contacts.length};projects=${pack.projects.length};personas=${pack.personas.length})`,
        `RESOURCE_POOL(source=${env.FEISHU_RESOURCE_POOL_SOURCE};pool_docs=${poolMgr.getPool().documents.length})`,
      ],
    });
  }
}