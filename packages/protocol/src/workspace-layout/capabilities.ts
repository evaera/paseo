import { z } from "zod";

export const WorkspaceLayoutHostCapabilitySchema = z
  .object({
    hostKind: z.string().min(1).default("workspace layout host"),
    hostInstanceId: z.string().min(1),
  })
  .passthrough();

export type WorkspaceLayoutHostCapability = z.infer<typeof WorkspaceLayoutHostCapabilitySchema>;
