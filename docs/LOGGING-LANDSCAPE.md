# The FileMaker logging landscape

Research snapshot, July 2026. All claims checked against current pages, not
memory; discontinued products are marked. Companion piece:
`OnWindowTransaction.md` for the capture mechanism Clio rides on.

## The table

| Name | Vendor / Author | Approach | Log lives | Tamper-evident | Multi-file / multi-server | Status | Price |
|---|---|---|---|---|---|---|---|
| OnWindowTransaction + Get(ModifiedFields) (native) | Claris | File-level script trigger, JSON per committed transaction | Wherever your script sends it | No | Per-file trigger; no aggregation story | Current (FM 20.1 through 2025) | Included |
| FileMaker Server logs | Claris | Server text logs (Event, Access, Stats, Data API, OData, WPE) | Text files on the server | No (any server admin edits them) | Per-server | Current | Included |
| bzAuditLog | Beezwax (Alec Gregory) | OnWindowTransaction | AuditLog + SchemaLog tables in FM | No | File include/exclude; no aggregation | Blog 2023, updated Jan 2025 | Free |
| DB Services audit logging | DB Services | OnWindowTransaction (surveys options) | Separate table or FM file | No | Discussed, not productized | Article Jun 2025 | Free sample |
| FM AuditLog Pro 2.0 | 1-more-thing | Scripts + custom function, PSoS-optimized | Separate table or FM file | No | Separate file yes; multi-server no | Stale (2019) | $350 |
| Elemental Log | Daniel Wood / Digital Fusion | Auto-enter calc JSON trail + GUI config | Audited tables + viewer file | No | Yes: up to 100 files into one instance | Available; Marketplace listing 404s | From $99 |
| fmDataGuard | WorldSync / Linear Blue | Plugin, zero-config capture incl. ODBC/WPE, roll-back AND roll-forward | Separate log table | No | All tables in a solution | Discontinued (~2010) | Was $150 |
| SyncDek | WorldSync / Linear Blue | Java journaling engine | External Java journal | Outside FM, not chained | Yes | Discontinued | n/a |
| UltraLog v2 | Ray Cologon / NightWing | Auto-enter Let-function trail (the classic) | Log field per record | No | Per-file | Legacy (2014) | Free |
| SeedCode "Wayback" audit log | SeedCode | UltraLog + server script exploding to rows | Log table in FM | No | Per-file | Technique, 2014 | Free |
| FMEasyAudit | Tim Dietrich | OnRecordCommit + server scripts | EasyAudit table, same file | No | Per-file | Abandoned (2014) | Free |
| NeoCode Audit Pro | NeoCode | Script-based | Separate FM file | No | Per-file | Abandoned (FM 15 era) | Free |
| MBS Plugin Audit component | MonkeyBread (Schmitz) | Plugin from auto-enter field; has Audit.Hash | AuditLog table | Per-value hash, no chain; full access can rewrite | Multi-table, not cross-file | Actively maintained (2026) | MBS licensing |
| Audit Add-On | P.K. Information Systems | FM 19 add-on | In-file | No | No | Stale (2021) | Free |
| eXcelisys audit trail | eXcelisys | Auto-enter Let variants | Field in record | No | No | FM 13-era blog series | Free |
| Super Audit Logging | Matt Petrowsky, ISO FM Magazine | Script + Let technique | Log table | No | No | Legacy | Subscription |
| FileMaker-Logger | Dan Smith | Script/dev logging framework (not record audit) | Log.fmp12, pluggable writers | No | Many solutions into one Log.fmp12 | Maintained, MIT | Free |
| Karbon DBTransactions log | Geist Interactive / Proof+Geist | Transactional scripting framework log | In-solution table | No | No | Dormant since ~2020 | Free |
| FMS Detective | Sam Rulon-Miller | macOS app parsing 12 FMS log types + AI analysis | Reads server logs | n/a (analyzer) | Multiple servers' logs | Active, v1.7 (2026) | Paid |
| FileMaker Log Viewer | LuminFire | FM file importing FMS logs | Local FM file | n/a | No | 2017 | Free |
| FMS-Log-Viewer | Mike Duncan (Soliant) | FM file for FMS logs | Local FM file | n/a | No | Dated | Free |
| Zabbix templates for FMS | Soliant / ClickWorks / DB Services | Zabbix scrapes FMS logs + health | Zabbix server (external DB) | Copies outside FM, own ACLs | Yes: many servers, one Zabbix | Active, Claris-recommended | Free |
| 24U FM Bench | 24U Software | Performance profiling logs (adjacent) | FM Bench Log file | No | Single solution | Slowly maintained | $197/seat |

(Naming note: "FMAudit" at fmaudit.com is a printer-fleet product, no
relation to FileMaker.)

## What the landscape says

Five niches: in-record auto-enter techniques (UltraLog and descendants),
the modern OnWindowTransaction starter kits (all free, all logging back
into FileMaker), plugin capture (only MBS survives; fmDataGuard, the one
true zero-config engine with roll-forward-from-backup, died with Linear
Blue), one maintained commercial product with multi-file ambition
(Elemental Log, in-FM and rewritable), and server-log tooling (Zabbix, FMS
Detective) which watches operations, not data.

**Verified empty ground, all four of Clio's axes at once:**

1. Tamper-evidence: zero products. Every FM-side audit trail can be edited
   or truncated by a full-access account, which is precisely the threat an
   audit log exists for. MBS has per-value hashing, unchained.
2. A log stored outside FileMaker as a first-class product (Beezwax lists
   external stores as an aside; nobody shipped it).
3. Aggregation of record-level audit data across multiple files AND
   multiple servers into one queryable store (Zabbix does this for ops
   metrics only; Elemental Log does multi-file but inside FM).
4. AI analysis of data changes (FMS Detective proves the appetite, but for
   performance logs).

Two ideas worth stealing from the dead: fmDataGuard's
roll-forward-since-backup (replay logged changes onto a restored backup),
and its capture of ODBC/WPE writes, which maps to today's Data API/OData
blind spot in OnWindowTransaction (Clio's answer: close it with extended
privileges, see SECURITY.md).

## The server-log monitoring category (understood, not pursued)

For completeness, the tools that watch FileMaker Server itself rather than
the data: Soliant's Zabbix templates (scrape Event/Access/Stats logs into a
Zabbix instance, the Claris-recommended monitoring path), Soliant's
FM-Admin-API-Tool (administer FMS via the Admin API) and FMS-Log-Viewer
(browse server logs in an FM file), their Punisher load-testing tool, FMS
Detective (macOS app, 12 log types, AI-assisted diagnosis, v1.7 2026), the
LuminFire log viewer, and 24U FM Bench (profiling). All of it is
operations: calls, elapsed time, CPU, disconnects, capacity. None of it
answers "which human did what to which record, and was that normal", which
is Clio's lane (see docs/WATCHDOG.md). The two categories complement rather
than compete; a shop can run Zabbix for the engine and Clio for the people.

Full source URLs live in the research transcript; key ones: Claris
OnWindowTransaction help, beezwax.net/bzmodules/bzauditlog,
dbservices.com/blog/audit-logging-in-claris-filemaker,
elemental-fm.com/elemental-log, mbsplugins.eu/component_Audit.shtml,
fmsdetective.com, github.com/soliantconsulting/FileMaker-Server-Zabbix-Templates.
