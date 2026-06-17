import { mutationGeneric } from "convex/server";
import { v } from "convex/values";

export const record = mutationGeneric({
  args: {
    receivedAt: v.string(),
    eventType: v.string(),
    repository: v.union(v.string(), v.null()),
    itemNumber: v.union(v.number(), v.null()),
    mode: v.string(),
    stage: v.string(),
    status: v.string(),
    title: v.union(v.string(), v.null()),
    itemUrl: v.union(v.string(), v.null()),
    runUrl: v.union(v.string(), v.null()),
    payload: v.any(),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, event) => {
    const existing = await ctx.db
      .query("events")
      .withIndex("by_idempotency_key", (query) => query.eq("idempotencyKey", event.idempotencyKey))
      .first();
    if (existing) return existing._id;

    return await ctx.db.insert("events", event);
  },
});
