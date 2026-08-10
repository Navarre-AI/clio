# Spec: the one-line installer

What `curl -fsSL https://navarre.ai/get/clio | sh` has to do. macOS only for
now. Pythia's equivalent is the reference: it installs the Fly CLI if needed,
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
