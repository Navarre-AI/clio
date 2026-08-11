# What's left, in order

Written 2026-08-11. Three repos are involved and the order matters, because
each thing here is unusable until the one above it exists.

## 1. Clio source: read-only mode

One new secret, `VIEW_PASSWORD`. The gate already handles `?key=`; add a branch
that marks the session read-only, then point the existing `demoReadOnly` at
that instead of only at the demo. It already refuses every write ahead of every
route, which is the property worth keeping: a write route added next year is
refused the day it lands.

UI: a banner, hide Settings entirely (it holds the AI key and the webhooks),
hide the write controls. `applyDemo` already does most of this. Build the
hiding as a class, not a list of element ids, or a control added later stays
visible to viewers.

A viewer can read, search, and **ask questions**: on a customer's own instance
it is their key and their bill, and a viewer who cannot ask sees a table rather
than the product.

Same commit: **delete `ADMIN_TOKEN`.** The site password covers what it did.
Whoever holds the dashboard already controls the Fly account, so a second
password defends against nobody and leaves a third string to store.

## 2. Tag a release

The installer fetches `refs/heads/main.tar.gz`, so every push to main is
instantly what strangers install, and "update to a newer version" has no
meaning. Point it at a tag. Then a push ships nothing, and step 3 below cannot
hand out a read-only URL that a not-yet-updated Clio does not understand.

## 3. Installer rewrite

Spec is in `docs/INSTALLER-SPEC.md`. Short prompts with detail behind `?`, a
name check that shows what slugifying did and forks three ways, a region
default instead of a thirteen-code quiz, a pause before the first step that
creates or costs anything, the build explained rather than hidden, and an
ending of two URLs plus the read-only link.

Also: generate `VIEW_PASSWORD` and set it as a Fly secret. And print which Fly
org the app landed in, since it silently defaults to `personal`.

## 4. Setup page step order

Nearly right; one reorder outstanding. The field has to be edited per table at
the moment it is pasted, so those are one step, and editing the script is its
own step after it:

    3  Copy the script into your database
    4  Paste the field into each table, setting that table's key as you go
    5  Put your endpoint in the script
    6  Turn on the trigger
    7  Edit a record and watch

## 5. Clio.fmp12

- Fix the payload calc: the Let declares `id = PrimaryKey` and the loop uses
  bare `ID`, so the one line every user is told to edit does nothing.
- Fix the logging script's PSoS guard: it hands work to a server without
  checking one exists, so a single-user file logs nothing, silently. Fixed in
  `filemaker/xml/Create Clio Log Entry.xml`, not yet in the file.
- There is no Test Connection button. `GET /v1/check/<code>` exists for it now.

## Later, not now

- The installer reporting the endpoint back to the setup page
  (`/clio/start#app=...`), so nobody retypes it.
- A read-only link per person, revocable individually, instead of one secret.
- The record-scoped Web Viewer, and the 3.0 rollup of a record plus everything
  under it.
