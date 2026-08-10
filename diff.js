// diff.js: what changed between two payloads for the same record.
//
// Its own file so it can be tested without booting the server, and because
// the rule it encodes is subtle enough to deserve one place to read it.

// Compare ONLY the fields the sender actually reported.
//
// Absent is not the same as empty. The per-table calc builds its payload from
// Get(ModifiedFields), so an ordinary edit reports two or three fields and
// omits everything else; those omissions mean "not touched", not "cleared".
// Unioning both key sets (which this used to do) turned every omission into
// {from: <value>, to: null}, so a routine edit claimed the record's primary
// key had been wiped, and any rule watching for cleared keys fired constantly.
//
// A real clear still shows up: FileMaker sends the field with an empty value,
// so the key is present and the comparison catches it.
export function diffRecords(prev, next) {
  const changed = {};
  for (const k of Object.keys(next)) {
    if (JSON.stringify(prev[k]) !== JSON.stringify(next[k])) {
      changed[k] = { from: prev[k] ?? null, to: next[k] ?? null };
    }
  }
  return changed;
}
