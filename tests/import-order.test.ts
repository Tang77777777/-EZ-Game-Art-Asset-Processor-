import { describe, expect, test } from "bun:test";
import { sortImportFiles, waitForQueuedJob } from "../apps/web/src/hooks/useImportWorkflow";

describe("多文件导入顺序", () => {
  test("按文件名自然升序排列数字帧", () => {
    const files = ["run_12.png", "run_2.png", "run_1.png"].map((name) => new File([], name));
    expect(sortImportFiles(files).map((file) => file.name)).toEqual(["run_1.png", "run_2.png", "run_12.png"]);
  });

  test("任务状态短暂查询失败时继续等待，不提前放行下一文件", async () => {
    let calls = 0;
    let waits = 0;
    const result = await waitForQueuedJob(
      "job-1",
      () => true,
      async () => {
        calls++;
        if (calls === 1) throw new Error("temporary network error");
        if (calls === 2) return { status: "running", error: null };
        return { status: "done", error: null };
      },
      async () => {
        waits++;
      }
    );

    expect(result).toEqual({ status: "done" });
    expect(calls).toBe(3);
    expect(waits).toBe(2);
  });

  test("批次失效期间返回的旧任务结果会被丢弃", async () => {
    let active = true;
    let resolveJob!: (job: { status: "done"; error: null }) => void;
    const resultPromise = waitForQueuedJob(
      "job-1",
      () => active,
      () =>
        new Promise((resolve) => {
          resolveJob = resolve;
        }),
      async () => {}
    );

    active = false;
    resolveJob({ status: "done", error: null });

    expect(await resultPromise).toEqual({ status: "stale" });
  });
});
