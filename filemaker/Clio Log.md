# Clio Log ( category ; action ; payload )

The one script. Call it from anywhere with a JSON parameter; it fires one
`Insert from URL` at Clio and exits without looking back. If Clio is down,
slow, or unreachable, the calling script never notices and never waits more
than 5 seconds. Safe from FileMaker Pro, Go, WebDirect, and server-side
schedules.

## Prerequisites

A one-record settings table, `ClioSettings`, with two global-storage text
fields (set once at install):

| Field | Example |
|---|---|
| `ClioURL` | `https://your-clio.fly.dev` (no trailing slash) |
| `ClioAPIKey` | `nk_clio_...` (minted by Clio's admin; one key per FileMaker system) |

The key identifies the system server-side. Two files that should share one
chain share one key; two systems that should have separate chains get
separate keys.

## Script parameter

One JSON object, built by the caller with `JSONSetElement` (never a typed
string literal):

```
JSONSetElement ( "{}" ;
  [ "category" ; "orders" ; JSONString ] ;
  [ "action" ; "orders.invoice.posted" ; JSONString ] ;
  [ "payload" ; JSONSetElement ( "{}" ;
      [ "invoice_id" ; Invoices::ID ; JSONString ] ;
      [ "total" ; Invoices::Total ; JSONNumber ] ) ; JSONObject ]
)
```

Name actions like the sidecar family does: `system.noun.verb`
(`crm.order.created`, `crm.login.failed`). Clio's pattern layer keys off the
action, so consistent names buy you better warnings.

## Script steps

```
Set Error Capture [ On ]
Set Variable [ $param ; Value: Get ( ScriptParameter ) ]

# ts_client: ISO 8601 UTC, from the UTC clock so client time zones don't lie
Set Variable [ $tsClient ; Value:
  Let ( [
    ms = Get ( CurrentTimeUTCMilliseconds ) ;
    ts = GetAsTimestamp ( Date ( 1 ; 1 ; 1970 ) ) + Div ( ms ; 1000 ) ;
    d = GetAsDate ( ts ) ;
    t = GetAsTime ( ts ) ;
    y = Year ( d ) ;
    mo = Right ( "0" & Month ( d ) ; 2 ) ;
    dy = Right ( "0" & Day ( d ) ; 2 ) ;
    h = Right ( "0" & Hour ( t ) ; 2 ) ;
    mi = Right ( "0" & Minute ( t ) ; 2 ) ;
    s = Right ( "0" & Int ( Seconds ( t ) ) ; 2 )
  ] ;
    y & "-" & mo & "-" & dy & "T" & h & ":" & mi & ":" & s & "Z"
  ) ]

# The body Clio ingests: { entries: [ { ... } ] }
Set Variable [ $body ; Value:
  JSONSetElement ( "{}" ;
    [ "entries[0].event_id" ; Get ( UUID ) ; JSONString ] ;
    [ "entries[0].ts_client" ; $tsClient ; JSONString ] ;
    [ "entries[0].category" ; JSONGetElement ( $param ; "category" ) ; JSONString ] ;
    [ "entries[0].action" ; JSONGetElement ( $param ; "action" ) ; JSONString ] ;
    [ "entries[0].payload_json" ; JSONGetElement ( $param ; "payload" ) ; JSONString ]
  ) ]

Set Variable [ $curl ; Value:
  "-X POST" & ¶ &
  "--max-time 5" & ¶ &
  "--header \"Authorization: Bearer " & ClioSettings::ClioAPIKey & "\"" & ¶ &
  "--header \"Content-Type: application/json\"" & ¶ &
  "--data @$body" ]

Insert from URL [ Select ; With dialog: Off ; Target: $result ;
  ClioSettings::ClioURL & "/v1/log" ; cURL options: $curl ]

# Fire and forget: never inspect $result, never block the caller.
Exit Script [ Text Result: "" ]
```

## Notes

- `payload_json` travels as a JSON **string** (Clio hashes it exactly as
  received), which is why the payload is passed through `JSONString`, not
  `JSONObject`.
- `event_id` = `Get ( UUID )` makes retries safe: if the same event ever
  arrives twice, Clio skips the duplicate and the chain neither forks nor
  gaps.
- Batch note: this script sends one event per call, which is the right
  default. High-volume callers can build `entries[1]`, `entries[2]`, ... in
  the same body; Clio accepts up to 500 per request.
