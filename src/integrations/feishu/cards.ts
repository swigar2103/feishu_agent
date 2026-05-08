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

/**
 * UAT 未就绪时引导用户在飞书内点击按钮跳转 OAuth（open_url → 飞书授权页）。
 * @see https://open.feishu.cn/document/feishu-cards/card-json-v2-components/interactive-components/button
 */
export function buildUserOAuthRequiredCard(input: {
  authUrl: string;
  /** 展示在说明里，便于运营对照日志（非敏感） */
  userIdHint?: string;
  /** 备用授权入口（固定域名中转），用于规避旧卡片残留链接 */
  fallbackAuthStartUrl?: string;
}): Record<string, unknown> {
  const who = input.userIdHint?.trim()
    ? `\n\n绑定账号：\`${input.userIdHint.trim()}\``
    : "";
  const fallbackEntry = input.fallbackAuthStartUrl?.trim()
    ? `\n\n备用授权入口（固定域名）：[点击重新拉起授权](${input.fallbackAuthStartUrl.trim()})`
    : "";
  const primaryAuthEntry = input.fallbackAuthStartUrl?.trim() || input.authUrl;
  return {
    schema: "2.0",
    config: { update_multi: true },
    body: {
      direction: "vertical",
      elements: [
        {
          tag: "markdown",
          content: `## 需要授权后才能搜索您的云文档${who}\n\n当前以 **用户令牌（UAT）** 访问文档搜索。请点击下方按钮，在飞书授权页中同意授权；完成后将**自动继续处理您刚才发送的需求**，无需再次输入。`,
        },
        {
          tag: "button",
          text: { tag: "plain_text", content: "去授权（打开飞书登录页）" },
          type: "primary",
          width: "default",
          behaviors: [
            {
              type: "open_url",
              default_url: primaryAuthEntry,
              pc_url: primaryAuthEntry,
            },
          ],
        },
        {
          tag: "markdown",
          content: `若按钮无响应，可将本卡片截图给管理员，或检查飞书客户端是否为最新版本。${fallbackEntry}`,
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
  artifactSource?: string;
  /** true：仅占位/发布失败，勿当成可点击的云文档链接 */
  unavailable?: boolean;
};

export function buildPipelineResultCard(input: {
  title: string;
  status: "completed" | "partial" | "need_info";
  summary: string[];
  links: PipelineResultLink[];
  sessionId: string;
  workbenchUrl?: string;
  /** 演示：强制覆盖「快速入口 · 主成果」展示的 URL */
  forcedPrimaryDocUrl?: string;
}): Record<string, unknown> {
  const unavailableHintFor = (label: string): string => {
    if (label.includes("报告文档")) {
      return "本次未生成可访问的云文档链接，请以摘要为准或联系管理员查看服务端 MCP 日志";
    }
    if (label.includes("演示稿")) {
      return "本次未生成可访问的演示稿链接（通常为 outline_only 回退）";
    }
    if (label.includes("多维表格")) {
      return "本次未生成可访问的多维表格链接";
    }
    return "本次未生成可访问链接";
  };
  const statusText =
    input.status === "completed"
      ? "已完成"
      : input.status === "partial"
        ? "部分完成"
        : "待补信息";
  const linkLines =
    input.links.length > 0
      ? input.links
          .map((item) => {
            const src = item.artifactSource ? ` _${item.artifactSource}_` : "";
            if (item.unavailable || !item.url?.trim()) {
              return `- **${item.label}**（${unavailableHintFor(item.label)}）${src}`;
            }
            return `- [${item.label}](${item.url})${src}`;
          })
          .join("\n")
      : "- 暂无可用成果链接";
  const summaryLines =
    input.summary.length > 0 ? input.summary.map((item) => `- ${item}`).join("\n") : "- 无";
  const primary = input.links.find((l) => l.url?.trim() && !l.unavailable);
  const primaryUrl = input.forcedPrimaryDocUrl?.trim() || primary?.url?.trim();
  const primaryLine = primaryUrl
    ? `主成果：${primaryUrl}`
    : "主成果：暂无（见上「未生成可访问链接」说明）";
  const workbenchLine = input.workbenchUrl?.trim()
    ? `- [进入在线编辑工作台](${input.workbenchUrl})`
    : "- 在线编辑工作台：未配置（请设置 FEISHU_WORKBENCH_BASE_URL）";

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
          content: `### 快速入口\n- ${primaryLine}\n${workbenchLine}\n- 会话ID：\`${input.sessionId}\``,
        },
      ],
    },
  };
}
