import * as z from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/server";
import { db } from "../../db";
import { cancelJob } from "../../queue";
import { ok, err } from "../helpers";

export function register(server: McpServer) {
  server.registerTool(
    "list_jobs",
    {
      title: "List Jobs",
      description:
        "List recent jobs (up to 50, newest first). Each job has id, type (extract_frames/generate_materials/matting/image_layers), status (queued/running/done/error/cancelled), progress, error, and created_at.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async () => {
      const jobs = db.query("SELECT * FROM jobs ORDER BY created_at DESC LIMIT 50").all();
      return ok({ jobs });
    }
  );

  server.registerTool(
    "get_job",
    {
      title: "Get Job",
      description: "Get the status of a single job by id. Use this to poll async jobs (generate, extract, matting, image layers).",
      inputSchema: z.object({
        jobId: z.string().describe("Job UUID"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ jobId }) => {
      const job = db.query("SELECT * FROM jobs WHERE id = ?").get(jobId);
      if (!job) return err("任务不存在");
      return ok({ job });
    }
  );

  server.registerTool(
    "cancel_job",
    {
      title: "Cancel Job",
      description:
        "Cancel a queued or running job. Queued jobs are removed immediately; running jobs receive an abort signal (kills subprocess/API polling). Returns error if job already finished.",
      inputSchema: z.object({
        jobId: z.string().describe("Job UUID"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ jobId }) => {
      const job = db.query("SELECT id, status FROM jobs WHERE id = ?").get(jobId) as
        | { id: string; status: string }
        | null;
      if (!job) return err("任务不存在");
      if (job.status !== "queued" && job.status !== "running") {
        return err(`任务状态为 ${job.status}，无法取消`);
      }
      if (!cancelJob(jobId)) return err("取消失败");
      return ok({ ok: true });
    }
  );
}
