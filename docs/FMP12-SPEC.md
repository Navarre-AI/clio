# Spec: Clio.fmp12

The file a FileMaker developer downloads from navarre.ai. It is the front door
to the installer, the source of the two things they copy into their own
solution, and a working demo of every way to call Clio.

It ships generic. It contains no endpoint, no key, and no password, because it
gets emailed, backed up, and shared, and anything baked into it leaks with it.

## The footprint in the user's own file

Three things, and nothing else:

1. **One script, `Create Clio Log Entry`**, copied in whole, with their
   endpoint pasted into the `$url` line at the top. Everything below the
   "no changes needed" line is untouched.
2. **One field per table they want detail from, `onWindowTransaction`**, an
   unstored calculation, with that table's primary key on the first line. That
   line is the only per-table edit.
3. **The trigger.** File Options > Script Triggers > OnWindowTransaction, that
   script, **Field Name left blank** so FileMaker looks for the field by its
   default name.

Tables without the field still log operation and record ID, so coverage is
complete the moment the trigger is on.

One thing to say out loud in the instructions: the script ends in Perform
Script on Server, which runs as the user who made the change. A privilege set
that cannot execute it means those users are silently never logged. Full Access
users need nothing.

## What lives in Clio.fmp12 and is never copied out

These are the shell. They exist to get the user installed and to prove it works.

| Script | Does |
|---|---|
| `Install Clio` | Launches the installer. Platform-specific, see below. |
| `Test Connection` | Calls `GET /v1/check/<code>`, reports the app and system it reached. Writes nothing. |
| `Open Dashboard` | Open URL to their Clio in the default browser. |

### Launching the installer, per platform

Verified against Claris help, 2026-08-10.

**macOS**: `Perform AppleScript`, telling Terminal to run the curl one-liner.
One step, nothing written to disk. This is what gets built first.

**Windows**: `Send Event` can only *open a document or application*; it cannot
run an arbitrary command. So the path is Export Field Contents to write a small
`.bat` to a temp location, then `Send Event` to open it. Two steps, no plugin,
and a `.bat` sidesteps the PowerShell execution-policy problem a `.ps1` would
hit. Send Event is FileMaker Pro only: no Go, no WebDirect, no Server.

Not blocked on Windows, just a different mechanism and one more moving part.

**Open URL, not a Web Viewer, for the dashboard.** A Web Viewer cannot reliably
answer a Basic auth challenge, so it would force `?key=<site password>` into
the file, and a master password stored in a solution becomes furniture nobody
remembers is there. A browser prompts once and keeps a 30-day cookie.

## Demo scripts worth shipping

These answer "how do I log the thing the transaction trigger never sees":

- **Log a Message**: calls the logger with a hand-built payload, proving it
  works from any script, not just the trigger.
- **OnFirstWindowOpen** and **OnLastWindowClose** wired to the logger, so
  opening and quitting are logged. The transaction trigger cannot see either.
- A record-level example (OnRecordLoad or a button) for the same reason.

## The Web Viewer

One Web Viewer, pointed at a page on the website, showing the setup
instructions live.

Not a static layout of steps, and not the dashboard.

**Why live**: the file gets downloaded once and sits on a disk for years, while
the instructions will change weekly for a while. A page means a confusing step
can be fixed for everyone who has not installed yet, without reshipping the
file. It also lets the page change what it shows as the user progresses.

Its URL belongs in a global field, so the file ships generic and a blank field
leaves the viewer empty rather than broken.

## Layout

One layout, enough for the above: the Web Viewer, the three buttons, and a
field to paste the endpoint into. Nothing else. The file is a delivery vehicle,
not an app.

## Fields

- `PrimaryKey`
- `onWindowTransaction` (the calc that gets copied out)
- Globals: the instructions URL, their Clio base URL, their endpoint

The first two are the only ones that leave the file.
