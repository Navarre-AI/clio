# Installing Clio

macOS. About ten minutes, most of it waiting for a deploy.

You need a Fly.io account (a Clio instance runs a few dollars a month) and
FileMaker Pro. You do **not** need Node, Docker, an Anthropic key, a FileMaker
account for Clio, OData, the Data API, or any change to FileMaker Server.
Clio never connects to FileMaker. Everything travels outbound from your file.

## 1. Put Clio in your own cloud

```
curl -fsSL https://navarre.ai/get/clio | sh
```

It installs the Fly CLI if you don't have it, signs you in, asks which region
to run in (pick the one nearest your FileMaker server), creates the app and its
volume, deploys, and opens your browser.

Two things it prints once. Keep both:

- **Your endpoint**, `https://<your-app>.fly.dev/v1/log/clio_in_...`. This goes
  in FileMaker. It carries a connection code that can only append entries.
- **Your site password**, `clio_ui_...`. This opens the dashboard and can read
  everything. It is not the same secret, and it does not belong in FileMaker.

The address of your Clio is itself worth keeping quiet.

## 2. Wire up a FileMaker file

Nothing here touches FileMaker Server.

1. From the dashboard, download **Clio.fmp12** and open it.
2. Copy the **Create Clio Log Entry** script into your own file. (FileMaker to
   FileMaker copy and paste, no plugin needed.)
3. In your copy, paste your endpoint into the single `$url` line at the top.
   The dashboard has a copy button for it. Nothing below that line changes.
4. Copy the **onWindowTransaction** field into every table you want detail
   from. In each table, set the first line of the calculation to that table's
   primary key. That one line is the only edit.
5. **File > File Options > Script Triggers**, tick **OnWindowTransaction**,
   choose **Create Clio Log Entry**, and leave **Field Name** blank.
6. If your privilege sets are locked down, set `Create Clio Log Entry` to
   **executable** in each one. The script ends in Perform Script on Server,
   which runs as the user who made the change, so a user who cannot run it will
   silently not be logged. Full Access users need nothing.

Tables without the field still log the operation and the record ID, so
coverage is complete the moment the trigger is on. Add the field table by table
as you decide you want detail.

## 3. See it work

Edit a record. Open your dashboard. The file appears as a new database asking
to be named. Name it, and its entries are there to read, sort, and search.

## 4. Optional, whenever you like

**An Anthropic key**, pasted into Settings, turns on Ask the logs, plain-English
warnings, and describing new rules in conversation. Without it Clio still
watches: four rules are active from first boot and the daily pattern scan still
files warnings. Nothing about the log depends on the key.

**A daily anchor** is the one thing that needs a FileMaker account. It stores
Clio's chain head in your own file each day, so even Clio's operator could not
rewrite history without you being able to prove it. See
`filemaker/Clio Daily Anchor.md`. Skip it until you want it.

## Adding another file later

Copy the script, paste that file's own endpoint, copy the field into the tables
you want, tick the trigger. About two minutes. Mint a second connection code in
the dashboard first so each file has its own chain.
