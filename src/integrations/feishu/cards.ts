export function buildGeneratedDocCard(input: {
  title: string;
  docUrl: string;
  sessionId: string;
}): Record<string, unknown> {
  return {
    type: "template",
    data: {
      template_id: "AAqYfP3X8VJY6",
      template_version_name: "1.0.0",
      template_variable: {
        title: input.title,
        doc_url: input.docUrl,
        session_id: input.sessionId,
      },
    },
  };
}

export function buildFallbackGeneratedDocCard(input: {
  title: string;
  docUrl: string;
  sessionId: string;
}): Record<string, unknown> {
  return {
    schema: "2.0",
    config: {
      update_multi: true,
    },
    body: {
      direction: "vertical",
      elements: [
        {
          tag: "markdown",
          content: `**${input.title}**\n\n文档已生成，可点击查看：\n[查看文档](${input.docUrl})\n\n会话：\`${input.sessionId}\``,
        },
      ],
    },
  };
}

export function buildResolvedCard(): Record<string, unknown> {
  return {
    schema: "2.0",
    config: {
      update_multi: true,
    },
    body: {
      direction: "vertical",
      elements: [
        {
          tag: "markdown",
          content: "✅ 该任务已标记为处理完成。",
        },
      ],
    },
  };
}

export function buildPipelineProgressCard(input: {
  title: string;
  sessionId: string;
  userId: string;
  authHint?: string;
}): Record<string, unknown> {
  return {
    schema: "2.0",
    config: { update_multi: true },
    body: {
      direction: "vertical",
      elements: [
        {
          tag: "markdown",
          content: `## ${input.title}\n\n状态：**处理中**\n会话：\`${input.sessionId}\`\n用户：\`${input.userId}\``,
        },
        ...(input.authHint
          ? [
              {
                tag: "markdown",
                content: `权限提示：${input.authHint}`,
              },
            ]
          : []),
      ],
    },
  };
}

export type PipelineResultLink = {
  label: string;
  url: string;
};

export function buildPipelineResultCard(input: {
  title: string;
  status: "completed" | "partial" | "need_info";
  summary: string[];
  links: PipelineResultLink[];
  sessionId: string;
}): Record<string, unknown> {
  const statusText =
    input.status === "completed"
      ? "已完成"
      : input.status === "partial"
        ? "部分完成"
        : "待补信息";
  const linkLines =
    input.links.length > 0
      ? input.links.map((item) => `- [${item.label}](${item.url})`).join("\n")
      : "- 暂无可用成果链接";
  const summaryLines =
    input.summary.length > 0 ? input.summary.map((item) => `- ${item}`).join("\n") : "- 无";
  const primaryLine = input.links[0]?.url ? `主成果：${input.links[0].url}` : "主成果：暂无";

  return {
    schema: "2.0",
    config: { update_multi: true },
    body: {
      direction: "vertical",
      elements: [
        {
          tag: "markdown",
          content: `## ${input.title}\n\n状态：**${statusText}**\n会话：\`${input.sessionId}\``,
        },
        {
          tag: "markdown",
          content: `### 成果链接\n${linkLines}`,
        },
        {
          tag: "markdown",
          content: `### 结构化摘要\n${summaryLines}`,
        },
        {
          tag: "markdown",
          content: `### 快速入口\n- ${primaryLine}\n- 会话ID：\`${input.sessionId}\``,
        },
      ],
    },
  };
}
