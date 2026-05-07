import { END, START, StateGraph } from "@langchain/langgraph";
import { analystAgentNode } from "./nodes/analystAgentNode.js";
import { complianceReviewerNode } from "./nodes/complianceReviewerNode.js";
import { intentAgentNode } from "./nodes/intentAgentNode.js";
import { memoryUpdateNode } from "./nodes/memoryUpdateNode.js";
import { outputGeneratorNode } from "./nodes/outputGeneratorNode.js";
import { plannerAgentNode } from "./nodes/plannerAgentNode.js";
import { requestGuardNode } from "./nodes/requestGuardNode.js";
import { resourcePoolEnricherNode } from "./nodes/resourcePoolEnricherNode.js";
import { resourceScreeningNode } from "./nodes/resourceScreeningNode.js";
import { retrieverAgentNode } from "./nodes/retrieverAgentNode.js";
import { skillRouterNode } from "./nodes/skillRouterNode.js";
import { styleReviewerNode } from "./nodes/styleReviewerNode.js";
import { writerAgentNode } from "./nodes/writerAgentNode.js";
import { ReportGraphState, type ReportGraphStateType } from "./state.js";

function routeAfterStyle(state: ReportGraphStateType): string {
  if (state.callbackRoute === "to_writer") return "writer_agent";
  if (state.callbackRoute === "to_compliance") return "compliance_reviewer";
  return "compliance_reviewer";
}

function routeAfterCompliance(state: ReportGraphStateType): string {
  if (state.callbackRoute === "to_planner") return "planner_agent";
  if (state.callbackRoute === "to_analyst") return "analyst_agent";
  if (state.callbackRoute === "to_publish") return "output_generator";
  return "output_generator";
}

export const reportGraph = new StateGraph(ReportGraphState)
  .addNode("request_guard", requestGuardNode)
  .addNode("resource_screening", resourceScreeningNode)
  .addNode("intent_agent", intentAgentNode)
  .addNode("skill_router", skillRouterNode)
  .addNode("planner_agent", plannerAgentNode)
  .addNode("retriever_agent", retrieverAgentNode)
  .addNode("analyst_agent", analystAgentNode)
  .addNode("writer_agent", writerAgentNode)
  .addNode("style_reviewer", styleReviewerNode)
  .addNode("compliance_reviewer", complianceReviewerNode)
  .addNode("output_generator", outputGeneratorNode)
  .addNode("memory_update", memoryUpdateNode)
  .addNode("resource_pool_enricher", resourcePoolEnricherNode)
  .addEdge(START, "request_guard")
  .addEdge("request_guard", "resource_screening")
  .addEdge("resource_screening", "intent_agent")
  .addEdge("intent_agent", "skill_router")
  .addEdge("skill_router", "planner_agent")
  .addEdge("planner_agent", "retriever_agent")
  .addEdge("retriever_agent", "analyst_agent")
  .addEdge("analyst_agent", "writer_agent")
  .addEdge("writer_agent", "style_reviewer")
  .addConditionalEdges("style_reviewer", routeAfterStyle, {
    writer_agent: "writer_agent",
    compliance_reviewer: "compliance_reviewer",
  })
  .addConditionalEdges("compliance_reviewer", routeAfterCompliance, {
    planner_agent: "planner_agent",
    analyst_agent: "analyst_agent",
    output_generator: "output_generator",
  })
  .addEdge("output_generator", "memory_update")
  .addEdge("memory_update", "resource_pool_enricher")
  .addEdge("resource_pool_enricher", END)
  .compile();
