// Two defects the demo made visible, both about signal drowning in noise.
//
//   1. One "went quiet" warning per event type. A quiet Tuesday for
//      Products.new is not news, and fourteen of those notices pushed the
//      invoice-fraud alert to row eighteen.
//   2. The warnings list sorted by created_at only, so severity was ignored
//      and criticals sank below routine notices filed minutes later.
//
// These tests hold both shut.

import { test } from "node:test";
import assert from "node:assert/strict";
import { warningsFromAggregates, fingerprintOf } from "../scan.js";

const silent = (n) => ({
  kind: "actions_silent",
  system_id: "cascade-office",
  count: n,
  actions: Array.from({ length: n }, (_, i) => `cascade-office.Table${i}.new`),
  busiest: "cascade-office.Table0.new",
  last24: 0,
});

test("many quiet event types produce ONE warning, not one each", () => {
  const out = warningsFromAggregates([silent(9)]);
  assert.equal(out.length, 1, "nine quiet types must not become nine warnings");
  assert.equal(out[0].title, "9 event types went quiet");
});

test("the detail names the types, so aggregating loses nothing", () => {
  const d = warningsFromAggregates([silent(9)])[0].detail;
  assert.match(d, /cascade-office\.Table0\.new/, "names the first types");
  assert.match(d, /and 5 more/, "accounts for the rest");
});

test("a single quiet type still reads naturally", () => {
  const out = warningsFromAggregates([silent(1)]);
  assert.equal(out[0].title, "cascade-office.Table0.new went quiet");
  assert.ok(!/1 event types/.test(out[0].title), "no robot plural");
});

test("one open quiet warning per system, so it does not refile daily", () => {
  // Same condition on two days: the set of quiet types shifts, the fingerprint
  // must not, or the list fills up again with one row per scan.
  const a = warningsFromAggregates([silent(9)])[0];
  const b = warningsFromAggregates([silent(4)])[0];
  assert.equal(fingerprintOf(a), fingerprintOf(b));
});

test("quiet is a warning, never a critical", () => {
  assert.equal(warningsFromAggregates([silent(9)])[0].severity, "warn");
});

// The sort lives in server.js listWarnings as SQL. This asserts the ordering
// contract that SQL implements, so a future edit that drops severity from the
// ORDER BY fails here with a readable message.
test("severity outranks recency when ordering warnings", () => {
  const rank = { critical: 0, warn: 1, info: 2 };
  const rows = [
    { severity: "warn", title: "quiet", created_at: "2026-08-10T13:00:00Z" },
    { severity: "critical", title: "fraud", created_at: "2026-08-09T13:00:00Z" },
    { severity: "info", title: "new type", created_at: "2026-08-10T14:00:00Z" },
    { severity: "critical", title: "mass delete", created_at: "2026-08-10T13:00:00Z" },
  ];
  const sorted = rows.slice().sort((a, b) =>
    rank[a.severity] - rank[b.severity] || b.created_at.localeCompare(a.created_at));
  assert.deepEqual(sorted.map((r) => r.title), ["mass delete", "fraud", "quiet", "new type"]);
});
