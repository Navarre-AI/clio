# The Clio chain

The auditable spec. Everything here is implemented in `chain.js` and covered
by `test/chain.test.js`.

## What gets stored

Each log entry, per system:

```
system_id     the chain this entry belongs to (determined by the API key)
seq           1-based, dense, assigned by Clio in arrival order
event_id      client-supplied UUID; duplicate event_ids are skipped silently
ts_client     the client's clock, stored and hashed exactly as received
ts_server     Clio's clock (ISO 8601), assigned at ingest
category      e.g. "crm.order"
action        e.g. "crm.order.created"
payload_json  a JSON string; stringified exactly once at ingest, never re-serialized
prev_hash     the previous entry's hash (64 hex); genesis links to 64 zeros
entry_hash    this entry's hash
```

## The hash

Canonical form is a fixed-order JSON array, so serialization is deterministic
with no canonical-JSON library:

```
canonical = JSON.stringify([seq, system_id, event_id, ts_client, ts_server,
                            category, action, payload_json])
entry_hash = sha256hex(prev_hash + "\n" + canonical)
```

Genesis: for seq 1, `prev_hash` is 64 zero characters. Each `system_id` is an
independent chain from its own genesis.

## Ingest

One SQLite transaction per batch: read the head, then for each entry in array
order, skip it if its `event_id` already exists for this system, otherwise
assign the next seq, stamp `ts_server`, hash, insert. SQLite's single-writer
model makes seq assignment race-free. Retried batches (the shippers are
fire-and-forget) can never fork or gap a chain; duplicates are just counted.

Append-only is enforced three ways: no update or delete code path exists, the
schema carries BEFORE UPDATE / BEFORE DELETE triggers that abort, and the AI
query path runs on a read-only database handle.

## Verify

`GET /v1/verify` walks the chain from seq 1 (or `from_seq`), recomputing every
hash and checking density (a missing seq is a break). It reports `valid`,
`checked`, and `first_bad_seq`. Given `expect_seq` + `expect_hash` (a stored
anchor), it also reports `anchor_match`: is the chain intact through that seq,
and does the stored hash there equal the anchored one.

## The anchor, and the threat model

Every hash covers its content and its predecessor's hash, so altering,
inserting, or deleting any entry at or before seq N changes every hash from
that point forward, including the head at N. The daily anchor script stores
`(seq, entry_hash)` inside the customer's own FileMaker file, a system the
Clio operator cannot write to. A rewritten history cannot reproduce the
anchored hash (sha256 preimage resistance), so verification against any past
anchor fails and the anchor script raises the alarm.

**Stated limitation.** The operator can silently truncate entries newer than
the latest anchor; verification cannot see what was never anchored. The
exposure window is bounded by the anchor interval: daily by default, run the
anchor schedule hourly to shrink it. Truncation at or below an anchored seq is
always caught (the anchored seq no longer exists or no longer matches).

A second, softer anchor: every batch response returns the new head, and
shipper stdout logs remain a parallel record outside the database.
