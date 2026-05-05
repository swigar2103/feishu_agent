import fs from "node:fs";
import path from "node:path";
import type { RetrievalContext, Skill, UserRequest } from "../../schemas/index.js";
import { SkillSchema } from "../../schemas/index.js";
import { parseJsonFromMd, parseSkillDocFromMd, type SkillDoc } from "./mdParser.js";
import { toolGateway } from "../toolGateway/gateway.js";

export class RetrievalEngine {
  private referenceSkillDocs: SkillDoc[];
  private anchorSkillDocs: SkillDoc[];
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
  ): SkillDoc | null {
    if (docs.length === 0) return null;

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

  private pickBestSkillDoc(request: UserRequest): {
    doc: SkillDoc | null;
    source: "reference" | "anchor" | "none";
  } {
    const referenceMatched = this.pickBestSkillDocFrom(
      this.referenceSkillDocs,
      request,
    );
    if (referenceMatched) {
      return { doc: referenceMatched, source: "reference" };
    }

    const anchorMatched = this.pickBestSkillDocFrom(this.anchorSkillDocs, request);
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

  async getContextForReport(request: UserRequest): Promise<RetrievalContext> {
    const matched = this.pickBestSkillDoc(request);
    const matchedSkillDoc = matched.doc;
    const matchedSkill = matchedSkillDoc?.skill ?? this.buildFallbackSkill(request);

    const memoryData = this.memories[request.userId];
    const userMemory = memoryData || {
      preferredTone: "Professional",
      preferredStructure: [],
      commonTerms: [],
      styleNotes: [],
    };

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
      ],
    };
  }
}