import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { logger } from "../../shared/logger.js";
import type { Draft } from "../../schemas/agentContracts.js";
import { toolGateway } from "../toolGateway/gateway.js";

export type RenderedArtifactKind = "image" | "whiteboard" | "sheet_chart";

export type RenderedArtifact = {
  slotId: string;
  sectionHeading: string;
  kind: RenderedArtifactKind;
  /** 当 kind=image：飞书 mediaToken；当 kind=whiteboard/sheet_chart：被引用对象的 token */
  embedToken: string;
  url?: string;
  caption?: string;
  fallbackMarkdown?: string;
  source?: "mcp" | "lark_cli" | "openapi" | "local_fallback";
};

export type RenderInput = {
  userId: string;
  documentId?: string;
  draft: Draft;
  sourceLinks?: string[];
};

export type RenderOutput = {
  artifacts: RenderedArtifact[];
  warnings: string[];
};

function buildGanttPlantUml(slot: Draft["ganttSlots"][number]): string | null {
  const data = slot.data ?? [];
  if (!Array.isArray(data) || data.length === 0) return null;
  const lines: string[] = [];
  lines.push("@startgantt");
  lines.push(`title ${slot.task}`);
  for (const item of data) {
    const safeTask = item.task.replace(/\[/g, "(").replace(/\]/g, ")");
    lines.push(`[${safeTask}] starts ${item.start} and ends ${item.end}`);
    if (item.owner) {
      lines.push(`note right of [${safeTask}] : ${item.owner}`);
    }
  }
  lines.push("@endgantt");
  return lines.join("\n");
}

function buildGanttMermaid(slot: Draft["ganttSlots"][number]): string | null {
  const data = slot.data ?? [];
  if (!Array.isArray(data) || data.length === 0) return null;
  const lines: string[] = ["gantt", `    title ${slot.task}`, "    dateFormat  YYYY-MM-DD"];
  data.forEach((item, idx) => {
    lines.push(`    section ${item.owner ?? "任务"}`);
    const safeTask = item.task.replace(/:/g, "-");
    lines.push(`    ${safeTask}    :a${idx + 1}, ${item.start}, ${item.end}`);
  });
  return lines.join("\n");
}

function buildTimelineMermaid(slot: Draft["timelineSlots"][number]): string | null {
  const data = slot.data ?? [];
  if (!Array.isArray(data) || data.length === 0) return null;
  const normalizeWhen = (raw: string): string => {
    const t = raw.trim();
    // Mermaid timeline 对含时区冒号（如 +08:00）兼容较差，优先抽取 YYYY-MM-DD。
    const dateLike = t.match(/\d{4}-\d{1,2}-\d{1,2}/)?.[0];
    if (dateLike) return dateLike;
    return t.replace(/[:]/g, "-");
  };
  const lines: string[] = ["timeline", `    title ${slot.title}`];
  for (const item of data) {
    const safeLabel = item.label.replace(/:/g, "-");
    const safeWhen = normalizeWhen(item.when);
    const safeNote = item.note?.replace(/:/g, "-");
    lines.push(`    ${safeWhen} : ${safeLabel}${safeNote ? ` - ${safeNote}` : ""}`);
  }
  return lines.join("\n");
}

function buildChartMermaid(slot: Draft["chartSlots"][number]): string | null {
  const data = slot.data;
  if (!data || !Array.isArray(data.series) || data.series.length === 0) return null;
  const kind = slot.dataSemantic?.kind ?? "bar";
  if (kind === "pie") {
    const lines: string[] = ["pie", `    title ${slot.title}`];
    const series = data.series[0];
    if (!series) return null;
    series.values.forEach((value, idx) => {
      const cat = data.categories[idx] ?? `项${idx + 1}`;
      lines.push(`    "${cat}" : ${value}`);
    });
    return lines.join("\n");
  }
  if (kind === "line" || kind === "bar") {
    const lines: string[] = ["xychart-beta", `    title "${slot.title}"`];
    if (data.categories.length > 0) {
      lines.push(`    x-axis [${data.categories.map((c) => `"${c}"`).join(", ")}]`);
    }
    for (const series of data.series) {
      const values = series.values.join(", ");
      lines.push(`    ${kind === "bar" ? "bar" : "line"} [${values}]`);
    }
    return lines.join("\n");
  }
  return null;
}

