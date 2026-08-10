# Clio schema XML

Two table-clipboard (XMTB) payloads, ready to paste into Manage Database.
Format matches the FM 26 clipboard capture shape: camelCase `dataType` /
`fieldType`, `TimeStamp` spelling, no UUIDs (FileMaker mints its own on paste).

| File | Table | Contents |
|---|---|---|
| `ClioSettings.xml` | ClioSettings | 3 global text fields: ClioURL, ClioAPIKey, SystemID |
| `ClioAnchor.xml` | ClioAnchor | CreatedTS (auto-enter creation timestamp, modification prohibited), HeadSeq, HeadHash, EntryCount, VerifyStatus, RawResponse |

## Paste order

1. **ClioSettings table.** Put `ClioSettings.xml` on the clipboard as an FM
   table object (e.g. via FMClipboardBroker or your XML-to-clipboard tool of
   choice, class XMTB), then in your solution: Manage Database > Tables > Paste.
   Requires "Use advanced tools" for the Paste button.
2. **ClioAnchor table.** Same with `ClioAnchor.xml`.
3. **Layouts.** Confirm a layout named `ClioAnchor` exists showing the
   ClioAnchor table occurrence (the Daily Anchor script does
   `Go to Layout [ "ClioAnchor" ]`). Also drop the three ClioSettings globals
   on any utility layout and enter the install values once: ClioURL (no
   trailing slash), ClioAPIKey, SystemID.
4. **Scripts.** Build the `Clio Log` script per `../Clio Log.md`, then
   `Clio Daily Anchor` per `../Clio Daily Anchor.md` (it references both
   tables and the ClioAnchor layout, so it comes last).
5. **Schedule.** FMS script schedule for `Clio Daily Anchor`, daily, with
   error-email notifications on.

## Notes

- ClioSettings is one-record by convention; create that single record after
  pasting (globals do not need a record to be set via a startup script, but
  hosted files reset globals per session, so set them locally or on file open).
- ClioAnchor is append-only by convention: records are created, never edited,
  except the script writing VerifyStatus onto the record it just created.
  CreatedTS prohibits user modification.
- SystemID is a human-readable label only; Clio scopes the chain by API key.
