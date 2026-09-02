import { describe, expect, test } from "bun:test";
import {
  deriveVideoInputMode,
  resolveVideoInputMode,
  videoInputModeAcceptsReferences,
  videoInputModeMaxReferences,
  videoModeOffersKeyframes,
  VIDEO_INPUT_MODES,
} from "../packages/shared/src/types";

describe("视频输入形态：显式声明优先", () => {
  test("声明值覆盖名称推断", () => {
    // 名字带 i2v 会被推断为首帧，但显式声明为纯文生时必须听声明
    expect(resolveVideoInputMode("wanx2.1-i2v-turbo", { "wanx2.1-i2v-turbo": "text" })).toBe("text");
    // 反向：名字看不出来，声明为首帧
    expect(resolveVideoInputMode("wan3.0-video", { "wan3.0-video": "firstFrame" })).toBe("firstFrame");
  });

  test("非法声明值被忽略，回退名称推断", () => {
    const bogus = { "wanx2.1-i2v-turbo": "firstAndLastFrame" } as unknown as Record<
      string,
      (typeof VIDEO_INPUT_MODES)[number]
    >;
    expect(resolveVideoInputMode("wanx2.1-i2v-turbo", bogus)).toBe("firstFrame");
  });

  test("声明表缺该模型时回退名称推断", () => {
    expect(resolveVideoInputMode("wanx2.1-i2v-turbo", { "other-model": "text" })).toBe("firstFrame");
    expect(resolveVideoInputMode("wanx2.1-i2v-turbo", undefined)).toBe("firstFrame");
    expect(resolveVideoInputMode("wanx2.1-i2v-turbo", null)).toBe("firstFrame");
  });
});

describe("名称推断的兜底行为", () => {
  test("i2v 系推断为首帧驱动", () => {
    expect(resolveVideoInputMode("wanx2.1-i2v-turbo")).toBe("firstFrame");
    expect(resolveVideoInputMode("happyhorse-1.1-i2v")).toBe("firstFrame");
    expect(resolveVideoInputMode("some-first_frame-model")).toBe("firstFrame");
  });

  /**
   * kf2 = keyframe-to-video，这一族本身就是首尾帧模型。
   * 早先归到 firstFrame 是判断错误：只送首帧会丢掉尾帧这个关键约束。
   */
  test("kf2 系推断为首尾帧驱动，而非单首帧", () => {
    expect(resolveVideoInputMode("wan2.2-kf2")).toBe("firstLastFrame");
    expect(resolveVideoInputMode("some-first-and-last-model")).toBe("firstLastFrame");
    expect(resolveVideoInputMode("vendor-first_last-video")).toBe("firstLastFrame");
  });

  test("r2v 系推断为参考图", () => {
    expect(resolveVideoInputMode("happyhorse-1.1-r2v")).toBe("referenceImage");
  });

  /**
   * 这是本次修复钉死的回归：wan3.0-video 不含 i2v/r2v/kf2 任何标记，
   * 旧实现三条正则全不匹配、当成纯文生视频，用户选的引用图被静默丢弃。
   * 现在推断仍是 text（名字确实看不出来），但用户可在设置页显式声明覆盖。
   */
  test("看不出形态的模型名推断为纯文生，须靠显式声明纠正", () => {
    expect(resolveVideoInputMode("wan3.0-video")).toBe("text");
    expect(resolveVideoInputMode("wan2.5-t2v")).toBe("text");
    expect(resolveVideoInputMode("MiniMax-Hailuo-2.3")).toBe("text");
    // 显式声明后即可正确路由
    expect(resolveVideoInputMode("wan3.0-video", { "wan3.0-video": "firstFrame" })).toBe("firstFrame");
  });
});