type MermaidExecResult = { ok: boolean; png?: Uint8Array; stderr?: string };

function buildProvenanceCaption(base: string | undefined, sourceLinks?: string[]): string | undefined {
  const title = (base ?? "").trim();
  const links = [...new Set((sourceLinks ?? []).map((s) => s.trim()).filter(Boolean))].slice(0, 2);
  if (links.length === 0) return title || undefined;
  const provenance = `来源：${links.join(" ; ")}`;
  const out = title ? `${title} | ${provenance}` : provenance;
  return out.length <= 380 ? out : `${out.slice(0, 360)}...`;
}

/**
 * 优先使用项目本地 node_modules/.bin/mmdc，避免 npx 触发联网下载、卡住主链路。
 * 找不到本地二进制再回退 npx mmdc。
 */
function resolveMermaidCliCommand(): { cmd: string; args: string[] } | null {
  const localBin = path.resolve(
    process.cwd(),
    "node_modules",
    ".bin",
    process.platform === "win32" ? "mmdc.cmd" : "mmdc",
  );
  if (fs.existsSync(localBin)) {
    return { cmd: localBin, args: [] };
  }
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  return { cmd: npx, args: ["mmdc"] };
}

let mermaidCliAvailable: boolean | null = null;
function isMermaidCliAvailable(): boolean {
  if (mermaidCliAvailable !== null) return mermaidCliAvailable;
  const cli = resolveMermaidCliCommand();
  if (!cli) {
    mermaidCliAvailable = false;
    return false;
  }
  try {
    const result = spawnSync(cli.cmd, [...cli.args, "--version"], {
      encoding: "utf8",
      // Windows 下 .cmd 不能以 shell:false 直接执行（会 EINVAL），需启用 shell。
      shell: process.platform === "win32",
      timeout: 10_000,
    });
    mermaidCliAvailable = result.status === 0;
    if (!mermaidCliAvailable) {
      logger.warn("mermaid cli probe failed", {
        cmd: cli.cmd,
        stderr: result.stderr?.slice(0, 200),
      });
    }
    return mermaidCliAvailable;
  } catch (error) {
    mermaidCliAvailable = false;
    logger.warn("mermaid cli probe threw", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

function renderMermaidToPng(diagram: string): MermaidExecResult {
  if (!isMermaidCliAvailable()) {
    return { ok: false, stderr: "mmdc unavailable (install @mermaid-js/mermaid-cli)" };
  }
  const cli = resolveMermaidCliCommand();
  if (!cli) return { ok: false, stderr: "mmdc resolver returned null" };
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-mermaid-"));
  const inputPath = path.join(tmpDir, "diagram.mmd");
  const outputPath = path.join(tmpDir, "diagram.png");
  try {
    fs.writeFileSync(inputPath, diagram, "utf-8");
    const result = spawnSync(
      cli.cmd,
      [...cli.args, "-i", inputPath, "-o", outputPath, "-b", "white"],
      {
        encoding: "utf8",
        // 同上：确保 win32 能正常调用 mmdc.cmd 产图。
        shell: process.platform === "win32",
        timeout: 45_000,
      },
    );
    if (result.status !== 0) {
      const stderr = (result.stderr ?? "").slice(0, 600) || (result.stdout ?? "").slice(0, 600);
      logger.warn("mermaid render failed", { stderr });
      return { ok: false, stderr };
    }
    if (!fs.existsSync(outputPath)) {
      return { ok: false, stderr: "mmdc exit=0 but output png missing" };
    }
    return { ok: true, png: new Uint8Array(fs.readFileSync(outputPath)) };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

async function tryWhiteboardForGantt(input: {
  userId: string;
  slot: Draft["ganttSlots"][number];
  sourceLinks?: string[];
}): Promise<RenderedArtifact | null> {
  const plantuml = buildGanttPlantUml(input.slot);
  if (!plantuml) return null;
  try {
    const result = await toolGateway.createWhiteboard(
      {
        title: `${input.slot.task}-甘特`,
        syntax: "plantuml",
        body: plantuml,
      },
      { userId: input.userId, preferUserScope: true },
    );
    return {
      slotId: input.slot.slotId,
      sectionHeading: input.slot.task,
      kind: "whiteboard",
      embedToken: result.whiteboardToken,
      url: result.url,
      caption: buildProvenanceCaption(input.slot.task, input.sourceLinks),
      source: result.source ?? "lark_cli",
    };
  } catch (error) {
    logger.warn("whiteboard render skipped", {
      slotId: input.slot.slotId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function tryImageFallback(input: {
  userId: string;
  documentId?: string;
  slotId: string;
  sectionHeading: string;
  diagram: string;
  caption?: string;
}): Promise<{ artifact: RenderedArtifact | null; warning?: string }> {
  const rendered = renderMermaidToPng(input.diagram);
  if (!rendered.ok || !rendered.png) {
    return { artifact: null, warning: `mermaid:${rendered.stderr ?? "unknown"}` };
  }
  try {
    const upload = await toolGateway.uploadImageMedia(
      {
        buffer: rendered.png,
        fileName: `${input.slotId}.png`,
        parent: input.documentId
          ? { type: "docx_image", documentId: input.documentId }
          : { type: "drive" },
        mimeType: "image/png",
      },
      { userId: input.userId, preferUserScope: true },
    );
    return {
      artifact: {
        slotId: input.slotId,
        sectionHeading: input.sectionHeading,
        kind: "image",
        embedToken: upload.mediaToken,
        url: upload.url,
        caption: input.caption,
        source: upload.source ?? "openapi",
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("image upload failed for slot", {
      slotId: input.slotId,
      error: message,
    });
    return { artifact: null, warning: `upload:${message}` };
  }
}

export async function renderDraftArtifacts(input: RenderInput): Promise<RenderOutput> {
  const out: RenderedArtifact[] = [];
  const warnings: string[] = [];

  for (const slot of input.draft.ganttSlots ?? []) {
    if (slot.status !== "ready" || !slot.data || slot.data.length === 0) continue;
    const native = await tryWhiteboardForGantt({
      userId: input.userId,
      slot,
      sourceLinks: input.sourceLinks,
    });
    if (native) {
      out.push(native);
      continue;
    }
    const mermaid = buildGanttMermaid(slot);
    if (mermaid) {
      const img = await tryImageFallback({
        userId: input.userId,
        documentId: input.documentId,
        slotId: slot.slotId,
        sectionHeading: slot.task,
        diagram: mermaid,
        caption: buildProvenanceCaption(slot.task, input.sourceLinks),
      });
      if (img.artifact) {
        out.push(img.artifact);
        continue;
      }
      if (img.warning) warnings.push(`gantt:${slot.slotId}:${img.warning}`);
    }
    warnings.push(`gantt slot ${slot.slotId} fallback to markdown`);
  }

  for (const slot of input.draft.timelineSlots ?? []) {
    if (slot.status !== "ready" || !slot.data || slot.data.length === 0) continue;
    const mermaid = buildTimelineMermaid(slot);
    if (!mermaid) continue;
    const img = await tryImageFallback({
      userId: input.userId,
      documentId: input.documentId,
      slotId: slot.slotId,
      sectionHeading: slot.title,
      diagram: mermaid,
      caption: buildProvenanceCaption(slot.title, input.sourceLinks),
    });
    if (img.artifact) {
      out.push(img.artifact);
      continue;
    }
    if (img.warning) warnings.push(`timeline:${slot.slotId}:${img.warning}`);
    warnings.push(`timeline slot ${slot.slotId} fallback to markdown`);
  }

  for (const slot of input.draft.chartSlots ?? []) {
    if (slot.status !== "ready" || !slot.data) continue;
    const mermaid = buildChartMermaid(slot);
    if (!mermaid) continue;
    const img = await tryImageFallback({
      userId: input.userId,
      documentId: input.documentId,
      slotId: slot.slotId,
      sectionHeading: slot.title,
      diagram: mermaid,
      caption: buildProvenanceCaption(slot.title, input.sourceLinks),
    });
    if (img.artifact) {
      out.push(img.artifact);
      continue;
    }
    if (img.warning) warnings.push(`chart:${slot.slotId}:${img.warning}`);
    warnings.push(`chart slot ${slot.slotId} fallback to markdown`);
  }

  return { artifacts: out, warnings };
}
