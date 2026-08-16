# The API blind spot: OData, the Data API, and what Clio cannot see

Clio's coverage rests entirely on the `OnWindowTransaction` file trigger. That
trigger has a documented hole, and for a tamper-evidence tool an undocumented
hole is far worse than a documented one. This is the documentation.

## What Claris says

> Direct access to the database via FileMaker Data API or OData API doesn't
> activate this trigger. However, scripts run via those APIs can activate it.

Source: <https://help.claris.com/en/pro-help/content/onwindowtransaction.html>

So a REST client that `PATCH`es a record straight through either API changes
your data and leaves no trace in the chain. Claris Connect flows, external web
apps, ETL jobs, mobile front-ends, anything integrating at the record level.

## Coverage table

| Write path | Fires the trigger | Notes |
|---|---|---|
| FileMaker Pro | yes | |
| FileMaker Go | yes | |
| WebDirect | yes | runs server-side; the cURL call costs a WebDirect session |
| Scripts (any client) | yes | |
| Data API: record CRUD | **no** | the blind spot |
| OData: record CRUD | **no** | the blind spot |
| Data API: run a script | yes | the escape hatch |
| OData: run a script | yes | scripts are the `Script` system table, exposed as OData actions |
| `Execute FileMaker Data API` script step | **assume no** | see below |

## The `Execute FileMaker Data API` question

FileMaker 21 gave this step write operations (`create`, `update`, `delete`,
`duplicate`), and it runs in the current user's session. Whether its writes count
as "direct access" (invisible) or as a script commit (logged) is not stated
anywhere we could find, and the published wording points at invisible.

**Treat it as invisible until tested.** The test is two minutes: put the step in
a script, run it, look at the Feed. Until then, do not use it for writes in a
file whose audit trail matters.

## Mitigation 1: integrate through scripts, never through records

The second Claris sentence is the whole fix. Both APIs can execute a script, and
a script that commits records does fire the trigger.

The rule for anyone integrating with a Clio-logged file:

> Do not write records. Call a script that writes records.

Costs a little performance. Buys complete coverage. Applies to both APIs, with
one caveat for OData: its scripts run server-side, equivalent to
`Perform Script on Server`, so they must use only web-compatible script steps.

This should be stated in the Clio README as a deployment requirement, not
buried as a tip.

## Mitigation 2: reconciliation sweep

Scripts-only is a policy, and policies are broken by people who never read them.
The only way to catch what the trigger structurally cannot see is to look for
the evidence of it afterwards.

Periodically, Clio (or a companion) compares FileMaker's own record counts and
modification timestamps against what the chain says should exist:

- per table: FileMaker's record count vs the count implied by the log
- per table: FileMaker's newest modification timestamp vs the log's newest entry
- drift in either direction means an invisible writer

A drift finding is a warning like any other, through the existing scan
pipeline, with its own fingerprint so it dedupes.

This is deliberately cheap and approximate. It does not reconstruct the missing
change, it only proves one happened. For an audit tool that is the important
half: "something wrote here without being logged" is the finding.

The counts can come from OData (`/$count` is cheap) or from a small FileMaker
script the sweep calls. Reading via OData to detect writes that bypassed the log
is a pleasing use of the same API that caused the problem.

## What this does not claim

FileMaker cannot be made tamper-proof, and Clio does not pretend otherwise.
Anyone with full access can edit scripts, and anyone who can edit the Clio script
can mute it. Clio's guarantee is narrower and still worth having:

- the record lives outside the file, so altering data and altering the record of
  it are two separate acts against two separate systems
- the chain makes edits to past entries detectable
- the anchor lives in FileMaker, so the log server alone cannot rewrite history

Separation of duties protects the record from the person editing **data**. It
does not protect it from the person editing **code**. Say so plainly.

## Suppression should announce itself

Where logging is deliberately muted (see the mute pattern in `Clio.md`), post one
entry recording that fact before going quiet. A gap in the chain is otherwise
indistinguishable from a quiet afternoon, and a documented gap is worth far more
than an invisible one.