describe("各形态的引用图约束", () => {
  test("是否接受引用图", () => {
    expect(videoInputModeAcceptsReferences("text")).toBe(false);
    expect(videoInputModeAcceptsReferences("firstFrame")).toBe(true);
    expect(videoInputModeAcceptsReferences("firstLastFrame")).toBe(true);
    expect(videoInputModeAcceptsReferences("referenceImage")).toBe(true);
  });

  test("引用图张数上限", () => {
    expect(videoInputModeMaxReferences("text")).toBe(0);
    expect(videoInputModeMaxReferences("firstFrame")).toBe(1);
    // 首帧 + 尾帧各 1 张；官方对 first_frame / last_frame 都限制最多 1 张
    expect(videoInputModeMaxReferences("firstLastFrame")).toBe(2);
    expect(videoInputModeMaxReferences("referenceImage")).toBe(10);
  });

  test("不接受引用图的形态上限必须为 0，两个函数不能互相矛盾", () => {
    for (const mode of VIDEO_INPUT_MODES) {
      expect(videoInputModeMaxReferences(mode) > 0).toBe(videoInputModeAcceptsReferences(mode));
    }
  });

  /**
   * 枚举是设置页下拉与服务端 media 构造的共同来源，漏一项就会出现
   * 「界面能选、服务端不认」的错位。这里钉死当前四项与顺序。
   */
  test("枚举恰好四项，新增形态必须同步更新上面两个函数", () => {
    expect([...VIDEO_INPUT_MODES]).toEqual(["text", "firstFrame", "firstLastFrame", "referenceImage"]);
  });
});

describe("形态由填写的槽位派生", () => {
  /**
   * 这是「不再要求先去设置页声明」的核心：用户填了什么就是什么形态。
   * 期望值写死，不从实现推导。
   */
  test("起始帧留空 → 纯文生（保留面板原有的文生视频能力）", () => {
    expect(deriveVideoInputMode({ hasFirst: false, hasLast: false, loop: false })).toBe("text");
    // 没有起始帧时，勾了循环也无从循环
    expect(deriveVideoInputMode({ hasFirst: false, hasLast: false, loop: true })).toBe("text");
  });

  test("只填起始帧、不勾循环 → 首帧驱动", () => {
    expect(deriveVideoInputMode({ hasFirst: true, hasLast: false, loop: false })).toBe("firstFrame");
  });

  /**
   * 这条是修掉那个真实 bug 的钉子：早先服务端只看引用图张数，1 张一律复制成尾帧，
   * 于是「只想首帧驱动」的人被强行套上了循环。loop 必须能把两者分开。
   */
  test("只填起始帧但勾了循环 → 首尾帧（与上一条同样是 1 张图，形态必须不同）", () => {
    expect(deriveVideoInputMode({ hasFirst: true, hasLast: false, loop: true })).toBe("firstLastFrame");
    expect(deriveVideoInputMode({ hasFirst: true, hasLast: false, loop: true })).not.toBe(
      deriveVideoInputMode({ hasFirst: true, hasLast: false, loop: false })
    );
  });

  test("填了结束帧 → 首尾帧，与循环开关无关", () => {
    expect(deriveVideoInputMode({ hasFirst: true, hasLast: true, loop: false })).toBe("firstLastFrame");
    expect(deriveVideoInputMode({ hasFirst: true, hasLast: true, loop: true })).toBe("firstLastFrame");
  });

  test("派生出的形态一定在枚举内，且引用图上限容得下所填的图", () => {
    for (const hasFirst of [false, true]) {
      for (const hasLast of [false, true]) {
        for (const loop of [false, true]) {
          const mode = deriveVideoInputMode({ hasFirst, hasLast, loop });
          expect(VIDEO_INPUT_MODES).toContain(mode);
          const filled = (hasFirst ? 1 : 0) + (hasLast && hasFirst ? 1 : 0);
          expect(videoInputModeMaxReferences(mode)).toBeGreaterThanOrEqual(filled);
        }
      }
    }
  });
});

describe("何时给出首尾帧槽位", () => {
  test("未声明就给——模型名推断不出能力，默认不给等于把能力藏起来", () => {
    expect(videoModeOffersKeyframes(undefined)).toBe(true);
    expect(videoModeOffersKeyframes(null)).toBe(true);
  });

  test("声明为首帧或首尾帧当然给", () => {
    expect(videoModeOffersKeyframes("firstFrame")).toBe(true);
    expect(videoModeOffersKeyframes("firstLastFrame")).toBe(true);
  });

  test("只有显式声明纯文生或参考图才不给", () => {
    expect(videoModeOffersKeyframes("text")).toBe(false);
    expect(videoModeOffersKeyframes("referenceImage")).toBe(false);
  });
});
