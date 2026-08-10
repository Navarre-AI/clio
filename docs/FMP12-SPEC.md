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
| `Test Connection` | Calls `GET /v1/check/<code>`, reports the app and system it reached. Writes nothing. |
| `Open Dashboard` | Open URL to their Clio in the default browser. |

### Installing: the page shows the command, the user pastes it

There is no `Install` script. The setup page displays the one-liner with a copy
button; the user opens Terminal and pastes. Identical on macOS and Windows.

This was reconsidered and settled on 2026-08-10. The rejected alternative was
having FileMaker launch it: `Perform AppleScript` on macOS, and on Windows an
Export Field Contents to write a `.bat` followed by `Send Event` to open it,
since Send Event opens documents and applications but cannot run a command.

Why not, in order of weight:

1. A product whose pitch is "you can audit this" should not have its first act
   be invisibly driving a terminal. The user should see the command before it
   runs.
2. `Perform AppleScript` fires the macOS automation prompt, "FileMaker Pro
   wants to control Terminal", at the exact moment trust is being asked for.
3. It splits the file's behaviour by platform for no gain.

Also offer the two-step form on that page: download the script, read it, then
run it. Some of Clio's audience will not pipe curl into sh, and they are
precisely the people this product is for.

The `.fmp12` is still the front door. It hands over the command instead of
executing it, which was the valuable part: a FileMaker developer starts where
they already are and never hunts for a URL.

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

**It is its own page, and nothing on the site links to it.** Not the docs page
with the nav bar hidden: a separate page that exists only to be rendered inside
a Web Viewer. Requirements that follow from where it is displayed:

- No site header, nav, or footer. Every link on it would be an exit from an
  install the user is halfway through.
- Narrow by default and readable at Web Viewer width, not desktop width.
- No external assets that a Web Viewer might block. Self-contained.
- `noindex`, and absent from the sitemap, so it does not surface in search as a
  stray fragment of the website.

Unlisted is not secret. Assume anyone who knows the URL can read it, so nothing
on the page is sensitive: no keys, no endpoints, no customer names. It is
instructions only.

## Layout: one layout, two tabs

The file has two jobs at two different times, so a tab control splits them.

**Tab 1, "Start here"**: the Web Viewer with the live instructions from the
website, including the copy button for the install command. Useful once.

**Tab 2, "Your Clio"**: the endpoint field, `Test Connection`, and
`Open Dashboard`. Useful forever. This is where someone returns six months
later to wire up a second file or to check the log.

The split earns itself because the file gets reopened. Someone adding another
database should not scroll past instructions they already followed, and someone
mid-install should not see a Test Connection button before there is anything to
test.

Tab 2 is also the right home for the endpoint, since it is the one per-install
value pasted into every file they wire up. "What was my URL again" is then
answered by opening this file rather than hunting through Terminal scrollback.

`Open Dashboard` is an Open URL step, not a Web Viewer, for the reason above: a
Web Viewer would force the master password into the file.

Nothing else on the layout. The file is a delivery vehicle, not an app.

## Fields

- `PrimaryKey`
- `onWindowTransaction` (the calc that gets copied out)
- Globals: the instructions URL, their Clio base URL, their endpoint

The first two are the only ones that leave the file.
