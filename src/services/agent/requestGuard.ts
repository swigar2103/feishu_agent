import { TaskRequestSchema, type TaskRequest } from "../../schemas/agentContracts.js";
import { UserRequestSchema, type UserRequest } from "../../schemas/index.js";
import { normalizeText } from "../../shared/utils.js";

export function guardRequest(userRequest: UserRequest): TaskRequest {
  const parsed = UserRequestSchema.parse(userRequest);
  const normalizedPrompt = normalizeText(parsed.prompt);
  const guardHints: string[] = [];
  const hasActionVerb =
    /(生成|输出|整理|分析|汇总|复盘|写|做|制作|评估|修改|修订|调整|删|删改|补充|重写|更新|改写|润色|优化|替换|参照|对照|缩写|扩写|迁移|合并|拆分|删减|提炼|沿用|保留|剔除|改|增删|report|analy|summar)/i.test(
      normalizedPrompt,
    );
  /** 来自 chat 页的 Add to Chat，正文在 extraContext 的大段「对话区引用」里 */
  const hasChatSelectionExtra = (parsed.extraContext ?? []).some((block) =>
    block.includes("对话区引用"),
  );
  const isTooShort = normalizedPrompt.length < 6 && !hasChatSelectionExtra;
  const isLikelyChatOnly =
    !hasActionVerb && normalizedPrompt.length < 20 && !hasChatSelectionExtra;
  const isValid = !isTooShort && !isLikelyChatOnly;
  const validityLevel = isValid
    ? "accepted"
    : isTooShort
      ? "needs_clarification"
      : "rejected";

  if (isTooShort) guardHints.push("请补充任务目标、时间范围、输出形式");
  if (isLikelyChatOnly) guardHints.push("当前输入更像闲聊，请明确可执行任务");

  return TaskRequestSchema.parse({
    requestId: `${parsed.sessionId}-${Date.now()}`,
    receivedAt: new Date().toISOString(),
    userRequest: parsed,
    normalizedPrompt,
    isValid,
    validityLevel,
    guardHints,
    invalidReason: isValid ? undefined : "任务描述过短，请补充目标和范围",
  });
}
