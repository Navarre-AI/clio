// demosession.js: per-visitor state for the public demo.
//
// The demo has to feel like Clio (toggle a rule, edit it, dry-run it, dismiss a
// warning, ask the logs a question) without any visitor being able to change
// what the next visitor sees. So the baked dataset stays strictly read-only and
// every interactive change is recorded HERE, in memory, against a session id
// carried in an HttpOnly cookie. Reads then layer the session's overrides over
// the baseline rows on the way out.
//
// Nothing here is persisted: a redeploy or a restart drops every session, which
// is exactly the desired lifetime for a sandbox.

import { randomBytes } from "node:crypto";

export const COOKIE = "clio_demo_sid";

const TTL_MS = Number(process.env.DEMO_SESSION_TTL_MS || 6 * 3600 * 1000); // 6h
const MAX_SESSIONS = Number(process.env.DEMO_MAX_SESSIONS || 5000);

const sessions = new Map(); // sid -> state

export function newSessionId() { return randomBytes(18).toString("hex"); }

// A session id is only ever minted by us and only ever read back; a forged one
// simply gets its own (empty) bucket, which can affect nobody else.
export function validSessionId(s) { return typeof s === "string" && /^[0-9a-f]{36}$/.test(s); }

function blank(id) {
  return {
    id,
    at0: Date.now(),         // arrival: the live trickle is timed from here
    at: Date.now(),
    rulePatch: new Map(),   // rule id -> partial { name, description, severity, class, enabled, match }
    ruleDeleted: new Set(), // baseline rule ids hidden for this visitor
    ruleNew: [],            // rules this visitor created (full row shape)
    warningAcked: new Set(),// warning ids this visitor dismissed
    aiUsed: 0,              // prompts spent against the per-visitor cap
    live: null,             // the visitor's own live trickle (demolive.js)
  };
}

export function getSession(sid) {
  const now = Date.now();
  let s = sessions.get(sid);
  if (s && now - s.at > TTL_MS) { sessions.delete(sid); s = undefined; }
  if (!s) { s = blank(sid); sessions.set(sid, s); }
  s.at = now;
  if (sessions.size > MAX_SESSIONS) evict();
  return s;
}

// Cheap LRU: when the map outgrows its cap, drop the coldest tenth. A visitor
// whose state is evicted just sees the pristine demo again.
function evict() {
  const rows = [...sessions.entries()].sort((a, b) => a[1].at - b[1].at);
  for (const [k] of rows.slice(0, Math.ceil(MAX_SESSIONS / 10))) sessions.delete(k);
}

export function sessionStats() { return { sessions: sessions.size }; }
export function resetSessions() { sessions.clear(); }

// ---- rules overlay ----------------------------------------------------------

// Apply a visitor's edits to the baseline rule list. `baseline` is exactly what
// rules.js listRules() returns; `recompute(match)` re-runs the dry run for any
// rule whose match spec this visitor changed (the baseline number is stale then).
export function overlayRules(sess, baseline, recompute) {
  const out = [];
  for (const r of baseline) {
    if (sess.ruleDeleted.has(r.id)) continue;
    const p = sess.rulePatch.get(r.id);
    if (!p) { out.push(r); continue; }
    const merged = { ...r, ...p, enabled: p.enabled === undefined ? r.enabled : !!p.enabled };
    if (p.match !== undefined) {
      merged.match = p.match;
      merged.match_json = JSON.stringify(p.match);
      merged.would_fire_30d = recompute ? recompute(p.match) : r.would_fire_30d;
    }
    out.push(merged);
  }
  for (const r of sess.ruleNew) {
    out.push({ ...r, would_fire_30d: recompute ? recompute(r.match) : null });
  }
  return out;
}

// The effective rule a visitor sees, baseline + their edits, or null.
export function overlayRule(sess, baseRule, id) {
  if (sess.ruleDeleted.has(id)) return null;
  const created = sess.ruleNew.find((r) => r.id === id);
  if (created) return created;
  if (!baseRule) return null;
  const p = sess.rulePatch.get(id);
  if (!p) return baseRule;
  const merged = { ...baseRule, ...p, enabled: p.enabled === undefined ? baseRule.enabled : !!p.enabled };
  if (p.match !== undefined) { merged.match = p.match; merged.match_json = JSON.stringify(p.match); }
  return merged;
}

// Record an edit. Only the fields Clio's own PATCH accepts are kept.
const PATCHABLE = ["name", "description", "effect", "severity", "class"];
export function patchRule(sess, id, body, baseMatch) {
  const created = sess.ruleNew.find((r) => r.id === id);
  const target = created || Object.assign({}, sess.rulePatch.get(id) || {});
  for (const k of PATCHABLE) if (body[k] !== undefined) target[k] = body[k] === null ? null : String(body[k]);
  if (body.enabled !== undefined) target.enabled = !!body.enabled;
  if (body.match !== undefined) target.match = body.match;
  if (body.match_patch !== undefined) target.match = { ...(target.match || baseMatch || {}), ...body.match_patch };
  if (!created) sess.rulePatch.set(id, target);
  return target;
}

export function createRule(sess, r) {
  const rule = {
    id: "demo-" + randomBytes(8).toString("hex"),
    name: String(r.name || "Untitled rule").slice(0, 120),
    description: String(r.description || "").slice(0, 500),
    effect: ["alert", "highlight", "mute"].includes(r.effect) ? r.effect : "alert",
    severity: ["info", "warn", "critical"].includes(r.severity) ? r.severity : "warn",
    class: r.class ? String(r.class).slice(0, 40) : null,
    enabled: r.enabled === false ? false : true,
    match: r.match || {},
    match_json: JSON.stringify(r.match || {}),
    created_at: new Date().toISOString(),
    last_fired_at: null,
    session_only: true,
  };
  sess.ruleNew.push(rule);
  return rule;
}

export function deleteRule(sess, id) {
  const i = sess.ruleNew.findIndex((r) => r.id === id);
  if (i >= 0) { sess.ruleNew.splice(i, 1); return true; }
  sess.rulePatch.delete(id);
  sess.ruleDeleted.add(id);
  return true;
}
