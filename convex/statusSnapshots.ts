import { mutationGeneric } from "convex/server";
import { v } from "convex/values";

export const record = mutationGeneric({
  args: {
    generatedAt: v.string(),
    source: v.any(),
    fleet: v.any(),
    pipeline: v.any(),
    recent: v.any(),
    diagnostics: v.any(),
    schemaVersion: v.number(),
  },
  handler: async (ctx, snapshot) => {
    return await ctx.db.insert("statusSnapshots", snapshot);
  },
});
