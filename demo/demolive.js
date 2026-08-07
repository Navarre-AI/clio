// demolive.js: the demo's live trickle.
//
// A log viewer showing a frozen file looks like a screenshot. So, in DEMO_MODE
// only, each visitor gets their own small stream of new entries: it starts ~10
// seconds after they arrive, adds a few entries every 5 seconds, and stops
// after a minute. Ambient activity, nothing plot-relevant: no new fraud, no new
// warnings, just Tuesday afternoon at Cascade Office Supply.
//
// It does NOT touch the database. The entries live in the visitor's session
// (demosession.js) and are merged into reads, so the baked 100k-entry dataset
// is byte-identical for the next visitor, and the read-only guarantee that the
// whole demo rests on is untouched.
//
// They ARE properly hash-chained, though (option (a) of the two we considered):
// each one takes the real chain head of its system as prev_hash and is hashed
// with chain.js's own entryHash, so "verify this chain" in a session that has
// seen the trickle walks the baseline AND the new entries and still comes back
// valid. Showing unchained rows in a product whose entire claim is that every
// row is chained would have been the wrong kind of demo.
//
// Generation is deterministic in (session id, burst index): the same session
// asking twice gets the same entries, so a poll, a reload, and a chain verify
// all agree.

import { createHash } from "node:crypto";
import { entryHash, head } from "../chain.js";

const FIRST_MS = Number(process.env.DEMO_LIVE_FIRST_MS || 10000); // first burst
const EVERY_MS = Number(process.env.DEMO_LIVE_EVERY_MS || 5000);  // then every
const BURSTS = Number(process.env.DEMO_LIVE_BURSTS || 11);        // ~60s, then done

const MAIN = "cascade-office", STORE = "alder-street";
const FILE = "CascadeOps", STORE_FILE = "AlderPOS";

// The same people who are already in the log, so the actor filter, the rules
// and the history all keep working on the new rows.
const STAFF = [
  ["Teresa Morales", "tmorales", "sales"], ["Jason Chen", "jchen", "sales"],
  ["Beata Kowalski", "bkowalski", "sales"], ["Sam Price", "sprice", "sales"],
  ["Rafael Gutierrez", "rgutierrez", "warehouse"], ["Lena Nakamura", "lnakamura", "warehouse"],
  ["Paulo Diaz", "pdiaz", "warehouse"], ["Miriam Vance", "mvance", "accounting"],
  ["Aaron Whitaker", "awhitaker", "accounting"], ["Holly Bennett", "hbennett", "service"],
  ["Eli Crane", "ecrane", "service"], ["Carl Foster", "cfoster", "manager"],
];
const CLERKS = [
  ["Nadia Rivas", "nrivas"], ["Blessing Okafor", "bokafor"], ["Tove Lindqvist", "tlindqvist"],
];
const CUSTOMERS = [
  "Bluewater Dental", "Marigold Bakery", "Cedar Loop Coffee", "Riverbend Vet Clinic",
  "Harbor Light Optical", "Meridian Engineering", "Westfall Insurance", "Redpoint Climbing",
  "Silver Fir Landscaping", "Oakhurst Academy", "Quarry Rock Gym", "Solstice Yoga",
];
const PRODUCTS = [
  ["CP-500", "Copy Paper A4 500-sheet"], ["TN-77K", "Toner 77K Black"], ["CH-ERG", "Ergo Task Chair"],
  ["PN-BLU", "Gel Pens Blue 12pk"], ["BX-M", "Moving Box Medium"], ["MK-DRY", "Dry-Erase Markers 8pk"],
];
const REPORTS = ["Daily Sales Summary", "Open Orders", "Inventory Reorder", "AR Aging"];

// Deterministic per (session, burst, index) pseudo-randomness.
function rng(seed) {
  let h = createHash("sha256").update(seed).digest();
  let i = 0;
  return () => {
    if (i >= 28) { h = createHash("sha256").update(h).digest(); i = 0; }
    const v = h.readUInt32BE(i); i += 4;
    return v / 4294967296;
  };
}
const pick = (r, a) => a[Math.floor(r() * a.length)];
const int = (r, a, b) => a + Math.floor(r() * (b - a + 1));

