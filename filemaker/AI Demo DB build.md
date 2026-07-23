# Building Clio into AI Demo DB

Tailored to the actual schema (from `from-filemaker/AI Demo DB.xml`,
24 base tables). This file + the deployed Clio at **https://clio-log.fly.dev**.

## Settings

`ClioSettings` one-record table, global fields:

| Field | Value |
|---|---|
| `ClioURL` | `https://clio-log.fly.dev` |
| `ClioAPIKey` | the `ai-demo` key (in `~/ClaudeProjects/clio-deployments/clio-log/NOTES.md`, minted 2026-07-23) |
| `SystemID` | `ai-demo` |

The `ai-demo` system is already registered on clio-log (server
`fm.navarre.training`, file `AI Demo DB`) with chain entry #1 appended as a
smoke test.

## Which tables get the rich payload

The OnWindowTransaction trigger fires for ALL tables; every commit logs
operation + record ID regardless. Add the `OnWindowTransaction` calc field
only where the content is worth keeping:

**Yes (business data):** Organization, Person, Phone, Invoice, InvoiceLine,
Product, Project, Task, Assignment, xSubTask, Note, Interest,
Related Product, Prompt, Class Objectives.

**No calc field (plumbing / bulk AI artifacts):** Embedding, SearchResultsAI,
AI Message, AI Report, Container, Dashboard, Hotel, HotelReview, Log.
They still log op + record ID; they just don't carry payloads. (Consider a
skip list in the trigger script for Embedding and SearchResultsAI if bulk
embedding runs get noisy: filter IN, per Soliant's best practice.)

`Log` is special: import it once via `Clio Import Log Table.md`, then retire it.

## Example OnWindowTransaction calc fields (unstored, result Text)

Organization:
```
JSONSetElement ( "{}" ;
  [ "id" ; Organization::ID ; JSONString ] ;
  [ "name" ; Organization::Name ; JSONString ] ;
  [ "city" ; Organization::City ; JSONString ] ;
  [ "org_type" ; Organization::Org Type ; JSONString ] ;
  [ "total_invoiced" ; Organization::Total Invoiced ; JSONNumber ] ;
  [ "user" ; Get ( AccountName ) ; JSONString ]
)
```

Invoice:
```
JSONSetElement ( "{}" ;
  [ "id" ; Invoice::ID ; JSONString ] ;
  [ "id_org" ; Invoice::ID_Org ; JSONString ] ;
  [ "number" ; Invoice::InvoiceNumber ; JSONNumber ] ;
  [ "date" ; Invoice::InvoiceDate ; JSONString ] ;
  [ "amount_paid" ; Invoice::AmountPaid ; JSONNumber ] ;
  [ "user" ; Get ( AccountName ) ; JSONString ]
)
```

Task:
```
JSONSetElement ( "{}" ;
  [ "id" ; Task::ID ; JSONString ] ;
  [ "id_project" ; Task::ID_Project ; JSONString ] ;
  [ "name" ; Task::Task Name ; JSONString ] ;
  [ "status" ; Task::Status ; JSONString ] ;
  [ "due" ; Task::Date Due ; JSONString ] ;
  [ "user" ; Get ( AccountName ) ; JSONString ]
)
```

Same shape for Person (ID, First, Last, Email, user), Project (ID,
Project Name, Status, Budget Amount, user), Product (ID, Brand, Model,
Retail, IsCurrent, user), etc. Rules of thumb:

- Always include the real PK and `Get ( AccountName )`. The watchdog's
  "who did that on a Sunday" questions need the account name in the payload.
- Skip embeddings, containers, raw AI responses, and giant text fields.
  Log facts, not blobs.
- Keep it cheap: this calc runs at every commit of that table.

## The three scripts to add

1. `Clio Log` from `Clio Log.md` (event-shaped logging; wire it into login,
   export, and error paths as desired). For exports, include
   `[ "rows" ; Get ( FoundCount ) ; JSONNumber ]` in the payload: the
   watchdog's big-export detector reads `payload.rows`.
2. `Clio Window Transactions` from `Clio Window Transactions.md`, set as the
   file's OnWindowTransaction trigger (File Options > Script Triggers).
3. `Clio Daily Anchor` from `Clio Daily Anchor.md`, plus the `ClioAnchor`
   table, on an FMS schedule (daily to start; hourly later if wanted).

Then run `Clio Import Log Table` once for the old Log table, and watch
https://clio-log.fly.dev light up.
