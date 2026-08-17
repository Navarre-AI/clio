// phrase.js: the ONE place a dotted action identifier becomes English.
//
// Action names look like "<system>.<Table>.<op>" ("cascade-office.Orders.deleted")
// or "clio.scan.run". They are database keys. They belong in a query, in the
// JSON source view, and nowhere a person reads. They leaked into the pulse, into
// KPI tile labels, into chart labels and into the AI's own prose, because each
// surface formatted them separately and none of them translated.
//
// Everything that shows an action to a human comes through here.

// FileMaker's OnWindowTransaction sends "New", "Modify", "Delete", so real
// actions end .new/.modify/.delete. Chassis and demo data use .created/
// .modified/.deleted. Both shapes must read the same to a person; missing the
// bare forms printed "1 organizations delete".
const VERB = {
  new: "created", create: "created", created: "created",
  modify: "edited", modified: "edited", edit: "edited", edited: "edited",
  delete: "deleted", deleted: "deleted", remove: "deleted",
  duplicate: "duplicated", duplicated: "duplicated",
};

// Clio's own internal events, named for people rather than for the log.
const CLIO_ACTIONS = {
  "clio.scan.run": "watchdog scan ran",
  "clio.admin.key_minted": "connection code minted",
  "clio.admin.system_created": "system created",
  "clio.admin.system_registered": "system registered",
  "clio.admin.archive_created": "log archived",
  "clio.admin.archive": "log archived",
  "clio.admin.purge": "records purged",
  "clio.admin.key_revoked": "connection code revoked",
  "clio.admin.system_confirmed": "system confirmed",
  "clio.verify.failed": "chain verification FAILED",
};

// Table names are the author's, so pluralise by shape rather than a word list.
// "Organization" -> "organizations", "Inventory" -> "inventory records".
function plural(table) {
  const t = String(table || "").trim();
  if (!t) return "records";
  const lower = t.toLowerCase();
  // Table names are usually ALREADY plural ("Orders", "Customers", "Invoices").
  // Pluralising those produced "orderses" and "customerses".
  if (/(s|es)$/.test(lower)) return lower;
  // Mass nouns have no useful plural: "inventories deleted" is wrong, and
  // "inventorys" is worse. Give them a counting unit instead.
  if (/^(inventory|data|info|stock|cash|payroll|audit|history)$/.test(lower)) return lower + " records";
  if (/[^aeiou]y$/.test(lower)) return lower.slice(0, -1) + "ies";
  if (/(x|z|ch|sh)$/.test(lower)) return lower + "es";
  return lower + "s";
}

// "cascade-office.Orders.deleted" -> "orders deleted"
// With a system name: "orders deleted at Cascade Office"
// systemName is a resolver so callers pass the system's LABEL, never its slug.
// Table names arrive both ways ("Orders" and "Organization"), so a count of one
// needs the singular: "1 organization created", not "1 organizations created".
function singular(table) {
  const lower = String(table || "").trim().toLowerCase();
  if (!lower) return "record";
  if (/^(inventory|data|info|stock|cash|payroll|audit|history)$/.test(lower)) return lower + " record";
  if (/ies$/.test(lower)) return lower.slice(0, -3) + "y";
  if (/(ch|sh|x|z|s)es$/.test(lower)) return lower.slice(0, -2);
  if (/[^s]s$/.test(lower)) return lower.slice(0, -1);
  return lower;
}

export function phraseAction(action, { systemName = null, withSystem = false, count = null } = {}) {
  const a = String(action || "").trim();
  if (!a) return "";
  if (/\s/.test(a)) return a;                    // already prose, leave it
  if (CLIO_ACTIONS[a]) return CLIO_ACTIONS[a];
  if (a.startsWith("clio.")) return a.slice(5).replace(/[_.]/g, " ");

  const parts = a.split(".");
  if (parts.length >= 3) {
    const op = parts[parts.length - 1];
    const table = parts[parts.length - 2];
    const sys = parts.slice(0, -2).join(".");
    const noun = count === 1 ? singular(table) : plural(table);
    const core = `${noun} ${VERB[op] || op}`;
    if (!withSystem) return core;
    const name = typeof systemName === "function" ? systemName(sys) : (systemName || null);
    return name ? `${core} at ${name}` : core;
  }
  // Two-part or odd shapes: "auth.login_failed" -> "auth login failed"
  return a.replace(/[_.]/g, " ");
}

// "cascade-office.Orders.deleted (3)" -> "3 orders deleted at Cascade Office"
// Leads with the number, which is what a reader wants first.
export function phraseCount(action, n, opts = {}) {
  const text = phraseAction(action, { ...opts, count: Number(n) });
  return `${n} ${text}`;
}

// Clio's own housekeeping is not the customer's activity. It is excluded from
// Log Entries and from Ask already; anything summarising activity should exclude
// it too rather than translate it into readable noise.
export const isInternal = (systemId) => String(systemId || "") === "clio";
