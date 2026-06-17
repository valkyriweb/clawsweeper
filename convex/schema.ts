import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  statusSnapshots: defineTable({
    generatedAt: v.string(),
    source: v.any(),
    fleet: v.any(),
    pipeline: v.any(),
    recent: v.any(),
    diagnostics: v.any(),
    schemaVersion: v.number(),
  }).index("by_generated_at", ["generatedAt"]),

  events: defineTable({
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
  })
    .index("by_received_at", ["receivedAt"])
    .index("by_repository_item", ["repository", "itemNumber"])
    .index("by_idempotency_key", ["idempotencyKey"]),

  runnerModeAudit: defineTable({
    changedAt: v.string(),
    email: v.string(),
    fromMode: v.union(v.string(), v.null()),
    toMode: v.string(),
    labels: v.array(v.string()),
    reviewRunner: v.union(v.string(), v.null()),
    sourceIp: v.union(v.string(), v.null()),
    source: v.string(),
  })
    .index("by_changed_at", ["changedAt"])
    .index("by_email", ["email"]),
});
