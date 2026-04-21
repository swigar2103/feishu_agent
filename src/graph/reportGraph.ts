import { END, START, StateGraph } from "@langchain/langgraph";
import { analystNode } from "./nodes/analystNode.js";
import { buildWriterInput } from "./nodes/buildWriterInput.js";
import { feishuDocxWriterNode } from "./nodes/feishuDocxWriterNode.js";
import { feishuNotifyNode } from "./nodes/feishuNotifyNode.js";
import { formatOutput } from "./nodes/formatOutput.js";
import { intentNode } from "./nodes/intentNode.js";
import { memoryWriterNode } from "./nodes/memoryWriterNode.js";
import { parseUserRequest } from "./nodes/parseUserRequest.js";
import { plannerNode } from "./nodes/plannerNode.js";
import { retrieverNode } from "./nodes/retrieverNode.js";
import { reviewerNode } from "./nodes/reviewerNode.js";
import { writerNode } from "./nodes/writerNode.js";
import { ReportGraphState, type ReportGraphStateType } from "./state.js";

// 最多允许一次 Writer 改写（防死循环）
const MAX_REVISIONS = 1;

/**
 * Reviewer 之后的路由：
 *   - 审阅通过 → format_output
 *   - 审阅不通过 且 还没用完改写次数 → 回到 writer_node
 *   - 审阅不通过 但 改写次数已满 → 直接 format_output（让终局输出带上 reviewNotes，交给人工）
 */
function reviewerRouter(state: ReportGraphStateType): "writer_node" | "format_output" {
  const report = state.reviewReport;
  if (!report) return "format_output";
  if (report.pass) return "format_output";
  if (state.revisionCount >= MAX_REVISIONS) return "format_output";
  return "writer_node";
}

// 节点顺序（Phase 5）：
//   parse → intent → retriever → planner → analyst → build_writer_input → writer → reviewer
//   reviewer 之后走条件边：pass 去 format_output；fail 且未超改写上限则回到 writer_node 做一次改写
//   format_output → memory_writer → feishu_docx_writer → feishu_notify → END
//   memory_writer / feishu_docx_writer / feishu_notify 都是"静默守护"节点，失败不阻塞主流程
//   feishu_docx_writer 在前：它产出的 docUrl 供 feishu_notify 放进卡片按钮
export const reportGraph = new StateGraph(ReportGraphState)
  .addNode("parse_user_request", parseUserRequest)
  .addNode("intent_node", intentNode)
  .addNode("retriever_node", retrieverNode)
  .addNode("planner_node", plannerNode)
  .addNode("analyst_node", analystNode)
  .addNode("build_writer_input", buildWriterInput)
  .addNode("writer_node", writerNode)
  .addNode("reviewer_node", reviewerNode)
  .addNode("format_output", formatOutput)
  .addNode("memory_writer", memoryWriterNode)
  .addNode("feishu_docx_writer", feishuDocxWriterNode)
  .addNode("feishu_notify", feishuNotifyNode)
  .addEdge(START, "parse_user_request")
  .addEdge("parse_user_request", "intent_node")
  .addEdge("intent_node", "retriever_node")
  .addEdge("retriever_node", "planner_node")
  .addEdge("planner_node", "analyst_node")
  .addEdge("analyst_node", "build_writer_input")
  .addEdge("build_writer_input", "writer_node")
  .addEdge("writer_node", "reviewer_node")
  .addConditionalEdges("reviewer_node", reviewerRouter, {
    writer_node: "writer_node",
    format_output: "format_output",
  })
  .addEdge("format_output", "memory_writer")
  .addEdge("memory_writer", "feishu_docx_writer")
  .addEdge("feishu_docx_writer", "feishu_notify")
  .addEdge("feishu_notify", END)
  .compile();
