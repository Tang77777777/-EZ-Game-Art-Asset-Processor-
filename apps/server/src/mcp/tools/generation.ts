import * as z from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/server";
import { VIDEO_INPUT_MODES } from "@ezgameart/shared";
import { createGenerationJobs } from "../../queue";
import { checkVideoSupport, resolveReferencePaths } from "../../providerAdapter";
import { ok, err } from "../helpers";

export function register(server: McpServer) {
  server.registerTool(
    "generate_materials",
    {
      title: "Generate Materials",
      description:
        "Generate image or video materials using an AI generation provider. Each requested image becomes an independently scheduled job; returns jobId (first job) and jobIds (all jobs). Materials enter the library as each job completes. Optional name sets the material name base (defaults to prompt prefix).",
      inputSchema: z.object({
        prompt: z.string().describe("Generation prompt (English recommended)"),
        count: z.number().int().min(1).max(16).describe("Number of materials to generate (default 1)").optional(),
        autoMatting: z.boolean().describe("Auto-run background removal after generation").optional(),
        name: z.string().describe("Material name base (defaults to prompt prefix)").optional(),
        providerId: z.string().describe("Provider UUID").optional(),
        model: z.string().describe("Model name").optional(),
        size: z.string().describe("Output size").optional(),
        mediaKind: z.enum(["image", "video"]).describe("image or video mode").optional(),
        videoInputMode: z
          .enum(VIDEO_INPUT_MODES)
          .describe(
            "Video input shape for this request: text (prompt only) / firstFrame (references[0] as opening frame) / firstLastFrame (references[0] and [1] as first and last; a single reference is reused for both, producing a seamless loop) / referenceImage (subject consistency, up to 10). Omit to fall back to the settings-page declaration, then model-name inference."
          )
          .optional(),
        fps: z.number().int().min(1).max(60).describe("Video extraction fps").optional(),
        referenceMaterialId: z.string().describe("Reference material UUID").optional(),
        references: z.array(z.object({
          kind: z.literal("material"),
          id: z.string(),
        })).max(10).describe("Ordered reference images; do not combine with legacy single-reference fields").optional(),
        folderId: z.string().describe("Target folder UUID for generated materials").optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args) => {
      const { prompt, count, autoMatting, name, providerId, model, size, mediaKind, videoInputMode, fps, referenceMaterialId, references, folderId } = args;
      const body = {
        prompt,
        count: count ?? 1,
        autoMatting: autoMatting ?? false,
        name,
        providerId,
        model,
        size,
        mediaKind,
        videoInputMode,
        fps,
        referenceMaterialId,
        references,
        folderId: folderId ?? null,
      };
      const ref = resolveReferencePaths(body);
      if (ref.error) return err(ref.error);
      const videoErr = checkVideoSupport(body);
      if (videoErr) return err(videoErr);
      const jobIds = createGenerationJobs({
        prompt,
        count: body.count,
        autoMatting: body.autoMatting,
        name,
        referencePaths: ref.referencePaths,
        providerId,
        model,
        size,
        mediaKind,
        videoInputMode,
        fps,
        folderId: body.folderId,
      });
      return ok({ jobId: jobIds[0], jobIds });
    }
  );
}
