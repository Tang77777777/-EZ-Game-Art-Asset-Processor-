import { describe, expect, test } from "bun:test";
import { parseLayerResponse } from "../apps/server/src/jobs/imageLayers";

describe("图片分层响应解析", () => {
  test("支持顶层、data 与常见命名数组", () => {
    expect(parseLayerResponse(["https://example.com/a.png", { b64_json: "AA==" }])).toHaveLength(2);
    expect(parseLayerResponse({ data: { images: [{ url: "https://example.com/b.png" }] } })).toHaveLength(1);
    expect(parseLayerResponse({ layers: ["data:image/png;base64,AA=="] })).toHaveLength(1);
  });

  test("不递归扫描任意字符串并过滤 id", () => {
    expect(parseLayerResponse({ id: "https://example.com/not-an-image", result: { images: ["https://example.com/a.png"] } })).toEqual([]);
    expect(parseLayerResponse({ output: ["request-id", { id: "x" }] })).toEqual([]);
  });
});
