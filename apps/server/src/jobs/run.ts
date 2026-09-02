/** 任务被用户取消时抛出；queue 将其记为 cancelled 而非 error */
export class JobCancelledError extends Error {
  constructor(message = "任务已取消") {
    super(message);
    this.name = "JobCancelledError";
  }
}

/** 统一的外部命令执行器：捕获 stderr，非零退出即抛错；支持 AbortSignal 杀进程 */
export async function runCmd(
  argv: string[],
  env?: Record<string, string>,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) throw new JobCancelledError();
  const proc = Bun.spawn(argv, {
    stdout: "pipe",
    stderr: "pipe",
    env: env ? { ...process.env, ...env } : undefined,
  });
  const onAbort = () => {
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    if (signal?.aborted) throw new JobCancelledError();
    if (code !== 0) {
      throw new Error(`命令执行失败 (${argv[0]}): ${stderr.trim().slice(-2000) || `退出码 ${code}`}`);
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}
