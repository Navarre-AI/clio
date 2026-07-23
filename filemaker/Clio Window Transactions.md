# Clio Window Transactions

Automatic record-level logging with zero per-script work. FileMaker's
**OnWindowTransaction** file-level script trigger (File Options > Script
Triggers) fires after every successful commit and hands the script a JSON
summary of everything that changed. This script forwards that summary to
Clio: every create, edit, and delete in the file becomes a chain entry
without touching any other script.

Verified against the current Claris doc:
https://help.claris.com/en/pro-help/content/onwindowtransaction.html

## What the trigger delivers

`Get ( ScriptParameter )` contains:

```
{ "FileName" : { "BaseTable" : [ [ "Operation", recordID, fieldContent ], ... ] } }
```

- Operation is `New`, `Modified`, or `Deleted`.
- `fieldContent` is the value of a per-table field named in the trigger
  options (default: a field literally named `OnWindowTransaction`), or `""`
  if the table has no such field.
- Fires for Pro, Go, WebDirect, and server-side scripts (20.1+). Direct Data
  API / OData record access does NOT fire it (scripts invoked through those
  APIs do). Reverted records don't fire it.

## The per-table payload field (the good part)

Give each base table an **unstored calculation field** named
`OnWindowTransaction` that renders the record as JSON with `JSONSetElement`.
That is where the data structure lives: in the table, not in scripts. Log
exactly what matters per table, e.g. for Invoices:

```
JSONSetElement ( "{}" ;
  [ "id" ; Invoices::ID ; JSONString ] ;
  [ "total" ; Invoices::Total ; JSONNumber ] ;
  [ "status" ; Invoices::Status ; JSONString ] ;
  [ "modified_by" ; Invoices::ModifiedBy ; JSONString ]
)
```

Tables without the field still log operation + record ID, so coverage is
complete on day one and gets richer table by table.

## Setup

1. `ClioSettings` (from `Clio Log.md`) plus one more global field:
   `SystemID`, e.g. `crm`. It prefixes the action names so Clio's pattern
   layer can tell systems' vocabularies apart.
2. File Options > Script Triggers > OnWindowTransaction: select the script
   below. Leave the field name at the default `OnWindowTransaction`.

## Script: `Clio Window Transactions`

```
Set Error Capture [ On ]
Set Variable [ $txn ; Value: Get ( ScriptParameter ) ]
Set Variable [ $file ; Value: GetValue ( JSONListKeys ( $txn ; "" ) ; 1 ) ]
Set Variable [ $sys ; Value: ClioSettings::SystemID ]
Set Variable [ $tsClient ; Value: /* the ISO 8601 UTC calc from Clio Log.md */ ]
Set Variable [ $tables ; Value: JSONListKeys ( $txn ; $file ) ]
Set Variable [ $body ; Value: "{}" ]
Set Variable [ $i ; Value: 0 ]

Loop [ Flush: Always ]
  Exit Loop If [ Let ( $t = $t + 1 ; $t > ValueCount ( $tables ) ) ]
  Set Variable [ $table ; Value: GetValue ( $tables ; $t ) ]
  Set Variable [ $ops ; Value: JSONGetElement ( $txn ; $file & "." & $table ) ]
  Set Variable [ $n ; Value: ValueCount ( JSONListKeys ( $ops ; "" ) ) ]
  Set Variable [ $r ; Value: 0 ]
  Loop [ Flush: Always ]
    Exit Loop If [ $r ≥ $n ]
    Set Variable [ $row ; Value: JSONGetElement ( $ops ; "[" & $r & "]" ) ]
    Set Variable [ $payload ; Value:
      JSONSetElement ( "{}" ;
        [ "file" ; $file ; JSONString ] ;
        [ "table" ; $table ; JSONString ] ;
        [ "record_id" ; JSONGetElement ( $row ; "[1]" ) ; JSONNumber ] ;
        [ "data" ; JSONGetElement ( $row ; "[2]" ) ; JSONString ]
      ) ]
    Set Variable [ $body ; Value:
      JSONSetElement ( $body ;
        [ "entries[" & $i & "].event_id" ; Get ( UUID ) ; JSONString ] ;
        [ "entries[" & $i & "].ts_client" ; $tsClient ; JSONString ] ;
        [ "entries[" & $i & "].category" ; $sys & ".data" ; JSONString ] ;
        [ "entries[" & $i & "].action" ;
            $sys & "." & $table & "." & Lower ( JSONGetElement ( $row ; "[0]" ) ) ;
            JSONString ] ;
        [ "entries[" & $i & "].payload_json" ; $payload ; JSONString ]
      ) ]
    Set Variable [ $i ; Value: $i + 1 ]
    Set Variable [ $r ; Value: $r + 1 ]
  End Loop
End Loop

If [ $i = 0 ]
  Exit Script [ Text Result: "" ]
End If

Set Variable [ $curl ; Value:
  "-X POST" & ¶ &
  "--max-time 5" & ¶ &
  "--header \"Authorization: Bearer " & ClioSettings::ClioAPIKey & "\"" & ¶ &
  "--header \"Content-Type: application/json\"" & ¶ &
  "--data @$body" ]
Insert from URL [ Select ; With dialog: Off ; Target: $result ;
  ClioSettings::ClioURL & "/v1/log" ; cURL options: $curl ]
Exit Script [ Text Result: "" ]
```

