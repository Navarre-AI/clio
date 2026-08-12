// buildArtifacts turns the model's block spec plus the rows it queried into the
// tiles and charts on screen. The model supplies ONE label per block, so a block
// whose query returned several rows must label each tile from its own row. It
// did not, and the public demo showed two tiles that both said "TOTAL INVOICE
// EVENTS (7D)", one over 716 and one over 83. These tests hold that shut.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildArtifactsForTest } from "../ai.js";

const kpi = (spec, queryLog) => buildArtifactsForTest(spec, queryLog).find((a) => a.type === "kpi");

test("a multi-row kpi labels every tile from its own row", () => {
  const out = kpi(
    { blocks: [{ type: "kpi", queryIndex: 0, label: "Total invoice events (7d)" }] },
    [{ columns: ["action", "n"], rows: [{ action: "Invoices.modified", n: 716 }, { action: "Invoices.new", n: 83 }] }]
  );
  assert.deepEqual(out.cells.map((c) => c.label), ["Invoices.modified", "Invoices.new"]);
  assert.deepEqual(out.cells.map((c) => c.value), [716, 83]);
  // The block label described the whole block, so it must not be stamped on a tile.
  assert.ok(!out.cells.some((c) => c.label === "Total invoice events (7d)"));
});

test("a single-row kpi keeps the model's block label", () => {
  const out = kpi(
    { blocks: [{ type: "kpi", queryIndex: 0, label: "Deleted invoices, 30 days" }] },
    [{ columns: ["action", "n"], rows: [{ action: "Invoices.deleted", n: 5 }] }]
  );
  assert.deepEqual(out.cells, [{ label: "Deleted invoices, 30 days", value: 5 }]);
});

test("labelColumn wins when the model names one", () => {
  const out = kpi(
    { blocks: [{ type: "kpi", queryIndex: 0, labelColumn: "person", label: "Ignored" }] },
    [{ columns: ["person", "action", "n"], rows: [{ person: "Miriam Vance", action: "x", n: 4 }, { person: "Carl Foster", action: "y", n: 2 }] }]
  );
  assert.deepEqual(out.cells.map((c) => c.label), ["Miriam Vance", "Carl Foster"]);
});

test("a missing label falls back to a VALUE, never to a column name", () => {
  const out = kpi(
    { blocks: [{ type: "kpi", queryIndex: 0 }] },
    [{ columns: ["week", "n"], rows: [{ week: "2026-07-06", n: 639 }, { week: "2026-07-13", n: 593 }] }]
  );
  assert.deepEqual(out.cells.map((c) => c.label), ["2026-07-06", "2026-07-13"]);
  assert.ok(!out.cells.some((c) => c.label === "week"), "column NAME must never become a tile label");
});

test("a blank row label does not produce an empty tile", () => {
  const out = kpi(
    { blocks: [{ type: "kpi", queryIndex: 0, label: "Events" }] },
    [{ columns: ["action", "n"], rows: [{ action: "  ", n: 7 }, { action: null, n: 3 }] }]
  );
  assert.ok(out.cells.every((c) => c.label && c.label.trim()), "every tile needs a label");
});

test("the two-tile cap still holds", () => {
  const out = kpi(
    { blocks: [{ type: "kpi", queryIndex: 0 }] },
    [{ columns: ["action", "n"], rows: [
      { action: "a", n: 1 }, { action: "b", n: 2 }, { action: "c", n: 3 }, { action: "d", n: 4 }
    ] }]
  );
  assert.equal(out.cells.length, 2);
});
