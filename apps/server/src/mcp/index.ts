/**
 * MCP（Model Context Protocol）服务端模块。
 *
 * 基于 @modelcontextprotocol/server SDK v2，自动兼容 2025-era 和 2026-07-28 协议。
 * 传输：Streamable HTTP —— 客户端请求 /mcp，SDK 自动处理 JSON-RPC / SSE / 会话。
 * 工具直接读写 db / 内部模块，不走 HTTP 自调用，零额外开销。
 */

import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import serverPackage from "../../package.json" with { type: "json" };
import { register as registerGenerationTools } from "./tools/generation";
import { register as registerMaterialTools } from "./tools/materials";
import { register as registerFolderTools } from "./tools/folders";
import { register as registerJobTools } from "./tools/jobs";
import { register as registerSystemTools } from "./tools/system";

export const mcpHandler = createMcpHandler(() => {
  const server = new McpServer({ name: "ezgameart-asset-processor", version: serverPackage.version });
  registerGenerationTools(server);
  registerMaterialTools(server);
  registerFolderTools(server);
  registerJobTools(server);
  registerSystemTools(server);
  return server;
});
