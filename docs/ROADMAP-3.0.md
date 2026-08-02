# Clio 3.0 ideas: meaning and pattern

The raw append-only log is the foundation. Near-term and 2.0 make it
deterministically queryable (history, filters, diffs). 3.0 layers *meaning* on
top: semantic search, similarity, and learned patterns, for long text and for
behavioral patterns alike. Follows the house rule: AI for perception and
language, deterministic SQL for every count.

## Semantic search over the log
Embed entries (the human message + payload) into vectors so you can ask by
meaning, not keywords: "find changes that look like address corrections,"
"anything resembling someone covering their tracks," "edits similar to this
one." Borrows Mitos's embedding approach, pointed at the log instead of records.

## Pattern matching beyond text
- **Behavioral sequences**: recognize meaningful chains (login -> big export ->
  delete; create -> immediate delete; off-hours -> bulk edit) and flag them as
  patterns, not just single events.
- **Learned baselines / anomaly detection**: each user and system has a normal
  rhythm; ML flags deviations (a bookkeeper who never deletes suddenly deleting;
  a dormant account waking). Beyond 2.0's fixed thresholds.
- **Cross-field / cross-record patterns**: "someone is walking the table field
  by field," "the same value is being copied across many records."

## Meaning of a change (long text)
Beyond the 2.0 textual diff: summarize what a large edit actually *did*
("rewrote the intro to soften the tone," "removed the refund clause"), and flag
semantically significant changes even when few characters moved.

## Semantic rules
Rules authored in plain language that match on meaning, not just structured
conditions: "alert me to anything that looks like data being exfiltrated," "flag
edits that seem to hide a prior value." The deterministic rule engine stays;
this adds a semantic matcher alongside it, clearly labeled as judgment, not fact.

## Automatic classification / intent
Tag each entry with an inferred intent (correction, cleanup, data-entry error,
suspicious, routine) so the feed and dashboards can group by *why*, not just
*what*. Always a labeled inference, never presented as certainty.

## Entity resolution across systems
Link the same person, record, or action across multiple systems/files logging
to one Clio ("this is the same customer edited in three databases"), so history
and patterns span the whole estate, not one file.

## Guardrail (unchanged from 1.x)
Every number stays deterministic SQL. Semantic features produce *suggestions,
similarity, and labels* a human confirms, never invented facts or counts. The
raw log remains the tamper-evident source of truth underneath all of it.
