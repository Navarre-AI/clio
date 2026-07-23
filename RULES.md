# Rules

Enforced in the code, restated here so nobody softens them later.

1. **The AI never computes or invents a number.** For any fact it states, it
   must have called `query_logs`, and the deterministic engine (SQLite) did
   the math. Warnings from the pattern scan cite pre-computed aggregates; the
   model only chooses which aggregates matter and how to word them. If the
   model is unavailable, threshold rules still produce warnings from the same
   aggregates.

2. **The AI cannot write.** Its queries run on a read-only database handle
   (writes fail at the engine level), restricted to views that exclude the
   hash columns and key material, single SELECT statement, capped rows.

3. **No plumbing on screen.** Users never see SQL, view names, column names,
   or raw hashes in AI answers. Rows are described in plain business English.

4. **The log is not the model's to edit.** Nothing in the AI layer touches
   `log_entries`. Update and delete do not exist in the code, and the schema
   aborts them anyway.

5. **Honesty about limits.** If the logs cannot answer a question, Clio says
   so rather than approximating.
