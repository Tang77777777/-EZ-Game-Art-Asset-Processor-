import { describe, expect, test } from "bun:test";
import type { GenProviderInfo } from "@ezgameart/shared";
import { resolveProviderSelection } from "../apps/web/src/providerSelection";

const provider = (id: string, type: GenProviderInfo["type"], configured: boolean, imageModels: string[] = [], videoModels: string[] = []): GenProviderInfo => ({ id, name: id, type, configured, imageModels, videoModels, video: videoModels.length > 0, imageSize: "", videoSize: "" });

describe("provider 默认选择", () => {
  const cases = [
    ["显式优先", [provider("a", "api", true, ["a1"]), provider("b", "dashscope", true, ["b1"])], "b", false, "b"],
    ["配置 API 可手输", [provider("api", "api", true)], "", false, "api"],
    ["有模型优先于空 API", [provider("api", "api", true), provider("ds", "dashscope", true, ["wanx"])], "", false, "ds"],
    ["CLI 回退", [provider("cli", "cli", true)], "", false, "cli"],
    ["视频资格", [provider("img", "dashscope", true, ["wanx"]), provider("vid", "dashscope", true, [], ["i2v"])], "", true, "vid"],
    ["不选未配置", [provider("off", "api", false, ["m"])], "off", false, undefined],
  ] as const;
  test.each(cases)("%s", (_, providers, explicit, videoOnly, expected) => expect(resolveProviderSelection([...providers], explicit, "", { videoOnly }).providerId).toBe(expected));
});
