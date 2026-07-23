// chain.js: the tamper-evident core. Full spec and threat model in CHAIN.md.
//
// Each system_id is an independent hash chain. Every entry's hash covers its
// own canonical content AND the previous entry's hash, so changing anything
// at seq <= N changes every hash from N forward, including the head that the
// customer anchors inside their own FileMaker file daily.

import { createHash, randomUUID } from "node:crypto";

export const GENESIS = "0".repeat(64);

export function sha256Hex(s) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

// Canonical form: a fixed-order JSON array. JSON.stringify of an array is
// deterministic (no key-order question), so no canonical-JSON library needed.
// payload_json is hashed exactly as stored: stringified once at ingest,
// never re-serialized after.
export function canonical(e) {
  return JSON.stringify([
    e.seq, e.system_id, e.event_id, e.ts_client, e.ts_server,
    e.category, e.action, e.payload_json,
  ]);
}

export function entryHash(prevHash, e) {
  return sha256Hex(prevHash + "\n" + canonical(e));
}

export function head(db, systemId) {
  const row = db.prepare(
    "SELECT seq, entry_hash, ts_server FROM log_entries WHERE system_id = ? ORDER BY seq DESC LIMIT 1"
  ).get(systemId);
  if (!row) return { system_id: systemId, seq: 0, entry_hash: null, entry_count: 0, last_ts_server: null };
  return {
    system_id: systemId, seq: row.seq, entry_hash: row.entry_hash,
    entry_count: row.seq, last_ts_server: row.ts_server,
  };
}

// One SQLite transaction per batch. Single-writer SQLite makes seq assignment
// race-free with no extra machinery. Duplicates (same system_id + event_id,
// e.g. a retried batch) are skipped silently and counted, so retries never
// fork or gap the chain. Entries append in array order.
export function appendBatch(db, systemId, entries) {
  const insert = db.prepare(
    `INSERT INTO log_entries
       (system_id, seq, event_id, ts_client, ts_server, category, action, payload_json, prev_hash, entry_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const exists = db.prepare(
    "SELECT 1 AS x FROM log_entries WHERE system_id = ? AND event_id = ? LIMIT 1"
  );

  db.exec("BEGIN IMMEDIATE");
  try {
    let { seq, entry_hash: prevHash } = head(db, systemId);
    if (!prevHash) prevHash = GENESIS;
    let accepted = 0, duplicates = 0;
    const seenInBatch = new Set();

    for (const raw of entries) {
      const eventId = str(raw.event_id) || randomUUID();
      if (seenInBatch.has(eventId) || exists.get(systemId, eventId)) { duplicates++; continue; }
      seenInBatch.add(eventId);
      const e = {
        seq: ++seq,
        system_id: systemId,
        event_id: eventId,
        ts_client: str(raw.ts_client),
        ts_server: new Date().toISOString(),
        category: str(raw.category),
        action: str(raw.action),
        // Exactly one stringify if the client sent an object; strings pass through.
        payload_json: typeof raw.payload_json === "object" && raw.payload_json !== null
          ? JSON.stringify(raw.payload_json) : str(raw.payload_json),
      };
      e.prev_hash = prevHash;
      e.entry_hash = entryHash(prevHash, e);
      insert.run(e.system_id, e.seq, e.event_id, e.ts_client, e.ts_server,
        e.category, e.action, e.payload_json, e.prev_hash, e.entry_hash);
      prevHash = e.entry_hash;
      accepted++;
    }

    db.exec("COMMIT");
    return { accepted, duplicates, head: { seq, entry_hash: seq === 0 ? null : prevHash } };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// Walk the chain recomputing every hash. Returns the first broken seq, if any.
// With expectSeq/expectHash (a stored FileMaker anchor), also reports whether
// the chain still matches that anchor: intact through expectSeq AND the stored
// hash there equals the anchored one.
export function verifyRange(db, systemId, { fromSeq = 1, expectSeq = null, expectHash = null } = {}) {
  const rows = db.prepare(
    `SELECT seq, system_id, event_id, ts_client, ts_server, category, action, payload_json, prev_hash, entry_hash
     FROM log_entries WHERE system_id = ? AND seq >= ? ORDER BY seq`
  ).all(systemId, fromSeq);

  let prevHash = GENESIS;
  if (fromSeq > 1) {
    const prev = db.prepare(
      "SELECT entry_hash FROM log_entries WHERE system_id = ? AND seq = ?"
    ).get(systemId, fromSeq - 1);
    prevHash = prev ? prev.entry_hash : null; // null: missing predecessor is itself a break
  }

  let valid = true, firstBadSeq = null, checked = 0;
  let expectedSeq = fromSeq;
  let anchorSeen = null;

  if (prevHash === null) {
    valid = false; firstBadSeq = fromSeq - 1;
  } else {
    for (const row of rows) {
      checked++;
      // Density: a gap in seq means entries vanished.
      if (row.seq !== expectedSeq) { valid = false; firstBadSeq = expectedSeq; break; }
      if (row.prev_hash !== prevHash || entryHash(prevHash, row) !== row.entry_hash) {
        valid = false; firstBadSeq = row.seq; break;
      }
      if (expectSeq !== null && row.seq === Number(expectSeq)) anchorSeen = row.entry_hash;
      prevHash = row.entry_hash;
      expectedSeq++;
    }
  }

  const h = head(db, systemId);
  let anchorMatch = null;
  if (expectSeq !== null && expectHash !== null) {
    const intactThroughAnchor = valid || (firstBadSeq !== null && firstBadSeq > Number(expectSeq));
    anchorMatch = intactThroughAnchor && anchorSeen === expectHash;
  }
  return {
    system_id: systemId, valid, checked,
    first_bad_seq: firstBadSeq,
    head: { seq: h.seq, entry_hash: h.entry_hash },
    anchor_match: anchorMatch,
  };
}

function str(v) {
  if (v === undefined || v === null) return "";
  return String(v);
}