// One plausible event. `sys` decides which system it belongs to.
function makeEvent(r, tMs) {
  const store = r() < 0.3;
  const at = new Date(tMs).toISOString();
  if (store) {
    const [name, acct] = pick(r, CLERKS);
    const roll = r();
    if (roll < 0.14) {
      return { sys: STORE, category: "auth", action: "auth.login",
        payload: { account_name: name, account: acct, client: "Go" } };
    }
    if (roll < 0.2) {
      const mins = int(r, 95, 420);
      return { sys: STORE, category: "auth", action: "auth.logout",
        payload: { account_name: name, account: acct, client: "Go",
          duration_minutes: mins, duration: `${Math.floor(mins / 60)}h ${mins % 60}m` } };
    }
    if (roll < 0.72) {
      return { sys: STORE, category: `${STORE}.data`, action: `${STORE}.Sales.new`,
        payload: { file: STORE_FILE, table: "Sales", record_id: 41000 + int(r, 1, 900),
          account_name: name, account: acct,
          data: { ticket: 89000 + int(r, 1, 900), total: Math.round(r() * 16000) / 100,
            tender: pick(r, ["card", "cash", "account"]), items: int(r, 1, 7), clerk: name } } };
    }
    const [sku, item] = pick(r, PRODUCTS);
    const on_hand = int(r, 0, 180);
    return { sys: STORE, category: `${STORE}.data`, action: `${STORE}.Inventory.modified`,
      payload: { file: STORE_FILE, table: "Inventory", record_id: 6000 + int(r, 1, 700),
        account_name: name, account: acct, data: { sku, item, on_hand, bin: `S-${int(r, 1, 18)}` },
        changed: { on_hand: { from: on_hand + int(r, 1, 12), to: on_hand } } } };
  }

  const [name, acct, role] = pick(r, STAFF);
  const roll = r();
  if (roll < 0.08) {
    return { sys: MAIN, category: "auth", action: "auth.login",
      payload: { account_name: name, account: acct, client: r() < 0.15 ? "WebDirect" : "Pro" } };
  }
  if (roll < 0.13) {
    const mins = int(r, 120, 540);
    return { sys: MAIN, category: "auth", action: "auth.logout",
      payload: { account_name: name, account: acct, client: "Pro",
        duration_minutes: mins, duration: `${Math.floor(mins / 60)}h ${mins % 60}m` } };
  }
  if (roll < 0.2) {
    return { sys: MAIN, category: "report", action: "report.run",
      payload: { account_name: name, account: acct, report: pick(r, REPORTS) } };
  }
  const table = role === "warehouse" ? pick(r, ["Inventory", "Inventory", "Orders"])
    : role === "accounting" ? pick(r, ["Invoices", "Invoices", "Orders"])
    : pick(r, ["Orders", "Orders", "Customers", "Products"]);
  const op = roll < 0.34 ? "new" : roll < 0.52 ? "viewed" : "modified";
  const rec = { Orders: 11000, Customers: 4300, Inventory: 7600, Invoices: 9200, Products: 1500 }[table] + int(r, 1, 600);
  const data = table === "Orders"
    ? { order_number: 5200 + int(r, 1, 400), customer: pick(r, CUSTOMERS), status: pick(r, ["open", "picked", "shipped"]), total: Math.round(r() * 180000) / 100 }
    : table === "Customers"
      ? { customer_id: `C${rec}`, name: pick(r, CUSTOMERS), city: pick(r, ["Ridgefield", "Camas", "Kelso", "Woodland"]), terms: pick(r, ["Net 30", "Net 15", "COD"]) }
      : table === "Inventory"
        ? (() => { const [sku, item] = pick(r, PRODUCTS); return { sku, item, on_hand: int(r, 0, 700), bin: `${pick(r, ["A", "B", "C", "D"])}-${int(r, 1, 40)}` }; })()
        : table === "Invoices"
          ? { invoice_number: 3200 + int(r, 1, 120), customer: pick(r, CUSTOMERS), total: Math.round(r() * 190000) / 100, status: pick(r, ["open", "sent", "paid"]) }
          : (() => { const [sku, nm] = pick(r, PRODUCTS); return { sku, name: nm, list_price: Math.round(r() * 24000) / 100 }; })();
  const payload = { file: FILE, table, record_id: rec, data, account_name: name, account: acct };
  if (op === "modified") {
    const keys = Object.keys(data);
    const k = keys[Math.floor(r() * keys.length)];
    payload.changed = { [k]: { from: "(prior)", to: data[k] } };
  }
  if (op === "viewed") payload.viewed_at = at;
  return { sys: MAIN, category: op === "viewed" ? "view" : `${MAIN}.data`, action: `${MAIN}.${table}.${op}`, payload };
}

// Materialize every burst that is due for this session, exactly once. Returns
// the visitor's whole trickle so far, oldest first.
export function liveFor(db, s, now = Date.now()) {
  if (!s.live) s.live = { entries: [], bursts: 0, chain: null };
  const elapsed = now - s.at0;
  const due = Math.max(0, Math.min(BURSTS, Math.floor((elapsed - FIRST_MS) / EVERY_MS) + 1));
  if (due <= s.live.bursts) return s.live.entries;

  // Chain state is read once, at the first burst: the real head of each system.
  if (!s.live.chain) {
    s.live.chain = {};
    for (const sys of [MAIN, STORE]) {
      const h = head(db, sys);
      s.live.chain[sys] = { seq: h.seq, prev: h.entry_hash || "0".repeat(64) };
    }
  }

  for (let b = s.live.bursts; b < due; b++) {
    const r = rng(`${s.id}:${b}`);
    const tBase = s.at0 + FIRST_MS + b * EVERY_MS;
    const n = int(r, 1, 3);
    for (let k = 0; k < n; k++) {
      const t = tBase + int(r, 0, 4200);
      const e = makeEvent(r, t);
      const c = s.live.chain[e.sys];
      if (!c) continue;
      const iso = new Date(t).toISOString();
      const row = {
        system_id: e.sys,
        seq: ++c.seq,
        event_id: createHash("sha256").update(`${s.id}:${b}:${k}`).digest("hex").slice(0, 32),
        ts_client: iso.replace(/\.\d{3}Z$/, "Z"),
        ts_server: iso,
        category: e.category,
        action: e.action,
        payload_json: JSON.stringify(e.payload),
      };
      row.prev_hash = c.prev;
      row.entry_hash = entryHash(c.prev, row);
      c.prev = row.entry_hash;
      s.live.entries.push(row);
    }
  }
  s.live.bursts = due;
  return s.live.entries;
}

export const liveWindowMs = () => FIRST_MS + BURSTS * EVERY_MS;
