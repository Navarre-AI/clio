# Spec: the one-line installer

What `curl -fsSL https://navarre.ai/get/clio | sh` has to do. macOS first,
Windows the same shape with its own one-liner.

The user gets here by copying the command off the setup page and pasting it
into a terminal themselves. Nothing launches it for them; see
`docs/FMP12-SPEC.md` for why.

**Creating the Fly account is not automatable, and that is fine.** Run
`flyctl auth signup` (or `login`), which opens a browser at Fly's own page. The
human makes the account in their own name, accepts Fly's terms, and adds their
own payment method; the CLI catches the token and the script continues. No
third party can or should do that on someone's behalf. It is the same fact as
Matt having no access to their logs: their account, their card, their volume,
their data. Say it on the setup page as a feature rather than apologising for
it. Pythia's equivalent is the reference: it installs the Fly CLI if needed,
deploys to the user's own Fly account with Fly building in the cloud, and opens
the browser. Nothing lands on the user's machine but flyctl.

## Non-negotiables

1. **No Node, no Docker, no git clone, no folder.** Fly builds the image
   remotely from the public repo. If the user ends up with a working directory,
   the installer is wrong.
2. **Nothing is written to a file on their disk except flyctl.** Secrets are
   printed once and set as Fly secrets.
3. **It must survive being run twice.** Detect an existing app of that name and
   offer to point at it rather than failing halfway through.
4. **Every prompt has to work over a pipe.** `curl | sh` means stdin is the
   script, so read answers from `/dev/tty`, not stdin. This is the classic way
   these installers hang.

## Sequence

1. Check for `flyctl`; install via the official script if missing. Do not
   assume Homebrew.
2. `flyctl auth whoami`, and if that fails, `flyctl auth signup` or `login`.
   Both open a browser; say so before it happens.
3. Ask the app name. Suggest one, as grey placeholder text, not prefilled.
4. Ask the region. **No default**: the right answer depends on where the
   FileMaker servers posting to it live, and a wrong guess is a round trip on
   every write. Show a short list with the nearest guessed from the user's
   timezone.
5. Create the app and a 1GB volume (Fly's minimum), 512MB VM.
6. Generate `ADMIN_TOKEN` and a `clio_ui_` site password. Set as Fly secrets,
   staged.
7. Deploy. This is the slow part; say so, and keep printing something.
8. Poll `/health` until it answers.
9. Mint the first connection code via `/v1/admin/keys`.
10. Print, once and clearly separated:
    - the ingest endpoint, `https://<app>.fly.dev/v1/log/clio_in_...`
    - the dashboard URL and its `clio_ui_` password, described as a different
      secret that does not go into FileMaker
    - the admin token
11. Open the dashboard.

## Things that have already gone wrong once

- **Two secrets, both called "key".** Matt pasted the dashboard URL with the
  site password into a FileMaker script, and every log entry 404'd into
  nothing. Print them far apart, name them differently, and never show the
  site password inside a URL.
- **A blank default treated as no answer.** `setup.mjs` used to fall through to
  a prompt when a default was empty, which hung any unattended run at the
  Anthropic key question. A blank default is a real answer.
- **An idle prompt with no default.** If the user walks away, the installer
  should still be waiting, not dead.

## What it is not

Not an installer for FileMaker. It never asks for a FileMaker server, account,
password, or file name, and it never enables OData or the Data API. Clio has no
way in and does not need one.

## The wizard, rewritten (walked through 2026-08-10)

Walked the live installer line by line with Matt. The shape it should have:

**Principle: short prompt, detail behind `?`.** No prompt explains itself up
front. The person who cares types `?` and gets the reasoning; everyone else
answers in one keystroke. Applies to every question.

**1. Fly login.** One line on cost, nothing about cards or trials:
"A Clio instance starts at about $5 a month." (A shared-cpu-1x/512MB machine
plus a 1GB volume is $3.47, so this is deliberately conservative.)

**2. Name.** "Create a short name for your Clio." Then, before continuing,
resolve it and show the result, because slugifying silently changes what they
typed (`barkleys-0mint(*ER` becomes `clio-barkleys-0mint-er`):

    ✓ clio-acme.fly.dev is available          -> return to accept
    ✗ clio-acme.fly.dev is already taken      -> ask again, suggest a variant
    → clio-acme.fly.dev is yours already      -> this is the update path

Say "available", never "free": two screens earlier said $5 a month, so "free"
reads as price. Strip a pasted `.fly.dev` or `https://` BEFORE slugifying, or
the user gets clio-acme-fly-dev.fly.dev. Availability is a DNS lookup of
`<name>.fly.dev`: it resolves if taken, and it catches strangers' apps, which
`fly apps list` cannot. An app created but never deployed may have no DNS, so
treat a later `apps create` failure as the same fork.

**3. Region.** Not a wall of thirteen codes and a required answer. Default to
the timezone guess, accept return:

    Region [fra]:
                  return to accept · ? for list

**4. Pause before building.** This is the first step that creates anything or
costs anything, and today it is where hundreds of lines of Docker output start
with no explanation of what is being built or where. State it, then wait:

    Ready to build.
      Fly builds Clio in the cloud and runs it on your account.
      Nothing is installed on this computer.
      Creates:  app <name> in <region>
                1GB volume for your log
      You can change or delete it any time at fly.io.
    To proceed, press return.

Skip the pause when CLIO_APP is set: that is the signal nobody is watching.

**5. Say what the noise is before it starts.** `fly deploy` streams the whole
remote Docker build, roughly 200 lines. Matt's call (2026-08-10) is to keep it
visible and explain it, rather than hide it behind a progress indicator: for
this audience the real build output is reassurance that work is happening. What
was missing was any warning that it was coming, or that none of it needs them.
Immediately after the pause, before the first line of output:

    Building your Clio instance. This will take a few minutes.

    Many commands will go by. None of them need you.
    When it finishes you'll get the information you need to start using Clio.

Three things in three lines: what is happening, that it is noisy, and that
something useful arrives at the end. The rejected alternative was capturing the
log and printing dots, showing the log only on failure.

**6. The ending: two URLs, not three secrets.** Nobody should have to learn
that an endpoint and a dashboard password are different species. One is pasted,
one is opened:

    ✓ Clio is live.

    Paste this into FileMaker:
       https://<app>.fly.dev/v1/log/clio_in_...

    Open this in your browser:
       https://<app>.fly.dev/?key=clio_ui_...

    Both are shown once. Keep them.

    Admin token, only needed to mint more connection codes:
       clio_admin_...

**7. Verify before claiming success.** "Clio is live" should be a result, not a
hope. One call to the check endpoint proves the connection code works while the
user is still in the terminal, instead of three days later when nothing appears.

**8. Hand off, do not assign homework.** The installer's last act opens the
setup page with the endpoint already filled in
(`/clio/start#app=...&key=...`, fragment not query, so the code never reaches
the web server's logs). Steps 1 and 2 arrive pre-ticked and step 3 shows their
own endpoint with a copy button. Today the terminal prints an endpoint and the
web page asks for one, with nothing connecting them.
