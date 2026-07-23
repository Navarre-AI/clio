# Clio Daily Anchor

The script that makes the log testimony instead of a diary. Once a day (a
FileMaker Server schedule), it:

1. Pulls Clio's current chain head and stores it as a **new record** in an
   append-only `ClioAnchor` table inside your own file. Clio's operator
   cannot write to your file, so this snapshot is beyond their reach.
2. Asks Clio to verify that yesterday's anchor still holds. If the chain no
   longer reproduces the anchored hash, someone rewrote history. The script
   exits with an error so the FMS schedule's email notification fires.
3. Fires the daily AI pattern scan (fire-and-forget).

Run it hourly instead of daily if you want a smaller exposure window; see
CHAIN.md for what the anchor does and does not protect.

## Prerequisites

- The `ClioSettings` table from `Clio Log.md`.
- A `ClioAnchor` table. Records are created, never edited (except step 4
  writing the verify status onto the record it just created):

| Field | Type | Notes |
|---|---|---|
| `CreatedTS` | Timestamp | Auto-enter creation timestamp |
| `HeadSeq` | Number | |
| `HeadHash` | Text | 64 hex chars |
| `EntryCount` | Number | |
| `VerifyStatus` | Text | `verified`, `TAMPER SUSPECTED`, or `first anchor` |
| `RawResponse` | Text | Full JSON reply, for the record |

## Script steps

```
Set Error Capture [ On ]

# 1. Pull the chain head
Set Variable [ $curlGet ; Value:
  "--max-time 30" & ¶ &
  "--header \"Authorization: Bearer " & ClioSettings::ClioAPIKey & "\"" ]
Insert from URL [ Select ; With dialog: Off ; Target: $head ;
  ClioSettings::ClioURL & "/v1/head" ; cURL options: $curlGet ]

If [ JSONGetElement ( $head ; "ok" ) ≠ 1 ]
  Exit Script [ Text Result: "anchor failed: no reply from Clio" ]
End If

# 2. Remember yesterday's anchor before creating today's
Go to Layout [ "ClioAnchor" ]
Go to Record/Request/Page [ Last ]
Set Variable [ $prevSeq ; Value: ClioAnchor::HeadSeq ]
Set Variable [ $prevHash ; Value: ClioAnchor::HeadHash ]

# 3. Store today's head as a new record
New Record/Request
Set Field [ ClioAnchor::HeadSeq ; JSONGetElement ( $head ; "data.seq" ) ]
Set Field [ ClioAnchor::HeadHash ; JSONGetElement ( $head ; "data.entry_hash" ) ]
Set Field [ ClioAnchor::EntryCount ; JSONGetElement ( $head ; "data.entry_count" ) ]
Set Field [ ClioAnchor::RawResponse ; $head ]

# 4. Verify yesterday's anchor still holds
If [ IsEmpty ( $prevHash ) ]
  Set Field [ ClioAnchor::VerifyStatus ; "first anchor" ]
  Commit Records/Requests [ With dialog: Off ]
Else
  Insert from URL [ Select ; With dialog: Off ; Target: $verify ;
    ClioSettings::ClioURL & "/v1/verify?expect_seq=" & $prevSeq
      & "&expect_hash=" & $prevHash ;
    cURL options: $curlGet ]
  Set Field [ ClioAnchor::VerifyStatus ;
    Case ( JSONGetElement ( $verify ; "data.anchor_match" ) = 1 ;
      "verified" ;
      "TAMPER SUSPECTED" ) ]
  Commit Records/Requests [ With dialog: Off ]
  If [ ClioAnchor::VerifyStatus = "TAMPER SUSPECTED" ]
    # Non-empty exit text marks the FMS schedule as errored, which
    # triggers the schedule's email notification.
    Exit Script [ Text Result: "CLIO TAMPER SUSPECTED at anchor seq " & $prevSeq ]
  End If
End If

# 5. Fire the daily pattern scan (fire-and-forget)
Set Variable [ $curlScan ; Value:
  "-X POST" & ¶ &
  "--max-time 5" & ¶ &
  "--header \"Authorization: Bearer " & ClioSettings::ClioAPIKey & "\"" ]
Insert from URL [ Select ; With dialog: Off ; Target: $scan ;
  ClioSettings::ClioURL & "/v1/scan" ; cURL options: $curlScan ]

Exit Script [ Text Result: "" ]
```

## FileMaker Server schedule

Admin Console > Configuration > Script Schedules > Create Schedule:
FileMaker Script, this file, `Clio Daily Anchor`, daily at a quiet hour,
with **Send email notifications when errors occur** enabled. The scan
trigger rides along, so the customer's existing FMS scheduler is also
Clio's scheduler: no cron anywhere, and the request wakes a scaled-to-zero
Fly machine.

## Notes

- The `--max-time 5` on the scan call is deliberate: the scan can take
  longer than 5 seconds and the request will "time out" in FileMaker, but
  Clio keeps processing it server-side. The anchor script does not need the
  answer.
- `/v1/head` and `/v1/verify` are scoped by the API key, so no `system_id`
  parameter is needed.
