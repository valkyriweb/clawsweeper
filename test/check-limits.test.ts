import assert from "node:assert/strict";
import test from "node:test";

import {
  buildExpectations,
  deriveAutomationLimits,
  escapeRegExp,
  flattenLimits,
  isRecord,
  percent,
  runDriftCheck,
} from "../scripts/check-limits.ts";

function cfg(max: number) {
  return {
    workers: { max, reserve_for_interactive: 0, expansion_reserve: 0, minimum_background: 0 },
  };
}

test("percent floors to an integer and never drops below 1", () => {
  assert.equal(percent(100, 70), 70);
  assert.equal(percent(100, 5), 5);
  assert.equal(percent(10, 70), 7);
  assert.equal(percent(3, 70), 2); // floor(2.1)
  assert.equal(percent(10, 5), 1); // floor(0.5) -> 0 -> clamped to 1
  assert.equal(percent(10, 4), 1); // floor(0.4) -> 0 -> clamped to 1
  assert.equal(percent(1, 70), 1); // floor(0.7) -> 0 -> clamped to 1
});

test("deriveAutomationLimits scales every limit from workers.max", () => {
  assert.deepEqual(deriveAutomationLimits(cfg(100)), {
    review_shards: {
      normal_default: 70,
      normal_active_floor: 30,
      hot_intake_default: 35,
      exact_item_default: 1,
      hard_cap: 100,
    },
    commit_review: { page_size_default: 5, page_size_hard_cap: 100 },
    repair_live_runs: {
      default: 40,
      hard_cap: 100,
      automerge_default: 40,
      issue_implementation_default: 40,
    },
    issue_implementation: { dispatches_per_sweep_default: 4 },
  });

  // Small fleets still get a working floor of 1 everywhere percent() would round to 0.
  assert.deepEqual(deriveAutomationLimits(cfg(10)), {
    review_shards: {
      normal_default: 7,
      normal_active_floor: 3,
      hot_intake_default: 3,
      exact_item_default: 1,
      hard_cap: 10,
    },
    commit_review: { page_size_default: 1, page_size_hard_cap: 10 },
    repair_live_runs: {
      default: 4,
      hard_cap: 10,
      automerge_default: 4,
      issue_implementation_default: 4,
    },
    issue_implementation: { dispatches_per_sweep_default: 1 },
  });
});

test("flattenLimits maps nested integers to dot-paths", () => {
  assert.deepEqual(flattenLimits({ a: 1, b: { c: 2, d: 3 } }), { a: 1, "b.c": 2, "b.d": 3 });
  assert.deepEqual(flattenLimits({ workers: { max: 24, reserve_for_interactive: 2 } }), {
    "workers.max": 24,
    "workers.reserve_for_interactive": 2,
  });
});

test("flattenLimits excludes non-integer and non-number children (regression for the unknown->number fix)", () => {
  // Floats, strings, and booleans must NOT be coerced into the number map; only
  // integer leaves survive. Objects keep recursing. This pins the Number.isInteger
  // guard added alongside the scripts typecheck (PR #101).
  assert.deepEqual(flattenLimits({ a: 1, b: 2.5, c: "x", d: true, e: { f: 4 } }), {
    a: 1,
    "e.f": 4,
  });
  // Non-record and array inputs flatten to nothing.
  assert.deepEqual(flattenLimits(42), {});
  assert.deepEqual(flattenLimits(null), {});
  assert.deepEqual(flattenLimits([1, 2, 3]), {});
  assert.deepEqual(flattenLimits({ a: [1, 2] }), {});
});

test("isRecord accepts plain objects and rejects null, arrays, and primitives", () => {
  assert.equal(isRecord({}), true);
  assert.equal(isRecord({ a: 1 }), true);
  assert.equal(isRecord(null), false);
  assert.equal(isRecord([]), false);
  assert.equal(isRecord([1]), false);
  assert.equal(isRecord(42), false);
  assert.equal(isRecord("x"), false);
  assert.equal(isRecord(undefined), false);
  assert.equal(isRecord(true), false);
});

test("escapeRegExp escapes regex metacharacters and round-trips", () => {
  assert.equal(escapeRegExp("review_shards.normal_default"), "review_shards\\.normal_default");
  assert.equal(escapeRegExp("a.b+c*d"), "a\\.b\\+c\\*d");
  assert.equal(new RegExp(escapeRegExp("a.b")).test("a.b"), true);
  assert.equal(new RegExp(escapeRegExp("a.b")).test("aXb"), false);
});

test("buildExpectations covers static docs plus every flattened limit and config value", () => {
  const config = cfg(24);
  const limits = deriveAutomationLimits(config);
  const expectations = buildExpectations(limits, config);
  assert.ok(expectations.length > 9);
  for (const e of expectations) {
    assert.equal(typeof e.file, "string");
    assert.equal(typeof e.label, "string");
    assert.ok(e.pattern instanceof RegExp);
  }
  assert.ok(
    expectations.some(
      (e) => e.file === "docs/limits.md" && e.label.startsWith("review_shards.normal_default"),
    ),
  );
  assert.ok(
    expectations.some((e) => e.file === "docs/limits.md" && e.label.startsWith("workers.max")),
  );
});

test("runDriftCheck reports no drift on this repo's own docs and config", () => {
  assert.deepEqual(runDriftCheck(), []);
});
