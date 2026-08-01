// ai.js: the only file that talks to a model. Two jobs, both under RULES.md:
// the model never computes or invents a number. It writes SELECT-only SQL
// (ask) or picks which real aggregates merit a warning (scan findings).
// Anthropic API via raw fetch, Pythia's pattern. No SDK.

import { warningsFromAggregates } from "./scan.js";

const API_KEY = () => process.env.ANTHROPIC_API_KEY || "";
const MODEL = () => process.env.ANTHROPIC_MODEL || "claude-fable-5";

export function aiAvailable() { return Boolean(API_KEY()); }

async function anthropicFetch(body, timeoutMs = 60000) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": API_KEY(),
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// ---- Ask the logs -----------------------------------------------------------
// One tool. The SQL runs on a read-only handle, single SELECT statement,
// against views that hide the hash columns. 200-row cap.

const ASK_TOOLS = [
  { name: "query_logs",
    description: "Run one read-only SQLite SELECT against the log store. Tables: v_logs(system_id, seq, ts_client, ts_server, category, action, payload_json) and v_warnings(system_id, severity, title, detail, status, created_at). payload_json is a JSON string; use json_extract(payload_json, '$.field') to reach into it. Timestamps are ISO 8601 strings; they compare correctly as text. Returns rows as JSON.",
    input_schema: { type: "object", properties: { sql: { type: "string" } }, required: ["sql"] } },
];

export function guardSql(sql) {
  const s = String(sql || "").trim().replace(/;\s*$/, "");
  if (!/^(select|with)\b/i.test(s)) throw new Error("Only SELECT queries are allowed.");
  if (s.includes(";")) throw new Error("One statement only.");
  return s;
}

function vocabulary(db) {
  const actions = db.prepare(
    "SELECT system_id, action, COUNT(*) AS n FROM v_logs GROUP BY system_id, action ORDER BY n DESC LIMIT 100"
  ).all();
  return actions.map((a) => `${a.system_id} ${a.action} (${a.n})`).join("\n");
}

export async function askLogs(dbRead, messages) {
  const system =
    "You are Clio, the historian over this installation's tamper-evident FileMaker logs. " +
    "Answer in plain, concise business English backed by real numbers.\n\n" +
    "The event vocabulary actually present (system action count):\n" + vocabulary(dbRead) + "\n\n" +
    "Rules: (1) For any number or fact, call query_logs with a SQLite SELECT; never state a number you did not query. " +
    "(2) Give a short plain-English answer with a takeaway; mention a table was shown if you queried one. " +
    "(3) Never show SQL, view names, or column names to the user. Never invent events that are not in the vocabulary. " +
    "(4) If the logs cannot answer the question, say so honestly. " +
    "(5) Style: never use em dashes; use commas, colons, or parentheses instead.";

  const convo = messages.map((m) => ({ role: m.role, content: String(m.content) }));
  const artifacts = [];
  let replyText = "";

  for (let hop = 0; hop < 6; hop++) {
    const resp = await anthropicFetch({
      model: MODEL(), max_tokens: 1500, system, tools: ASK_TOOLS, messages: convo,
    });
    convo.push({ role: "assistant", content: resp.content });
    const toolUses = resp.content.filter((b) => b.type === "tool_use");
    replyText = resp.content.filter((b) => b.type === "text").map((b) => b.text).join(" ").trim() || replyText;
    if (!toolUses.length) break;
    const results = [];
    for (const tu of toolUses) {
      let out;
      try {
        const rows = dbRead.prepare(guardSql(tu.input.sql)).all().slice(0, 200);
        const columns = rows[0] ? Object.keys(rows[0]) : [];
        if (rows.length) artifacts.push({ title: "Result", columns, rows });
        out = { rowCount: rows.length, columns, rows: rows.slice(0, 60) };
      } catch (e) {
        out = { error: String(e.message || e).slice(0, 300) };
      }
      results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(out) });
    }
    convo.push({ role: "user", content: results });
  }

  return { reply: replyText || "Here's what I found.", artifacts };
}

// ---- The pulse --------------------------------------------------------------
// A short rolling read of what's happening, regenerated only when there are
// new entries and the cached one has aged out (server throttles). Numbers
// arrive pre-computed; the model only narrates them.

export async function pulseText(stats) {
  const system =
    "You are Clio, watching FileMaker system logs. Given pre-computed activity stats, write a 2-3 sentence " +
    "plain-English pulse for a database admin: what's happening, whether it looks routine, and the one thing " +
    "worth a glance if any. Cite only numbers present in the stats. Calm, dry, specific; no headings, no lists, " +
    "no jargon, never em dashes (use commas, colons, or parentheses).";
  const resp = await anthropicFetch({
    model: MODEL(), max_tokens: 300, system,
    messages: [{ role: "user", content: JSON.stringify(stats) }],
  }, 30000);
  return resp.content.filter((b) => b.type === "text").map((b) => b.text).join(" ").trim();
}

// ---- Scan findings ----------------------------------------------------------
// The deterministic aggregates go IN; the model calls report_finding 0..n
// times choosing severity and wording. evidence_index points at the aggregate
// each finding cites, so every warning carries its real numbers. On any model
// failure the threshold fallback still produces warnings.

const FINDING_TOOLS = [
  { name: "report_finding",
    description: "Report one warning worth a human's attention. Call once per distinct finding; skip aggregates that are routine noise. evidence_index is the 0-based index into the aggregates array you were given.",
    input_schema: { type: "object", properties: {
      severity: { type: "string", enum: ["info", "warn", "critical"] },
      title: { type: "string", description: "Short, plain-English, no jargon" },
      detail: { type: "string", description: "One or two sentences citing the numbers from the aggregate" },
      evidence_index: { type: "number" },
    }, required: ["severity", "title", "detail", "evidence_index"] } },
];

export async function aiFindings(systemId, aggregates) {
  try {
    const system =
      "You are Clio's pattern watcher for FileMaker system logs. You receive pre-computed aggregate anomalies " +
      "(real numbers, already measured). Decide which merit a warning, with what severity, and word each for a busy " +
      "FileMaker developer. Only cite numbers present in the aggregates. Routine growth is not a finding. " +
      "A spike in error-shaped events, a system going silent, or a brand-new event type usually is. " +
      "Style: never use em dashes; use commas, colons, or parentheses instead.";
    const resp = await anthropicFetch({
      model: MODEL(), max_tokens: 1200, system, tools: FINDING_TOOLS,
      messages: [{ role: "user", content:
        `System "${systemId}" aggregates for the last 24 hours vs its 14-day baseline:\n` +
        JSON.stringify(aggregates, null, 2) +
        "\nReport the findings worth attention, then stop." }],
    });
    const findings = resp.content.filter((b) => b.type === "tool_use" && b.name === "report_finding")
      .map((tu) => {
        const i = Number(tu.input.evidence_index);
        return {
          system_id: systemId,
          severity: ["info", "warn", "critical"].includes(tu.input.severity) ? tu.input.severity : "info",
          title: String(tu.input.title || "").slice(0, 200),
          detail: String(tu.input.detail || "").slice(0, 1000),
          evidence: Number.isInteger(i) && aggregates[i] ? aggregates[i] : aggregates,
        };
      });
    return findings;
  } catch {
    return warningsFromAggregates(aggregates); // model down: thresholds still speak
  }
}
