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
          content: `**${input.title}**\n\n文档已生成，可点击查看。`,
        },
        {
          tag: "action",
          actions: [
            {
              tag: "button",
              text: {
                tag: "plain_text",
                content: "查看文档",
              },
              type: "primary",
              multi_url: {
                url: input.docUrl,
              },
            },
            {
              tag: "button",
              text: {
                tag: "plain_text",
                content: "标记已处理",
              },
              type: "default",
              value: {
                action: "mark_done",
                session_id: input.sessionId,
              },
            },
          ],
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
  const primaryUrl = input.links[0]?.url ?? "";

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
          tag: "action",
          actions: [
            ...(primaryUrl
              ? [
                  {
                    tag: "button",
                    text: { tag: "plain_text", content: "打开主成果" },
                    type: "primary",
                    multi_url: { url: primaryUrl },
                  },
                ]
              : []),
            {
              tag: "button",
              text: { tag: "plain_text", content: "继续生成" },
              type: "default",
              value: { action: "continue_generate", session_id: input.sessionId },
            },
            {
              tag: "button",
              text: { tag: "plain_text", content: "补充信息" },
              type: "default",
              value: { action: "need_more_info", session_id: input.sessionId },
            },
          ],
        },
      ],
    },
  };
}
