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

// ---- watchdog detectors -----------------------------------------------------
import { aggregatesForSystem } from "../scan.js";

function rawInsert(db, sys, seq, tsServer, action, payload = "") {
  db.prepare(`INSERT INTO log_entries
    (system_id, seq, event_id, ts_client, ts_server, category, action, payload_json, prev_hash, entry_hash)
    VALUES (?, ?, ?, ?, ?, '', ?, ?, 'x', 'x')`)
    .run(sys, seq, `raw-${sys}-${seq}`, tsServer, tsServer, action, payload);
}

test("watchdog: weekend burst and big export are detected", () => {
  const db = tempDb();
  const now = Date.parse("2026-07-20T12:00:00Z"); // a Monday
  let seq = 0;
  // Baseline: quiet weekday business-hours activity (10:00 UTC), no off-hours history
  for (let d = 14; d >= 2; d--) {
    const day = new Date(now - d * 86400000).toISOString().slice(0, 10);
    rawInsert(db, "s", ++seq, `${day}T10:00:00.000Z`, "crm.order.created");
  }
  // Sunday evening burst (inside last 24h, weekend => off-hours)
  for (let i = 0; i < 6; i++) {
    rawInsert(db, "s", ++seq, `2026-07-19T20:0${i}:00.000Z`, "crm.order.modified");
  }
  // A big export
  rawInsert(db, "s", ++seq, "2026-07-20T09:00:00.000Z", "crm.contacts.export", JSON.stringify({ rows: 5000 }));

  const kinds = aggregatesForSystem(db, "s", now).map((a) => a.kind);
  assert.ok(kinds.includes("off_hours"), `expected off_hours in ${kinds}`);
  assert.ok(kinds.includes("big_export"), `expected big_export in ${kinds}`);
});

test("watchdog: delete spike is its own kind", () => {
  const db = tempDb();
  const now = Date.parse("2026-07-22T12:00:00Z");
  let seq = 0;
  for (let d = 14; d >= 2; d--) {
    const day = new Date(now - d * 86400000).toISOString().slice(0, 10);
    rawInsert(db, "s", ++seq, `${day}T10:00:00.000Z`, "crm.Invoice.deleted");
  }
  for (let i = 0; i < 15; i++) {
    rawInsert(db, "s", ++seq, "2026-07-22T10:00:01.000Z", "crm.Invoice.deleted");
  }
  const aggs = aggregatesForSystem(db, "s", now);
  assert.ok(aggs.some((a) => a.kind === "delete_spike"), JSON.stringify(aggs));
});

// The bug this guards: dedupe used to key on the warning's TITLE. With an AI
// key the model rewords the same condition every night, so nothing matched and
// a persisting problem refiled daily. One live system reached 200+ warnings
// covering about two real conditions, and acknowledgements never stuck.
import { runScan, warningsFromAggregates, fingerprintOf } from "../scan.js";

function silentSystemDb() {
  const db = tempDb();
  const now = Date.parse("2026-07-20T12:00:00Z");
  let seq = 0;
  // A steady baseline that then stops: "system_silent" plus "action_silent".
  for (let d = 15; d >= 3; d--) {
    const day = new Date(now - d * 86400000).toISOString().slice(0, 10);
    for (let i = 0; i < 6; i++) rawInsert(db, "s", ++seq, `${day}T10:0${i}:00.000Z`, "fm.field.edited");
  }
  return { db, now };
}

test("dedupe survives an AI that rewords the same finding every scan", async () => {
  const { db, now } = silentSystemDb();
  // Same detector output each night; only the wording changes, as a model does.
  const wordings = [
    "Login activity stopped entirely",
    "Login activity silent",
    "Logins and logouts both silent",
    "Field edits dropped to zero",
  ];
  let call = 0;
  const reworder = async (systemId, aggregates) =>
    warningsFromAggregates(aggregates).map((w) => ({ ...w, title: `${wordings[call++ % wordings.length]} #${call}` }));

  for (let day = 0; day < 4; day++) {
    await runScan(db, { aiFindings: reworder, force: true, now: now + day * 86400000 });
  }
  const rows = db.prepare("SELECT title, fingerprint FROM warnings").all();
  const distinctTitles = new Set(rows.map((r) => r.title)).size;
  const distinctPrints = new Set(rows.map((r) => r.fingerprint)).size;

  assert.equal(rows.length, distinctPrints,
    `one row per condition; got ${rows.length} rows for ${distinctPrints} conditions`);
  assert.ok(distinctTitles <= distinctPrints,
    "rewording must not create extra rows");
});

test("an acknowledged finding stays acknowledged when reworded", async () => {
  const { db, now } = silentSystemDb();
  const say = (t) => async (systemId, aggregates) =>
    warningsFromAggregates(aggregates).map((w) => ({ ...w, title: t }));

  await runScan(db, { aiFindings: say("System has gone quiet"), force: true, now });
  db.prepare("UPDATE warnings SET status = 'acknowledged'").run();
  const acked = db.prepare("SELECT COUNT(*) AS n FROM warnings").get().n;

  // Next scan, same conditions, brand-new words.
  await runScan(db, { aiFindings: say("No activity detected at all"), force: true, now: now + 3600000 });

  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM warnings").get().n, acked,
    "a recently acknowledged finding must not come back under a new name");
});

test("fingerprint comes from the detector, not the words", () => {
  const a = { kind: "action_silent", action: "fm.field.edited", system_id: "s" };
  assert.equal(
    fingerprintOf({ title: "Field edits stopped", evidence: a }),
    fingerprintOf({ title: "Editing has flatlined", evidence: a }),
    "same evidence, different wording, same fingerprint");
  assert.notEqual(
    fingerprintOf({ title: "x", evidence: a }),
    fingerprintOf({ title: "x", evidence: { ...a, action: "fm.login" } }),
    "different action is a different finding");
  assert.equal(fingerprintOf({ title: "orphan", evidence: null }), "title:orphan",
    "no evidence falls back to the title");
});


// diffRecords used to union the old and new payload keys, so a field missing
// from the new payload read as {from: value, to: null}: "cleared". The
// per-table calc sends only Get(ModifiedFields), so most fields are absent
// from most commits, and every ordinary edit claimed the primary key was wiped.
// Live evidence that prompted this: clio-demo-db entry seq 2 reported
// changed.ID = {from: "C57737C4-...", to: null} on a commit that only set Name.
import { diffRecords } from "../diff.js";

test("a partial payload does not report untouched fields as cleared", () => {
  const prev = { ID: "C57737C4", id: "C57737C4", z_ModifiedTS: "3:25:20 PM" };
  const next = { Name: "Acme", id: "C57737C4", z_ModifiedTS: "3:25:23 PM" };
  const d = diffRecords(prev, next);

  assert.ok(!("ID" in d), "ID was absent from the new payload, not cleared");
  assert.deepEqual(d.Name, { from: null, to: "Acme" }, "a newly reported field reads as a change");
  assert.deepEqual(d.z_ModifiedTS, { from: "3:25:20 PM", to: "3:25:23 PM" });
});

test("a field actually cleared still reports as cleared", () => {
  // FileMaker sends a wiped field as present-and-empty, so the key is there.
  const d = diffRecords({ Name: "Acme", id: "x" }, { Name: "", id: "x" });
  assert.deepEqual(d.Name, { from: "Acme", to: "" }, "emptied is not the same as omitted");
  assert.ok(!("id" in d), "unchanged fields stay out of the diff");
});
