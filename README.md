# PR Compliance + Purchase Order

[![CI](https://github.com/uvspraneeth/sap-btp-pr-compliance/actions/workflows/ci.yml/badge.svg)](https://github.com/uvspraneeth/sap-btp-pr-compliance/actions/workflows/ci.yml) ![SAP CAP](https://img.shields.io/badge/SAP%20CAP-10-0a6ed1) ![Fiori elements](https://img.shields.io/badge/Fiori%20elements-V4-0a6ed1) ![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933) ![Runtime](https://img.shields.io/badge/CF%20runtime-384%20MB-success)

Enterprise purchase-requisition compliance and purchase-order application on **SAP BTP Cloud Foundry**, built with **SAP CAP (Node.js, CAP 10)**, **SAP HANA Cloud** and **SAP Fiori elements V4** (Horizon theme, SAP icons).

- Requesters raise PRs.
- **Four parallel compliance checks** run and are reconciled into a single outcome.
- A **3-level approval** follows. Level 2 uses **parallel approvers**, and approvers can decide from the **Outlook email** or in the app.
- The approved PR becomes a **Purchase Order**, which goes through **PR↔PO reconciliation** and is then posted to **S/4HANA**.
- A **Groq LLM** gives advisory recommendations that are grounded only in this application's data.

Runtime footprint: **~384 MB** (limit 1 GB).

### Highlights

- **Stack:** SAP CAP 10 (Node.js, ESM), SAP HANA Cloud (HDI), SAP Fiori elements V4 + SAPUI5 (`sap.suite.ui.commons.ProcessFlow`), XSUAA, approuter, HTML5 Application Repository, MTA, S/4HANA OData V2 (`API_PURCHASEORDER_PROCESS_SRV`), Groq LLM, Nodemailer / Microsoft Graph.
- **Parallel process reconciliation at three points:**
  - At submit, four compliance checks run in parallel and are joined into one outcome.
  - Parallel approvers on a level are reconciled by an ALL, ANY or QUORUM rule.
  - Before posting, PR↔PO tolerance matching blocks variances until a variance approval clears them.
- **Race-safe workflow engine:** conditional updates and a row lock mean concurrent decisions advance a level exactly once. Segregation of duties is enforced, and budget commits are guarded against overspend.
- **Outlook approvals:** HMAC-signed, single-use, expiring links behind XSUAA login. Opening a link only shows a confirmation page, so link scanners can't approve anything.
- **Grounded AI:** the model sees only application data, with personal data removed, and any vendor or material it invents is dropped. It is advisory only.
- **Lean and measured:** peak RSS of 129 MB under 25 concurrent users with 0 errors, 15 MB of production dependencies, and no Cloud SDK.
- **Tested:** 59 automated tests covering the engine, an end-to-end email-to-S/4 flow, the PO and S/4 mock, mail and the AI guard. CI runs on GitHub Actions.

---

## Architecture

```
 Browser (Fiori apps)          Outlook (signed approve/reject links)
          │                                   │
          ▼                                   ▼
 ┌─────────────────────── pr-compliance (approuter, 128 MB) ──────────────────────┐
 │  XSUAA login · CSRF · security headers · UIs from HTML5 App Repository          │
 └──────────────────────────────────┬─────────────────────────────────────────────┘
                                    │ srv-api (JWT forwarded)
 ┌──────────────────────────────────▼─────────────────────────────────────────────┐
 │ pr-compliance-srv (CAP Node.js, 256 MB, stateless, 1..3 instances)              │
 │  RequisitionService · ApprovalService · PurchasingService · AdminService        │
 │  Compliance fork/join · Workflow engine · PR↔PO reconciliation · AI guard      │
 │  Persistent queue (DB-backed): mail · S/4 posting · reminders (scheduled)      │
 └───────┬────────────────────┬───────────────────────┬───────────────────────────┘
         │ HDI                │ Destination GROQ_API  │ Destination S4HANA (Internet, Basic, sap-client)
         ▼                    ▼                       ▼
   SAP HANA Cloud        Groq (OpenAI-compatible)  S/4HANA API_PURCHASEORDER_PROCESS_SRV (OData V2)
                         SMTP relay / MS Graph ◄── pr-mail (user-provided service)
```

No SAP Cloud SDK and no workflow or scheduler service are used. CAP 10's native HTTP client handles destinations and CSRF, and its persistent queue provides retries and cluster-safe scheduling.

## Process flow

```
Draft ─► Submit ─► ┌ Budget    ┐
                   ├ Vendor    ┤  (parallel)  ─► JOIN: any FAIL → Blocked
                   ├ Policy    ┤                      any WARN → proceed (flagged)
                   └ Duplicate ┘                      all PASS → proceed
        ─► L1 Line Manager (ANY)
        ─► L2 Finance ║ Procurement (parallel, ALL)   ← per-level reconciliation (ALL / ANY / QUORUM)
        ─► L3 Director (ANY of group)
        ─► Approved (budget committed) ─► Create PO ─► PR↔PO reconciliation
               (qty, price ± tol, vendor, total ± tol, budget)
               MATCHED / TOLERANCE → Post to S/4HANA (queued, idempotent, retried)
               VARIANCE → Variance approval (Finance) → Post
```

- **Idempotent decisions:** a conditional update means that a double click, an email click racing an app click, or two parallel "last" approvers still advance a level exactly once. The PR row is locked `FOR UPDATE` while the level reconciles.
- **Segregation of duties:** a requester can never approve their own PR. If they'd be resolved as the approver, the step escalates up the manager chain.
- **Budget:** committed on final approval with a guarded update, so it can't be overspent under concurrency. It's released on rejection or withdrawal and consumed when the PO is posted.

## Roles

| Role collection | Role(s) | Can do |
|---|---|---|
| `PR_Requester` | Requester | Create, submit and withdraw own PRs; create and post POs from own approved PRs |
| `PR_Approver` | Approver | Approve or reject assigned tasks (app or Outlook); read the PRs assigned to them |
| `PR_Buyer` | Buyer | Read approved PRs; manage all POs, reconciliation and S/4 posting |
| `PR_Admin` | Admin (+ all) | Master data, approval rules, settings, everything |

Approvers are resolved from the app's `Employees` table (manager chain, cost-center owner, approver groups). User IDs must match the XSUAA login (`$user`).

## Local development

```bash
npm install
npm run watch            # cds watch: SQLite in-memory, mocked auth, console mail, local S/4 mock
```

- Launchpad: http://localhost:4004/launchpad.html
- Users (the password is the same as the user name): `alice` (requester), `bob` (L1 manager), `carol` + `dan` (L2, parallel), `erin` / `frank` (L3), `grace` (buyer), `admin`.
- Emails are printed to the console, including the approve/reject links. Open a link, log in as the named approver, then confirm.
- **Posting to S/4** runs against the in-process CAP mock of `API_PURCHASEORDER_PROCESS_SRV`, which assigns numbers starting at 4500000001.
- Tests: `npm test`

### Hybrid: local app against the real S/4HANA system

Put the credentials into `.env` in the project root. This file is ignored by git and by `cf push`, and must never be committed. Use plain values without quotes, and don't put `#` or `\` inside a value:

```properties
S4_URL=https://<host>:<port>
S4_CLIENT=900
S4_USERNAME=<user>
S4_PASSWORD=<password>
GROQ_API_KEY=<your Groq key>
```

`cds watch` loads `.env` automatically in the development profile, so with `GROQ_API_KEY` set, AI recommendations work in plain `cds watch` too. Variables already set in your shell take precedence. The legacy `trial.json` (`{ "trial": { url, client, username, password } }`) is still read as a fallback.

```bash
npm run hybrid                    # S/4 reachable; remote posting is refused by the mock-mode guard
npm run hybrid -- --s4-simulate   # simulated S/4 numbers, no remote call
npm run hybrid -- --s4-live       # creates REAL purchase orders in S/4 (explicit opt-in)
```

The launcher (`scripts/hybrid.js`) passes the credentials to `cds watch --profile hybrid` through `CDS_CONFIG` and never prints them. For AI, set `GROQ_API_KEY` (and optionally `GROQ_BASE_URL`) in `.env` or in your shell.

**TLS note:** the S/4 host serves a Let's Encrypt *Generation Y* certificate but does **not** send its full chain; the cross-signed "Root YR" certificate is missing. Node therefore fails with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`.
- The app bundles the verified, public cross-signed certificate at `srv/certs/s4-ca-chain.pem`. It chains to ISRG Root X1 and has SHA-256 fingerprint `07:26:39:D0:…:07:CF:76`.
- The app sets `NODE_EXTRA_CA_CERTS`, both locally and in `mta.yaml`. **TLS verification stays enabled.**
- *Permanent fix:* the S/4 Basis team adds the intermediate to the SSL server PSE chain in `STRUST`.

## Email (Outlook approvals)

The transport is selected with `cds.requires.mail.transport` / the `pr-mail` credentials:

| Transport | Use | Needs |
|---|---|---|
| `console` | local development | nothing |
| `smtp` | **recommended now** | any SMTP relay, e.g. Brevo free tier (300/day) or a Gmail app password |
| `graph` | later, with a company tenant | Entra app registration + `Mail.Send` + **Exchange Online licensed mailbox** |

**Student account:** Azure for Students gives you an Entra tenant, and app registration is free. However, Graph `Mail.Send` needs a *licensed Exchange Online mailbox*, which student subscriptions don't include. Use SMTP instead: the emails still arrive in the approvers' **Outlook** inbox and the buttons work there.

How the email links are protected:
- Links are HMAC-signed, single-use and expire after 72 h.
- Opening a link **requires an XSUAA login as the assigned approver**.
- **GET only shows a confirmation page, and only a POST executes the decision.** Outlook Safe Links and link scanners fetch URLs with GET, so they can never approve by accident.

## AI recommendations (Groq)

- Create a BTP destination **`GROQ_API`** (see below).
- Choose the model with `cds.pr.ai.model` (default `llama-3.3-70b-versatile`).
- Turn AI off with the kill switch `cds_pr_ai_enabled=false`.
- **Advisory only:**
  - The AI never writes data.
  - It receives only aggregated data from this application's database, with no personal data.
  - Vendor or material IDs in its answer that aren't in that data are discarded.
  - Results are cached by input hash and rate-limited per user.

## Deploy to SAP BTP (Cloud Foundry)

Prerequisites:
- `cf` CLI v8 plus `cf install-plugin multiapps`.
- `npm i -g mbt`.
- **GNU make**, which `mbt build` needs on Windows: `winget install GnuWin32.Make`.
- Entitlements: HANA Cloud (`hana`/`hdi-shared` plus a running HANA Cloud instance), `xsuaa`, `destination`, `html5-apps-repo`, and optionally `autoscaler`.

```bash
cp deploy/secrets.mtaext.template deploy/secrets.mtaext   # fill in; git-ignored
mbt build -t mta_archives
cf login -a <api-endpoint>
cf deploy mta_archives/pr-compliance_1.0.0.mtar -e deploy/secrets.mtaext
# optional autoscaling (1..3 srv instances):
cf deploy mta_archives/pr-compliance_1.0.0.mtar -e deploy/secrets.mtaext,deploy/autoscaler.mtaext
```

Then, in the BTP cockpit:

1. **Destinations** (Subaccount → Connectivity → Destinations). Don't put credentials into any file in this repository.

   | Name | Type | URL | Proxy | Authentication | Additional properties |
   |---|---|---|---|---|---|
   | `S4HANA` | HTTP | `https://<s4-host>:<port>` | Internet | BasicAuthentication (S/4 user + password) | `sap-client` = `900` |
   | `GROQ_API` | HTTP | `https://api.groq.com/openai/v1` | Internet | NoAuthentication | `URL.headers.Authorization` = `Bearer <groq-api-key>` |

2. **Security → Role Collections:** assign `PR_Requester`, `PR_Approver`, `PR_Buyer` and `PR_Admin` to users.
3. **Employees:** in *Master Data*, set the user IDs to the users' XSUAA login (usually their email address) and maintain the manager chain and approver groups.

### Enabling live S/4 posting (explicit opt-in)

Production defaults to `cds.pr.s4.mode = simulate`: POs get a simulated number and nothing is sent to S/4. Once the `S4HANA` destination is tested, switch it on:

```bash
cf set-env pr-compliance-srv cds_pr_s4_mode live
cf restage pr-compliance-srv
```

Posting is queued and retried on transient errors. It's idempotent: before each retry the worker looks up an existing S/4 PO by `CorrespncExternalReference` (= our PO number). The default org keys target S/4 best-practice company **1710** (PO type `NB`, purchasing org 1710, group 001, plant 1710, USD); adjust them in *Master Data → Company Codes*.

## Memory budget

| Module | Memory | Runtime |
|---|---|---|
| `pr-compliance-srv` | 256 MB (`--max-old-space-size=150 --max-semi-space-size=8`, `MALLOC_ARENA_MAX=2`) | running |
| `pr-compliance` (approuter) | 128 MB (`--max-old-space-size=80 --max-semi-space-size=4`) | running |
| `pr-compliance-db-deployer` | 256 MB | runs once, then stopped (0 MB) |
| HTML5 app content | - | deployed into the HTML5 repo (0 MB) |
| **Total running** | **384 MB** | |
| **Max with autoscaling (3 x srv)** | **896 MB** | < 1 GB |

### Measured

The production build (`gen/srv`, production dependencies only) was load-tested locally with 25 concurrent users running 200 complete PR flows: create draft, add item, activate, submit with the parallel checks and the first approval level, read the Process Flow, and read the worklists. That is 1,400 requests, and every run finished with **0 errors**.

| V8 settings | Idle RSS | Peak RSS | Peak heap | Throughput | p95 |
|---|---|---|---|---|---|
| `--max-old-space-size=180` (V8 defaults otherwise) | 114 MB | 254 MB | 102 MB | 21 req/s | 4.0 s |
| `--max-old-space-size=150 --max-semi-space-size=4` | 89 MB | 117 MB | 48 MB | 22 req/s | 2.3 s |
| **`--max-old-space-size=150 --max-semi-space-size=8` (shipped)** | **97 MB** | **129 MB** | **50 MB** | **29 req/s** | **1.8 s** |

With the shipped settings, the peak is about half the 256 MB container limit.

These numbers are conservative. The test used SQLite, which runs inside the Node process and allows only one writer at a time. HANA Cloud runs outside the process and uses a pool of up to 10 connections per instance, so memory use is lower and throughput higher in production.

What else keeps the footprint small:
- 15 MB of production `node_modules` across 81 packages.
- The pure-JS `hdb` driver instead of the native HANA client.
- No SAP Cloud SDK: CAP 10's native fetch client handles destinations and CSRF.
- OData metadata precompiled at build time.
- No HANA tables created for the remote S/4 API model.

## Performance and scaling

- **OData V4 on the server:** `$batch`, server-side paging (default 50, max 500), and denormalized status and current level on the PR, so the worklists need no joins.
- **UI:** preload bundles; UI5 comes from the CDN, so only application code is stored in the HTML5 repo; `sap.suite.ui.commons` (Process Flow) is lazy-loaded.
- **Stateless service:** background work (mail, S/4 posting, reminders) runs on CAP's DB-backed persistent queue, which is safe with several instances and survives restarts. SLA reminders are a single scheduled task in the queue, not one per instance.
- **AI:** cached by input hash, 10 s timeout, and the PR flow carries on without AI if Groq is unavailable.

## Security

- XSUAA with instance-based `@restrict` (own PRs, assigned tasks) and segregation of duties.
- Optimistic locking through draft/ETags, and a complete audit trail (`WorkflowEvents`).
- Secrets live only in user-provided services and destinations. `trial.json`, `.cdsrc-private.json`, `.env` and `deploy/secrets.mtaext` are ignored by git and CF.
- The approuter sets `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` and HSTS. *Hardening step:* add a Content-Security-Policy that allows `https://ui5.sap.com` once the UI is final.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` calling S/4 | `NODE_EXTRA_CA_CERTS` must point to `srv/certs/s4-ca-chain.pem` (set automatically by `npm run hybrid` and in `mta.yaml`) |
| `mbt build` fails on Windows with "make not found" | install GNU make and put it on `PATH` |
| PO stays `Queued` | check `cf logs pr-compliance-srv --recent`; the queue retries up to 8 times, and stuck posts are marked `Failed` so you can retry |
| "S/4 posting disabled (mode …)" | the mode isn't `live`; see *Enabling live S/4 posting* |
| Approvers get no email | check the `pr-mail` credentials; in development, the links appear in the console log |
| 403 in the apps | assign the role collections; make sure `Employees.userId` equals the XSUAA login |
| Approuter restarts (out of memory) under load | raise the approuter to 192M (still < 1 GB in total) |
