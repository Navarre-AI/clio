import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { openDb } from "../db.js";
import { appendBatch, head, verifyRange, entryHash, GENESIS } from "../chain.js";

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clio-test-"));
  return openDb(path.join(dir, "clio.db"));
}

const entry = (n, extra = {}) => ({
  event_id: `evt-${n}`,
  ts_client: "2026-07-23T10:00:00.000Z",
  category: "test.things",
  action: "test.things.happened",
  payload_json: JSON.stringify({ n }),
  ...extra,
});

test("genesis and linkage", () => {
  const db = tempDb();
  const r = appendBatch(db, "sysA", [entry(1), entry(2)]);
  assert.equal(r.accepted, 2);
  assert.equal(r.head.seq, 2);

  const rows = db.prepare("SELECT * FROM log_entries WHERE system_id='sysA' ORDER BY seq").all();
  assert.equal(rows[0].prev_hash, GENESIS);
  assert.equal(rows[1].prev_hash, rows[0].entry_hash);
  assert.equal(rows[0].entry_hash, entryHash(GENESIS, rows[0]));
  assert.equal(rows[1].entry_hash, entryHash(rows[0].entry_hash, rows[1]));
});

test("chains are independent per system", () => {
  const db = tempDb();
  appendBatch(db, "sysA", [entry(1)]);
  appendBatch(db, "sysB", [entry(1)]);
  assert.equal(head(db, "sysA").seq, 1);
  assert.equal(head(db, "sysB").seq, 1);
  assert.equal(db.prepare("SELECT prev_hash FROM log_entries WHERE system_id='sysB'").get().prev_hash, GENESIS);
});

test("duplicate event_ids are skipped, across batches and within one", () => {
  const db = tempDb();
  const r1 = appendBatch(db, "sysA", [entry(1), entry(1)]);
  assert.equal(r1.accepted, 1);
  assert.equal(r1.duplicates, 1);
  const r2 = appendBatch(db, "sysA", [entry(1), entry(2)]); // retried batch
  assert.equal(r2.accepted, 1);
  assert.equal(r2.duplicates, 1);
  assert.equal(head(db, "sysA").seq, 2);
  assert.ok(verifyRange(db, "sysA").valid);
});

test("object payloads are stringified exactly once and hash stable", () => {
  const db = tempDb();
  appendBatch(db, "sysA", [entry(1, { payload_json: { deep: { thing: true } } })]);
  const row = db.prepare("SELECT * FROM log_entries WHERE system_id='sysA'").get();
  assert.equal(row.payload_json, JSON.stringify({ deep: { thing: true } }));
  assert.ok(verifyRange(db, "sysA").valid);
});

test("append-only triggers refuse UPDATE and DELETE", () => {
  const db = tempDb();
  appendBatch(db, "sysA", [entry(1)]);
  assert.throws(() => db.exec("UPDATE log_entries SET action='rewritten'"), /append-only/);
  assert.throws(() => db.exec("DELETE FROM log_entries"), /append-only/);
});

test("verify walks clean chains and reports heads", () => {
  const db = tempDb();
  appendBatch(db, "sysA", Array.from({ length: 50 }, (_, i) => entry(i)));
  const v = verifyRange(db, "sysA");
  assert.equal(v.valid, true);
  assert.equal(v.checked, 50);
  assert.equal(v.first_bad_seq, null);
  assert.equal(v.head.seq, 50);
});

test("verify catches a rewritten entry", () => {
  const db = tempDb();
  appendBatch(db, "sysA", Array.from({ length: 10 }, (_, i) => entry(i)));
  db.exec("DROP TRIGGER log_no_update"); // simulate an attacker with DB access
  db.exec("UPDATE log_entries SET payload_json='{\"n\":999}' WHERE seq=4");
  const v = verifyRange(db, "sysA");
  assert.equal(v.valid, false);
  assert.equal(v.first_bad_seq, 4);
});

test("verify catches a deleted entry (gap)", () => {
  const db = tempDb();
  appendBatch(db, "sysA", Array.from({ length: 10 }, (_, i) => entry(i)));
  db.exec("DROP TRIGGER log_no_delete");
  db.exec("DELETE FROM log_entries WHERE seq=6");
  const v = verifyRange(db, "sysA");
  assert.equal(v.valid, false);
  assert.equal(v.first_bad_seq, 6);
});

test("anchor match: intact chain matches its anchored head, tampered does not", () => {
  const db = tempDb();
  appendBatch(db, "sysA", Array.from({ length: 5 }, (_, i) => entry(i)));
  const anchored = head(db, "sysA"); // what FileMaker stored that day
  appendBatch(db, "sysA", Array.from({ length: 5 }, (_, i) => entry(100 + i)));

  const good = verifyRange(db, "sysA", { expectSeq: anchored.seq, expectHash: anchored.entry_hash });
  assert.equal(good.anchor_match, true);

  db.exec("DROP TRIGGER log_no_update");
  db.exec("UPDATE log_entries SET action='rewritten' WHERE seq=3"); // before the anchor
  const bad = verifyRange(db, "sysA", { expectSeq: anchored.seq, expectHash: anchored.entry_hash });
  assert.equal(bad.anchor_match, false);
  assert.equal(bad.first_bad_seq, 3);
});

test("anchor match: truncation below the anchor is detected", () => {
  const db = tempDb();
  appendBatch(db, "sysA", Array.from({ length: 5 }, (_, i) => entry(i)));
  const anchored = head(db, "sysA");
  db.exec("DROP TRIGGER log_no_delete");
  db.exec("DELETE FROM log_entries WHERE seq > 3"); // operator quietly truncates
  const v = verifyRange(db, "sysA", { expectSeq: anchored.seq, expectHash: anchored.entry_hash });
  assert.equal(v.anchor_match, false);
});

test("tamper after the anchor: anchor still matches, chain reports the break", () => {
  const db = tempDb();
  appendBatch(db, "sysA", Array.from({ length: 5 }, (_, i) => entry(i)));
  const anchored = head(db, "sysA");
  appendBatch(db, "sysA", Array.from({ length: 5 }, (_, i) => entry(100 + i)));
  db.exec("DROP TRIGGER log_no_update");
  db.exec("UPDATE log_entries SET action='rewritten' WHERE seq=8"); // after the anchor
  const v = verifyRange(db, "sysA", { expectSeq: anchored.seq, expectHash: anchored.entry_hash });
  assert.equal(v.valid, false);
  assert.equal(v.first_bad_seq, 8);
  assert.equal(v.anchor_match, true); // history through the anchor is still intact
});
