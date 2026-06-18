import { queryGeneric } from "convex/server";
import { v } from "convex/values";

const pageArgs = {
  limit: v.optional(v.number()),
  before: v.optional(v.string()),
};

export const snapshots = queryGeneric({
  args: pageArgs,
  handler: async (ctx, args) => {
    const limit = clampLimit(args.limit, 50, 200);
    let query = ctx.db.query("statusSnapshots").withIndex("by_generated_at").order("desc");
    if (args.before) query = query.filter((q) => q.lt(q.field("generatedAt"), args.before));
    const rows = await query.take(limit + 1);
    return page(rows.slice(0, limit), rows.length > limit, (row) => row.generatedAt);
  },
});

export const events = queryGeneric({
  args: pageArgs,
  handler: async (ctx, args) => {
    const limit = clampLimit(args.limit, 50, 200);
    let query = ctx.db.query("events").withIndex("by_received_at").order("desc");
    if (args.before) query = query.filter((q) => q.lt(q.field("receivedAt"), args.before));
    const rows = await query.take(limit + 1);
    return page(rows.slice(0, limit), rows.length > limit, (row) => row.receivedAt);
  },
});

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), max);
}

function page<T>(rows: T[], hasMore: boolean, cursorOf: (row: T) => string) {
  const last = rows.at(-1);
  return {
    rows,
    nextCursor: hasMore && last ? cursorOf(last) : null,
  };
}
