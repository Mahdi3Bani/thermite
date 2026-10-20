---
title: "REST API"
description: "Every route control serves, who may call it and what it returns."
type: reference
sidebar:
  order: 6
---

Control, the central service that shows and steers every [rig](glossary.md), serves an HTTP API for scripts. This page lists every route: who may call it, what it takes and what it gives back. [Script Thermite with the REST API](../how-to/automate/rest-api.md) shows how to use it. Agents use [MCP](mcp-tools.md) instead.

```sh
curl -fsS http://127.0.0.1:8800/v1/health
curl -fsS -H "Authorization: Bearer $(cat .dev/secrets/control-admin-token)" \
  'http://127.0.0.1:8800/v1/commands?limit=5'
```

The first request needs no token and answers `{"ok":true}`. The second uses the owner's token from a local install and answers `{"commands":[...]}`, the five newest [signed commands](signed-commands.md).

## Addresses

Control listens on `THERMITE_CONTROL_LISTEN`, by default `0.0.0.0:8800`. The local compose file publishes it on `127.0.0.1:8800`; `THERMITE_CONTROL_PORT` changes the port on your computer.

| Path | What it serves |
| --- | --- |
| `/v1/...` | This API |
| `/metrics` | [Metrics](#metrics-series) for Prometheus |
| `/v1/join/...` | [Join commands](#join-commands) |
| `/mcp` | The [MCP server](mcp-tools.md) |
| `/ui` | The dashboard. `GET /` redirects to `/ui` |

## Tokens

Every request except `GET /v1/health` sends a token as `Authorization: Bearer <token>`. [Tokens and roles](tokens.md) says how each token is made.

| Token | Routes it may call |
| --- | --- |
| None | `GET /v1/health` |
| Owner | Every route under [Routes for people and scripts](#routes-for-people-and-scripts) |
| Reader | `GET /metrics` and `GET /v1/rigs/<rig>/live` only |
| Operator, agent | None. These tokens work only on [MCP](mcp-tools.md) |
| A rig's own token | The [routes used by rigs](#routes-used-by-rigs), for that rig only |
| A join token | The two [join routes](#join-commands), once |

Request bodies are JSON, except a champion's patch, which is sent as raw bytes.

## Errors

| Status | Body | When |
| --- | --- | --- |
| 401 | `{"error":"unauthorized"}` | No token, a wrong token, or a token that may not call the route |
| 400 | `{"error":"invalid request"}` | The body does not match the route's schema. The schema's own message is not sent back. Control writes it to its output and to its audit log, as action `failed` |
| 403 | `{"error":"this rig is retired in control"}` | A rig-facing route, called for a retired rig |
| 403, 404, 409, 422 | `{"error":"<why>"}` | Route by route, as the tables below say |
| 500 | `{"error":"<why>"}` | A refusal while control does the work, such as `unknown rig rig-9`, `bad pause_run payload: …`, a refused propagation or a reset in the wrong state. It does not always mean a fault in control |

Every request that ends in an error inside control, or with a 5xx status, is written to control's output as a JSON line with `"msg":"request failed"`, and to the [audit log](#audit-log-actions) as action `failed` by actor `control`.

A `limit` in a query string is a whole number. Control keeps it between 1 and 5000; anything that is not a whole number gives the route's default.

## Routes for people and scripts

All of these take the owner's token, except where the table says otherwise. `<rig>`, `<run>` and `<id>` stand for a rig's name, a run's id and a command's or reset's id.

### Health

| Route | Token | What it does | Request | Answer |
| --- | --- | --- | --- | --- |
| `GET /v1/health` | None | Says control is up | None | `{"ok":true}` |

### Rigs and their history

| Route | Token | What it does | Request | Answer |
| --- | --- | --- | --- | --- |
| `GET /v1/rigs` | Owner | Lists the rigs that have reported and are not retired, and every rig enrolled through control | None | `{"rigs":[{id, last_seen, last_cursor, ledger_id, summary}], "enrolled":[{rig, created_at, created_by, rotated_at, retired_at}]}`. `enrolled` includes retired rigs |
| `GET /v1/rigs/<rig>/view` | Owner | One rig as the dashboard sees it: hardware, judge, runs with their champions and attempts, goals, audits, checks, model and settings | None | `{id, last_seen, stale, ledger_id, summary, supervisor, hardware, jobs, runs, recent, judge, checks, model, settings, gpu_split}`. `recent` is the newest 50 events, newest first. Each run has the fields the MCP tool [`get_run`](mcp-tools.md#get_run) returns, among them `queue` (every experiment of its experiment queue, with its state and place, as [`run_queue`](mcp-tools.md#run_queue) describes them), `rules` (the rules for its plan), `handouts` (the planner's newest 50 hand-outs, oldest first), `messages` (the owner's messages, with who read them) and `journal` (every note its agents wrote, oldest first: see [`get_run`](mcp-tools.md#get_run)). 404 `{"error":"not found"}` |
| `GET /v1/rigs/<rig>/events` | Owner | The rig's events, in the order control received them | `after`: control's sequence number, default 0. `limit`, default 500 | `{"events":[{seq, ledger_id, id, at, actor, kind, subject, body}]}`, oldest first |
| `GET /v1/rigs/<rig>/live` | Owner or reader | The live log: what the planner, the judge, each trial and the supervisor are doing now | `after`: control's line id; without it, the newest lines. `source`: `planner`, `judge`, `supervisor` or `trial:<id>`. `limit`, default 500 | `{"sources":[{source, lane, run, last_at, lines, ended}], "entries":[{id, seq, at, source, kind, text, lane, run, signed}]}`, entries oldest first. `signed` is false for the supervisor's own lines |
| `GET /v1/leaderboard` | Owner | For each campaign, each run's champion, its gain over its own baseline and the rigs whose judges cross-verified it | None | `{"campaigns":{"<campaign>":[{rig, run, mode, status, champion_seq, gain, verified_by}]}}` |
| `GET /v1/reports` | Owner | The supervisors' daily reports, in Markdown, newest first | `limit`, default 20. `rig`: one rig only | `{"reports":[{id, rig, kind, body, at}]}` |
| `GET /v1/rigs/<rig>/champions/<run>/<seq>/patch` | Owner | Downloads a published champion as a patch | None | The patch, as `text/x-diff`, with the headers `x-thermite-base-commit` (the commit it applies to) and `x-thermite-sha256`. 404 `{"error":"no patch for that champion"}` |

A live line's `kind` is `text`, `thinking`, `tool`, `result`, `message`, `status` or `log`. Control keeps the newest 20,000 live lines of each rig. [Take the result](../how-to/campaigns/take-the-result.md) uses the patch route.

### Signed commands

[Signed commands](signed-commands.md) lists every kind and its payload.

| Route | Token | What it does | Request | Answer |
| --- | --- | --- | --- | --- |
| `POST /v1/commands` | Owner | Signs a command and queues it for a rig. Control records `owner:api` as its issuer | `{rig, kind, payload, ttl_minutes}`. `kind` is any kind except `wipe_state`. `ttl_minutes` is 1 to 10080, default 60 | 201 `{"id":"<id>","status":"pending"}`. 400 `wipe_state is issued only by a full reset`. 500 `unknown rig <rig>`, `bad <kind> payload: <field>: <message>`, `the <kind> command is too large to deliver`, or, for a `message_agent`, `Write a message first.` or why nothing on the rig would read it, such as `The planner is off on this rig (Edit rig), so nothing would read it.` ([`message_agent`](signed-commands.md#message_agent) lists them) |
| `GET /v1/commands` | Owner | The newest commands, with their status and outcome | `limit`, default 100 | `{"commands":[{id, rig, kind, issued_by, issued_at, status, acked_at, outcome}]}`, newest first |
| `GET /v1/commands/<id>` | Owner | One command's status and outcome | None | `{"status":"…","outcome":…}`. 404 `{"error":"not found"}` |
| `POST /v1/commands/<id>/cancel` | Owner | Withdraws a command that is still pending | None | `{"cancelled":true}`. 404 `{"error":"no such pending command"}` |
| `POST /v1/propagate` | Owner | Sends one rig's published champion to another rig's run of the same campaign, as a `propagate` command that lasts 24 hours | `{from_rig, run, to_rig, to_run}` | 201 `{"id":"<command id>","seq":<champion seq>}`. 500 with the reason, listed below |

`POST /v1/commands` takes the owner's commands for a run's experiment queue like any other kind: `queue_add`, `queue_move`, `queue_edit`, `queue_drop`, `queue_accept` and `drop_directive`. A command's status is `pending`, `delivered`, `rejected`, `failed` or `expired`; [Statuses](signed-commands.md#statuses) says what each means and what its outcome holds. A cancelled command shows `failed`, with the outcome `{"cancelled_by":"owner:api"}`. [Cancel a pending command](../how-to/operate/cancel-a-command.md) gives the steps.

`POST /v1/propagate` refuses with one of these:

- `propagate between two different rigs`
- `no run <run> on <rig>`
- `the source run has no champion beyond its seed`
- `champion seq <n> is not published yet (it is published with the rig's next export)`
- `<to_run> runs <campaign>, not <campaign>`
- `the target works on <repo>, the champion is in <repo>`

[Run a campaign on several rigs](../how-to/campaigns/several-rigs.md) says when to propagate.

### Rig keys, enrollment and retirement

| Route | Token | What it does | Request | Answer |
| --- | --- | --- | --- | --- |
| `POST /v1/rigs/<rig>/key/accept` | Owner | Accepts the report key a rig is waiting with, if its fingerprint matches | `fingerprint` in the query: the first 16 hexadecimal characters of the SHA-256 of the key's PEM text | `{"accepted":true}`. 404 `{"error":"no pending key"}`, also for a wrong fingerprint |
| `POST /v1/rigs` | Owner | Enrolls a rig: control makes its token, returns it once and keeps only its SHA-256. A retired rig enrolled again comes back | `{"rig":"<name>"}` and nothing else. A name is 2 to 40 characters of `a-z`, `0-9` and `-`, and starts and ends with a letter or digit | 201 `{rig, token, control_public_key, control_fingerprint}`. 409 `rig <rig> is already enrolled` or `rig <rig> has its token in control's rig tokens file; change it there`. 400 `invalid request` for a bad name |
| `POST /v1/rigs/<rig>/token` | Owner | Gives an enrolled rig a new token. The old one stops working at once | None | `{rig, token}`. 409 for a rig in the rig tokens file. 404 `rig <rig> is not enrolled` |
| `POST /v1/rigs/<rig>/retire` | Owner | Retires any rig: enrolled, in the rig tokens file, or one that only reported. It leaves the lists, its reports are refused and a token control made ends. Nothing stops on the machine | None | `{rig, retired:true}`, plus `note: "its token is in control's rig tokens file: remove it there too"` for a rig in that file. 404 `no rig <rig>` |
| `POST /v1/rigs/<rig>/bring-back` | Owner | Brings a retired rig back into the lists. A token control made stays ended | None | `{rig, retired:false}`. 404 `rig <rig> is not retired` |

[Accept a rig's key](../how-to/operate/accept-a-rig-key.md) and [Make and change tokens](../how-to/operate/tokens.md) give the steps.

### Restart and full reset

| Route | Token | What it does | Request | Answer |
| --- | --- | --- | --- | --- |
| `POST /v1/rigs/<rig>/restart` | Owner | Restarts the rig's containers through the deployment driver that `THERMITE_LIFECYCLE` names | `{"components":["harness","supervisor"]}`, or no body for both | `{"restarted":[…]}`. 409 `{"error":"no deployment driver is configured"}`. 500 with the driver's error |
| `POST /v1/rigs/<rig>/reset` | Owner | Starts a full reset: pause, export, verify the push, wait for the owner, wipe, restart | `{"confirm":"reset <rig>"}` | 201 `{"reset":<id>}`. 400 `confirm with "reset <rig>"`. 500 `a reset of <rig> is already in progress` |
| `GET /v1/resets` | Owner | The newest 20 resets | None | `{"resets":[{id, rig, state, requested_by, command, export_name, through_event, detail, created_at, updated_at}]}` |
| `POST /v1/resets/<id>/confirm` | Owner | Confirms the wipe of a reset that waits for the owner | None | `{"ok":true}`. 500 `no reset <id>` or `reset <id> is <state>, not waiting for confirmation` |
| `POST /v1/resets/<id>/cancel` | Owner | Cancels a reset before its wipe. The rig's campaigns stay paused | None | `{"ok":true}`. 500 `no reset <id>`, or `reset <id> is <state>` once it is wiping or has ended |

A reset moves through these states. Control moves open resets on every 10 seconds; a step that takes longer than its limit fails the reset, and the rig's campaigns stay paused.

| State | What happens | Limit |
| --- | --- | --- |
| `start` | Control pauses the rig's running runs | |
| `quiescing` | Waits until the judge has no queued or running jobs and no command is pending | 1 hour |
| `exporting` | A full export, until the harness reports it | 30 minutes |
| `verifying` | Waits until the supervisor reports the export pushed to the results repository. Fails at once if the rig has no results repository | 1 hour |
| `awaiting_owner` | Waits for the owner to check the pushed commit and confirm | 24 hours |
| `confirmed` | Control sends the signed wipe | |
| `wiping` | Waits for the harness to report the wipe, then restarts the rig | 30 minutes |
| `done`, `failed`, `cancelled` | Ended. `detail` says why | |

The commands a reset sends last 30 minutes and carry the owner who asked as their issuer. [Stop, restart, remove or reset a rig](../how-to/operate/rig-lifecycle.md) gives the steps.

### Audit log

| Route | Token | What it does | Request | Answer |
| --- | --- | --- | --- | --- |
| `GET /v1/audit` | Owner | Control's audit log, newest first, MCP calls included | `limit`, default 200 | `{"audit":[{at, actor, action, body}]}` |

[Audit log actions](#audit-log-actions) lists the actions. [Tokens and roles](tokens.md#in-the-audit-log) lists the actors.

### GPU-cloud test pods

These test whether a rig can run on a RunPod GPU. [Test a GPU on RunPod](../how-to/install/runpod-test.md) gives the steps.

| Route | Token | What it does | Request | Answer |
| --- | --- | --- | --- | --- |
| `GET /v1/gpu-clouds/<name>/tests` | Owner | The tests on one GPU cloud from **Providers**, newest first, at most 20 | None | `[test]`. A cloud with no tests, or no such cloud, gives `[]` |
| `POST /v1/gpu-clouds/<name>/tests` | Owner | **Spends money.** Starts one test pod of the CUDA harness image. One test runs on a cloud at a time | `{gpu, cloud_type, image, disk_gb, restart, stop_after_minutes}`, all optional, nothing else. Defaults: the cheapest GPU in stock, `SECURE`, `THERMITE_RUNPOD_TEST_IMAGE`, a 40 GB disk, a stop and start after the first report (`restart: true`), and no time limit | 201 `test`. 409 with the reason |
| `GET /v1/gpu-cloud-tests/<id>` | Owner | One test | None | `test`. 404 `{"error":"not found"}` |
| `POST /v1/gpu-cloud-tests/<id>/end` | Owner | Ends a test now. Control removes its pod | None | `test`. 404 `no test <id>` |

A `test` has `id`, `cloud`, `active`, `created_by`, `phase`, `phase_words`, `cost_usd`, `findings` (what it found, in words) and `outcome` (`running`, `passed`, `failed` or `ended`), with the GPU, price, image, times and the probe's reports.

Starting a test refuses with one of these:

- `no GPU cloud "<name>"`
- `test <id> is still running on "<cloud>": end it first, or wait for it`
- `no image: give one, or set THERMITE_RUNPOD_TEST_IMAGE on control (an image RunPod can pull)`
- `the disk is 10 to 2000 GB`
- `a limit is 5 minutes or more`
- `RunPod lists no GPU type "<gpu>"`
- `RunPod has no GPU type in stock on Secure cloud` (or `Community cloud`)

### Metrics

| Route | Token | What it does | Request | Answer |
| --- | --- | --- | --- | --- |
| `GET /metrics` | Owner or reader | Control's figures in Prometheus's text format | None | `text/plain; version=0.0.4`. [Metrics series](#metrics-series) lists them |

## Join commands

A join command is what the owner copies from **Add a rig** (under "Or run it yourself, where control can't connect") or from **Make a new join command** on a rig's page. It calls one of these routes with its join token. A join token works once, within one hour. [Join a rig yourself](../how-to/install/join-a-rig.md) gives the steps.

| Route | Token | What it does | Request | Answer |
| --- | --- | --- | --- | --- |
| `GET /v1/join/<rig>/script` | The rig's join token | For a rig on a machine: control makes the rig's token now and returns a shell script that checks the machine, then writes the rig's files and Podman Quadlet units | `uid`: `0` means the script runs as root. The join command sends `uid=$(id -u)` | 200, the script as `text/plain` |
| `GET /v1/join/<rig>/manifest` | The rig's join token | For a rig in a Kubernetes namespace: the same, as a Kubernetes manifest for `kubectl apply` | None | 200, the manifest |

The last part of the path must match the join's form, `script` for a machine and `manifest` for a namespace. Errors are plain text:

| Status | Text |
| --- | --- |
| 404 | `thermite: no such join command` |
| 409 | `thermite: control's address for rigs is not set` |
| 401 | `thermite: this join command does not work: it was used, revoked or expired. Make a new one on the rig's page in Thermite.` |

## Routes used by rigs

Each rig's supervisor calls these with the rig's own token, for its own rig only. Scripts do not call them. [Trust between control and rigs](../explanation/trust.md) explains the signatures they check.

| Route | What it does | Request | Answer |
| --- | --- | --- | --- |
| `POST /v1/rigs/<rig>/ingest` | Takes the harness's signed report: new events and the rig's summary. Control keeps the rig's report key at first contact, or holds it for the owner. Then it adds the new events to [the knowledge base](knowledge-base.md#how-control-keeps-it-current); if that fails, it writes `kb_failed` to its audit log, and the report is still taken | `{rig, ledger_id, cursor, next, events, summary, generated_at, latest_event, rig_pubkey, signature}`, up to 32 MiB | `{"added":<n>}`. The refusals are listed below |
| `GET /v1/rigs/<rig>/commands/pending` | The rig's pending commands, oldest first. A command past its expiry is marked `expired` here and not returned | None | `{"commands":[<signed command>]}` |
| `POST /v1/rigs/<rig>/commands/<id>/ack` | Reports a command's delivery and outcome | `{status, outcome}`, `status` being `delivered`, `rejected` or `failed`; up to 256 KiB | `{"ok":true}`. 404 `no such pending command` |
| `POST /v1/rigs/<rig>/supervisor` | The supervisor's own figures: its relay position, export and push state, and advisor counts and spending. Not signed | Numbers and short strings only; up to 256 KiB | `{"ok":true}` |
| `POST /v1/rigs/<rig>/live` | Live-log lines: the harness's batch, signed with the rig's accepted key, and the supervisor's own lines, which are not signed | `{batch, supervisor}`; up to 4 MiB | `{"added":<n>}`. 403 `rig mismatch` or `bad live signature`. 409 `the rig's report key is not accepted yet` or `live lines must be signed with the rig's pinned key` |
| `GET /v1/rigs/<rig>/git/kits/<repo>.git/…` | A kit kept on control, served as plain HTTP Git for the supervisor to fetch | Git's file paths | The file. 404 `not found` |
| `GET /v1/rigs/<rig>/git-access/<name>` | The secret of a Git access from **Providers**, only for a rig whose assigned campaign uses it. Written to the audit log as `git_access_handed` | None | `{"kind":"ssh","private_key":…}` or `{"kind":"token","token":…,"username":…}`. 404 `no such Git access for this rig`. 500 `the Git access could not be unsealed (control's secrets key?)` |
| `GET /v1/rigs/<rig>/model-route` | The model route of the rig's agents, with its key, and the planner's | None | `{route, planner}`, each `null` or a route. 409 `the ChatGPT login could not be renewed: sign in again on the Providers page` or `the provider's key cannot be opened: enter it again` |
| `GET /v1/rigs/<rig>/advisor-routes` | The advisors' model routes, by role, where the owner gave them models, and the [outside knowledge bases](knowledge-base.md#outside-context-for-the-teacher-pair) granted to the campaigns control assigned the rig. When the knowledge bases it hands the rig differ from the last ones it handed it, none included, control writes `outside_kb_handed` to its audit log. It compares with the newest such entry for the rig, so a restart of control writes no entry of its own | None | `{teachers, combiner, auditor, panel, outside_kb}`. Each role is `null` or a route. `outside_kb` is `[{name, mcp_url, token, tool, campaigns}]`: each outside knowledge base with its token, its search tool and the campaigns whose teacher pair may search it |
| `GET /v1/rigs/<rig>/kb` | The [past research](knowledge-base.md#a-runs-knowledge-folder) for one of the rig's runs (the supervisor asks for each running run): the items of the folders its campaign may read, changed after `after`, oldest change first, without the run's own items. Only for a run control assigned to this rig, of the campaign it assigned | `?run=<run>&after=<seq>`, `after` a whole number from 0 (default 0) | `{campaign, folders, items, next, more}`: at most 500 items; `next` is the cursor for the next call, and `more` is true while more wait. 400 `run is required` or `after is a whole number from 0`. 404 `control did not assign run <run> to this rig` or `this rig has no run <run>`. 409 `run <run> is not of the campaign control assigned` |
| `POST /v1/rigs/<rig>/champions/<run>/<seq>/patch` | Uploads a published champion's patch. Control keeps it only if its SHA-256 matches the rig's signed `champion_published` event | The patch, up to 64 MiB | 201 `{"stored":true}`. 400 `bad seq`. 409 `control has no champion_published event for it yet`. 422 `the patch is not the one the rig published` |
| `POST /v1/rigs/<rig>/reports` | The supervisor's daily report | `{"kind":"daily","body":"<Markdown>"}`, the body 1 to 200,000 characters; up to 1 MiB | 201 `{"id":<n>}` |

`POST /v1/rigs/<rig>/ingest` refuses a report with one of these:

| Status | Error |
| --- | --- |
| 403 | `rig mismatch` |
| 400 | `unsigned report` |
| 403 | `bad report signature` |
| 409 | `the rig's key waits for the owner's acceptance` |
| 409 | `rig key changed: the owner must accept the new key` |
| 409 | `a report from a ledger the rig has left` |
| 409 | `a new ledger's events start at 0`, with `expected_cursor` |
| 409 | `a gap in the event stream`, with `expected_cursor` |
| 409 | `a report older than the newest one taken` |
| 409 | `report from the future` (more than 5 minutes ahead of control's clock) |

## The harness's API for proposers

Each rig's harness has an API of its own on `THERMITE_LISTEN`, by default `0.0.0.0:8700`. The rig's supervisor calls it; the local compose file publishes no port for it. A person or script submits changes from inside the harness container, at `http://127.0.0.1:8700`, with the proposer token from `THERMITE_PROPOSER_TOKEN_FILE`. `thermite submit` and `thermite status` call these routes; see the [command line](command-line.md) and [Test a kit with known candidates](../how-to/campaigns/test-a-kit.md).

| Route | Token | What it does | Request | Answer |
| --- | --- | --- | --- | --- |
| `GET /v1/health` | None | Says the harness is up | None | `{"ok":true,"rig":"<rig>"}` |
| `POST /v1/attempts` | Proposer | Submits a change as an attempt for the judge | `{run, lane, patch_base64, parent, hypothesis, claim, known_flaws}`. `patch_base64` is the base64 of `git add -A && git diff --cached --binary` against the parent. `parent` is 7 to 64 hexadecimal characters, default the champion. `hypothesis` is 1 to 4,000 characters, `claim` up to 4,000, `known_flaws` up to 50 lines of up to 1,000. Up to 32 MiB | 201 `{attempt, lifecycle, commit, violations, duplicate_of}`, `lifecycle` being `queued`, `rejected_v0` or `duplicate` |
| `GET /v1/attempts/<id>` | Proposer or supervisor | An attempt's state and verdict | None | `{attempt, run, lifecycle, commit, v0, verdict}`. `verdict` is `null` or `{"verdict":"<verdict>"}`. 404 `no attempt <id>` |

`POST /v1/attempts` refuses with 400 `run <run> is <status>`, `research campaigns take claims, not patches`, `unknown parent <commit>` or Git's message when the patch does not apply, and with 404 `no run <run>`. The harness's other routes serve its supervisor and the agents' trials, and are not for scripts. [Verdicts and states](verdicts.md) explains each lifecycle and verdict.

## Metrics series

`GET /metrics` covers every rig that has reported and is not retired. Labels are only rigs, runs, campaigns, verdicts, job states and the direction of model tokens, so the number of series stays small.

| Series | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `thermite_rig_up` | gauge | `rig` | 1 when the rig reported within the stale window, else 0 |
| `thermite_rig_report_age_seconds` | gauge | `rig` | Seconds since the rig's last report |
| `thermite_rig_jobs` | gauge | `rig`, `state` | The judge's jobs, by state |
| `thermite_run_champion_seq` | gauge | `rig`, `run`, `campaign` | The current champion's number. 1 is the starting point |
| `thermite_run_champion_gain` | gauge | `rig`, `run`, `campaign` | The champion's relative gain over the run's baseline |
| `thermite_run_attempts` | gauge | `rig`, `run`, `campaign`, `verdict` | Attempts by verdict, or by lifecycle when not judged |
| `thermite_planner_valid_ratio` | none given | `rig`, `run`, `campaign` | The planner's valid plans per epoch. Only for runs with epochs |
| `thermite_planner_fallback_ratio` | none given | `rig`, `run`, `campaign` | Fallback plans per epoch: rounds in which the lanes took queued experiments by fixed rules, not from the planner's model. Every research round counts as one. Only for runs with epochs |
| `thermite_duplicate_ratio` | none given | `rig`, `run`, `campaign` | Duplicate attempts per attempt. Only for runs with attempts |
| `thermite_trials_total` | none given | `rig`, `run`, `campaign` | Agent trials |
| `thermite_tokens_total` | none given | `rig`, `run`, `campaign`, `direction` | Model tokens, `in` or `out` |
| `thermite_research_sources`, `thermite_research_domains`, `thermite_research_verified`, `thermite_research_drafts`, `thermite_research_hypotheses` | none given | `rig`, `run`, `campaign` | Research runs only: sources, domains, verified claims, drafts and hypotheses |

The series marked "none given" have no `# HELP` or `# TYPE` line, so Prometheus treats them as untyped.

## Audit log actions

Control writes one entry for each of these to its audit log. `GET /v1/audit`, the MCP tool `control_log` and the dashboard's **Audit log** page read it. Control never deletes entries.

| Group | Actions |
| --- | --- |
| Requests | `failed` (a request that ended in an error, such as a message to the agents that control refused over the REST API), `refused` (a dashboard action control turned down, with the page's path and why, including a message to the agents that control refused before signing it, which the page shows as **Not sent.**; or an MCP call it turned down, with `tool: "mcp:<tool>"` and why, a refused message included), `mcp:<tool>` (every MCP tool call, with its inputs) |
| Sign-in | `login`, `login_throttled` |
| Commands | `command_issued`, `command_acked`, `command_expired`, `command_cancelled` |
| Rigs and keys | `rig_enrolled`, `rig_token_rotated`, `rig_retired`, `rig_brought_back`, `rig_key_pinned`, `rig_key_changed`, `rig_key_accepted`, `report_rejected`, `report_refused`, `git_access_handed` |
| Joins | `joined_rig_added`, `join_command_made`, `join_command_revoked`, `join_command_used` |
| Restart and reset | `restart`, `reset_requested`, `reset_step` |
| Providers | `model_provider_added`, `model_provider_changed`, `model_provider_deleted`, `model_provider_model_added`, `rig_model_given`, `agent_model_given`, `git_access_added`, `git_access_deleted`, `git_access_token_replaced`, `gpu_cloud_added`, `gpu_cloud_deleted`, `gpu_cloud_key_replaced` |
| Machines and clusters | `machine_added`, `machine_deleted`, `machine_host_key_trusted`, `machine_install_approved`, `machine_install_finished`, `machine_rig_created`, `machine_rig_stop`, `machine_rig_start`, `machine_rig_restart`, `machine_rig_remove`, `cluster_added`, `cluster_deleted`, `cluster_slots_set`, `cluster_rig_created`, `cluster_rig_stop`, `cluster_rig_start`, `cluster_rig_restart`, `cluster_rig_remove`, `cluster_rig_images` (a cluster rig moved onto control's images, with the old and the new) |
| Test pods | `runpod_test_started`, `runpod_test_ended`, `runpod_test_done` |
| Campaigns | `campaign_version_created` |
| Knowledge base | `kb_grant`, `kb_revoke` (a campaign's agents may, or may no longer, read another campaign's folder), `kb_failed` (adding a report's events to the knowledge base failed) |
| Outside knowledge bases | `outside_kb_added` and `outside_kb_changed` (which name the token only as `set (<hint>)`, `replaced (<hint>)` or `kept`), `outside_kb_deleted`, `outside_kb_copy_on`, `outside_kb_copy_off`, `outside_kb_sync_now`, `outside_kb_read_granted`, `outside_kb_read_revoked` (from the campaign's page or the MCP tools `kb_grant` and `kb_revoke` with `outside:<name>`), `outside_kb_item_skipped` (by `control`: a copy skipped an item whose page the outside server refused 3 syncs in a row, with the knowledge base, the campaign, the item's kind, `ref` and run, and the tries), `outside_kb_handed` (a rig's supervisor was handed other knowledge bases than before, or none any more: their names and campaigns, `[]` for none) |

## Not in the API yet

The dashboard does some things no route does yet: **New campaign**, **Settings › Providers** (outside knowledge bases included), **Edit rig**, join commands, **Add a rig**, the **Knowledge** page and a campaign's **Knowledge** and **Outside knowledge bases** sections, and the buttons on the page of a rig control set up on a machine or a cluster: stop, start, restart and remove it, and, on a cluster, update its images. A rig's setup steps, stopping, starting and restarting a cluster rig, and updating its images are also on [MCP](mcp-tools.md) (`rig_setup`, `cluster_rig`, `update_rig_images`), and so are the knowledge base's folders, search and grants (`kb_folders`, `kb_search`, `kb_grant`, `kb_revoke`), an outside knowledge base's search for a campaign's teacher pair included. There is no OpenAPI file. Both are planned in [goal 029](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/029-api-mcp-coverage.goal).
