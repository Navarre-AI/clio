# Clio: the one script

This is the whole FileMaker side. **One script**, set as the file's
OnWindowTransaction trigger AND callable by hand for events. It posts whatever
parameter it gets, untouched, to one URL. Clio figures out the shape.

## Setup (two minutes, no schema)

1. Deploy your Clio (see the repo README / `setup.mjs`) and mint a key for this
   system. You get a URL and a key like `nk_clio_...`.
2. Create the script below. Put your URL + key in the one Insert from URL step.
3. File Options > Script Triggers > **OnWindowTransaction** > select this script.

That's it. Every committed record change now logs itself. No tables, no fields,
no plugins.

## The script: `Clio`

```
Set Error Capture [ On ]
Set Variable [ $body ; Value: Get ( ScriptParameter ) ]

# Runs after every commit (the trigger) OR when you call it by hand for an
# event. Either way, post the parameter as-is and leave. Fire and forget.
Insert from URL [
  With dialog: Off ; Target: $response ;
  "https://YOUR-CLIO.fly.dev/v1/log/nk_clio_YOURKEY" ;
  cURL options:
    "-X POST" & ¶ &
    "--max-time 5" & ¶ &
    "--header " & Quote ( "Content-Type: application/json" ) & ¶ &
    "--data-binary @$body"
]

Exit Script [ Text Result: "" ]
```

The key travels in the URL, so there are zero headers to fuss with and nothing
to configure elsewhere. Rotate the key any time by re-minting and changing this
one line.

## What Clio accepts (you never think about this)

The same endpoint auto-detects three shapes:

1. **Transaction dump** (what the trigger sends): `{ "File": { "Table": [[op, id, data]] } }`.
   Clio unpacks it to one entry per record, names each `system.Table.op`, and
   diffs modified records against their previous snapshot so the log says which
   fields changed, from what, to what. Handles a Delete-All of thousands in one
   post (up to ~25 MB).
2. **A flat event** (when you call it by hand): a JSON object with
   `category`, `action`, and a `payload`. Use this for logins, exports, record
   views, script milestones, anything the trigger can't see.
3. **A batch**: `{ "entries": [ ... ] }` (the shape other sidecars ship).

## Calling it by hand for events

The trigger covers all record changes. For everything else, call the same
script with a flat parameter:

```
Perform Script [ "Clio" ; Parameter:
  JSONSetElement ( "{}" ;
    [ "category" ; "answer-key.auth" ; JSONString ] ;
    [ "action" ; "answer-key.login" ; JSONString ] ;
    [ "payload" ; JSONSetElement ( "{}" ;
        [ "account_name" ; Get ( AccountName ) ; JSONString ] ) ; JSONObject ] ) ]
```

For a big export, put the row count in the payload so the watchdog can flag it:
`[ "rows" ; Get ( FoundCount ) ; JSONNumber ]`.

## Notes

- **No PSoS.** OnWindowTransaction already fires after the commit, off the
  user's critical path, and a big transaction can exceed the ~1 MB PSoS
  parameter cap. Post direct. The 5-second timeout means Clio being slow or
  down never blocks a user.
- **What the trigger does not see** (close these in privilege sets if you need
  full coverage): direct Data API / OData / xDBC writes, `Truncate Table`,
  reverted records, and clients older than FileMaker 20.1.
- **Import your old fmLog** (or any existing log table) so history is there
  from day one: see `Clio Import Log Table.md`.
- **Make it testimony**: run `Clio Daily Anchor.md` on an FMS schedule so the
  chain head is written back into your own file daily and re-verified.
