import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { serve } from "bun";
import { app } from "../apps/server/src/app";

const BASE = "http://localhost:3998";
let server: ReturnType<typeof serve>;

beforeAll(() => {
  server = serve({ port: 3998, fetch: app.handle });
});

afterAll(() => {
  server.stop();
});

function parseSseJson(text: string): any {
  for (const line of text.split("\n")) {
    if (line.startsWith("data: ")) {
      return JSON.parse(line.slice(6));
    }
  }
  return null;
}

async function mcp(body: unknown): Promise<any> {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });
  const ct = res.headers.get("content-type") ?? "";
  let json: any = null;
  if (ct.includes("text/event-stream")) {
    json = parseSseJson(await res.text());
  } else if (ct.includes("application/json")) {
    try {
      json = await res.json();
    } catch {
      /* empty */
    }
  }
  return { status: res.status, json, headers: res.headers };
}

describe("MCP 端点", () => {
  test("initialize 握手返回协议版本与服务端信息", async () => {
    const { json } = await mcp({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0" },
      },
    });
    expect(json.result.protocolVersion).toBeTruthy();
    expect(json.result.serverInfo.name).toBe("ezgameart-asset-processor");
    expect(json.result.capabilities.tools).toBeDefined();
  });

  test("tools/list 返回全部工具", async () => {
    const { json } = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(json.result.tools.length).toBeGreaterThan(0);
    const names = json.result.tools.map((t: any) => t.name);
    expect(names).toContain("list_materials");
    expect(names).toContain("generate_materials");
    expect(names).toContain("get_config");
    expect(names).toContain("rename_material");
    expect(names).toContain("delete_folders");
    const tool = json.result.tools.find((t: any) => t.name === "list_materials");
    expect(tool.description).toBeTruthy();
  });

  test("未知工具返回错误", async () => {
    const { json } = await mcp({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "nonexistent_tool", arguments: {} },
    });
    const hasError = json?.error || (json?.result && json.result.isError);
    expect(hasError).toBeTruthy();
  });

  test("ping 返回空结果", async () => {
    const { json } = await mcp({ jsonrpc: "2.0", id: 6, method: "ping" });
    expect(json.result).toEqual({});
  });

  test("notifications/initialized 被接受", async () => {
    const res = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect([200, 202, 204]).toContain(res.status);
  });

  test("无效 JSON 返回错误状态码", async () => {
    const res = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: "not json",
    });
    expect([400, 406, 415]).toContain(res.status);
  });

  test("DELETE /mcp 被处理", async () => {
    const res = await fetch(`${BASE}/mcp`, { method: "DELETE" });
    expect([200, 204, 405]).toContain(res.status);
  });

  test("get_config 工具返回服务端配置", async () => {
    const { json } = await mcp({
      jsonrpc: "2.0",
      id: 20,
      method: "tools/call",
      params: { name: "get_config", arguments: {} },
    });
    const config = JSON.parse(json.result.content[0].text);
    expect(config.matting).toBeDefined();
    expect(config.matting.engine).toBeDefined();
    expect(config.gen).toBeDefined();
    expect(config.gen.providers).toBeDefined();
  });

  test("get_settings 工具不泄露 API keys", async () => {
    const { json } = await mcp({
      jsonrpc: "2.0",
      id: 21,
      method: "tools/call",
      params: { name: "get_settings", arguments: {} },
    });
    const settings = JSON.parse(json.result.content[0].text);
    if (Array.isArray(settings.genProviders)) {
      for (const p of settings.genProviders) {
        if (p.apiKey) expect(p.apiKey).toBe("***");
      }
    }
  });
});
