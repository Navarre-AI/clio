# Clio Import Log Table

Most solutions already have a log table: fmLog, a homegrown Audit table, an
UltraLog explosion, years of history. Clio ingests it, three reasons:

1. **Storage**: the history moves outside the file, onto the chain.
2. **Replacement**: once imported and the trigger is live, the old log table
   can stop growing (or go away entirely).
3. **Analysis**: the pattern scan and ask-the-logs work over the full
   history from day one, not just from install day.

## How imported history sits on the chain

The chain records arrival order, so imported entries are appended now, with
their **original timestamp preserved in `ts_client`** (Clio hashes and
stores it verbatim) and `ts_server` = import time. Analysis and queries use
`ts_client` for imported rows. The `event_id` comes from the source record's
UUID, so re-running the import never duplicates anything: same UUID, skipped.

Convention:

- `category`: `<SystemID>.imported`
- `action`: `<SystemID>.imported.<source table>` , or something smarter if
  the source rows have a type field
- `payload_json`: the whole source record as JSON, plus `"source": "<table>"`

## Generic import script: `Clio Import Log Table`

Runs once (or resumably; duplicates are free). Batches of 500.

```
Set Error Capture [ On ]
Go to Layout [ "Log" ]                      // the source log table
Show All Records
Sort Records [ by creation timestamp, ascending ]   // chronological chain order
Go to Record/Request/Page [ First ]
Set Variable [ $body ; Value: "{}" ]
Set Variable [ $i ; Value: 0 ]

Loop [ Flush: Always ]
  Set Variable [ $body ; Value:
    JSONSetElement ( $body ;
      [ "entries[" & $i & "].event_id" ; Log::ID ; JSONString ] ;   // source PK = idempotency
      [ "entries[" & $i & "].ts_client" ; /* ISO calc from Log::zCreated_TS, see below */ ; JSONString ] ;
      [ "entries[" & $i & "].category" ; ClioSettings::SystemID & ".imported" ; JSONString ] ;
      [ "entries[" & $i & "].action" ; ClioSettings::SystemID & ".imported.Log" ; JSONString ] ;
      [ "entries[" & $i & "].payload_json" ;
          JSONSetElement ( Case ( IsEmpty ( Log::JSON ) ; "{}" ; Log::JSON ) ;
            [ "source" ; "Log" ; JSONString ] ;
            [ "id_foreign" ; Log::ID_Foreign ; JSONString ] ) ;
          JSONString ] ) ]
  Set Variable [ $i ; Value: $i + 1 ]
  If [ $i = 500 ]
    Perform Script [ "Clio Send Batch" ; Parameter: $body ]    // Insert from URL POST, waits, checks ok
    Set Variable [ $body ; Value: "{}" ]
    Set Variable [ $i ; Value: 0 ]
  End If
  Go to Record/Request/Page [ Next ; Exit after last: On ]
End Loop

If [ $i > 0 ]
  Perform Script [ "Clio Send Batch" ; Parameter: $body ]
End If
```

`Clio Send Batch` is the POST from `Clio Log.md` but with `--max-time 60`
and an actual check of `JSONGetElement ( $result ; "ok" )`, because an
import should notice failure (unlike live fire-and-forget logging). On any
failure, just run the whole import again: duplicates are skipped by
`event_id`, so it resumes for free.

Timestamp to ISO: adapt the UTC calc from `Clio Log.md`, but from the
stored timestamp instead of the current clock. If the source timestamps are
server-local, either accept that (analysis is relative anyway) or shift by
your UTC offset in the calc.

## A legacy Log table, specifically

The file already has `Log (ID_Foreign, JSON, zCreated_TS)`: the classic
inside-the-file log Clio exists to replace. The generic script above is
written against exactly those fields. After import:

- Keep the table read-only as an archive, or delete it once the anchor has
  run at least once (the history is then provably preserved outside).
- Any script still creating Log records can switch to one
  `Perform Script [ "Clio Log" ]` call, same parameter thinking, better home.