Actions come out as `crm.Invoices.modified`, `crm.Invoices.deleted`,
`crm.Customers.new`: exactly the per-table vocabulary Clio's pattern scan
watches. A delete spike at 2 AM stops being invisible.

## Notes and gotchas

- **Batching is free.** One commit with 200 changed records is one HTTP call
  with 200 entries (Clio accepts 500 per request; chunk the loop if your
  transactions run bigger).
- **This script must stay fast and silent.** It runs after every commit.
  No dialogs, no navigation, `--max-time 5`, exit empty. The unstored calc
  keeps payload rendering out of the script entirely.
- **What it does not catch:** record changes made directly via the Data API,
  OData, or xDBC (no script involved), `Truncate Table`, reverted records,
  and clients older than 20.1. For a real audit claim, close those doors
  with privilege sets: disable the fmrest/fmodata/fmxdbc extended privileges
  for accounts that shouldn't bypass the log, and enforce a minimum client
  version. Script-driven changes, user edits, imports, Replace Field
  Contents, Pro, Go, WebDirect, and server-side scripts all fire it.
- **Delivery is at-most-once.** The trigger queues and runs after the current
  script stack; a crash before it runs loses those events. The chain stays
  intact (nothing forks), you just don't get the entries. Known trade,
  same as `Clio Log.md`.
- **Big imports mean big payloads.** A 10,000-record import fires once with
  one huge JSON. Posting directly (as this script does) is fine; relaying
  the parameter through Perform Script on Server can truncate around 1 MB,
  so don't. Chunk the loop at 500 entries per POST for monster commits.
- **Cost:** community benchmarks (Soliant, 2023) put the trigger around
  2.5 ms per commit, dropping under 1 ms inside explicit transactions. The
  real cost center is the context calc: keep it lean, no summary fields, no
  cross-table unstored calcs.
- **No runaway loop by design.** The classic OnWindowTransaction trap is
  writing the audit log into the same file, which commits, which fires the
  trigger again. Clio's log lives outside FileMaker, so the loop cannot
  exist. Find mode can fire with an empty payload; the `$i = 0` early exit
  absorbs it.
- **Record IDs.** The trigger's recordID is FileMaker's internal one. Put
  your real primary key in the per-table calc field; the payload then has
  both.
- **Names with dots.** The JSON paths above concatenate file and table names;
  if a file or base table name contains `.` or `[`, adjust the path handling
  (rare, and worth renaming anyway).
- Pair with `Clio Log.md` for event-shaped logging (logins, exports, script
  failures); this trigger covers data-shaped history.
