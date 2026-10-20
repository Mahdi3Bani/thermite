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

Request bodies are JSON, except a champion's patch and a piece of an export's file, which are sent as raw bytes.

## Errors

| Status | Body | When |
| --- | --- | --- |
| 401 | `{"error":"unauthorized"}` | No token, a wrong token, or a token that may not call the route |
| 400 | `{"error":"invalid request"}` | The body does not match the route's schema. The schema's own message is not sent back. Control writes it to its output and to its audit log, as action `failed` |
| 403 | `{"error":"this rig is retired in control"}` | A rig-facing route, called for a retired rig |
| 409 | `{"error":"Control cannot work with this rig: …"}` | A rig-facing route, called for a rig whose protocol control cannot work with. See [Rig versions](#rig-versions) |
| 403, 404, 409, 422 | `{"error":"<why>"}` | Route by route, as the tables below say |
| 500 | `{"error":"<why>"}` | A refusal while control does the work, such as a refused propagation or a reset in the wrong state. It does not always mean a fault in control. A command that control refuses (`POST /v1/commands`) answers 400 with the reason, or 404 for an unknown rig |

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
| `GET /v1/rigs` | Owner | Lists the rigs that have reported, or that control refuses, and are not retired; every rig enrolled through control; every rig in [pull mode](../explanation/trust.md#rigs-in-pull-mode); every rig launched on a GPU cloud; and control's own build | None | `{"control":{version, commit, protocol, oldest_protocol}, "rigs":[{id, last_seen, last_cursor, ledger_id, summary, state, version}], "enrolled":[{rig, created_at, created_by, rotated_at, retired_at}], "pull":[{rig, pod, url, port, box_public, code_expires_at, config, pod_sign_public, pod_box_public, enrolled_at, last_exchange_at, refused_total, error, created_at, created_by}], "runpod":[runpod rig]}`. `state` is `reporting`, `stale` or `offline`, and `version` is the rig's builds against control's: see [Rig versions](#rig-versions). A rig that never sent a report has `last_seen` `1970-01-01T00:00:00.000Z`. `enrolled` includes retired rigs. In `pull`, `pod` and `url` are `null` until the pod is launched, `code_expires_at` is `null` when the code does not expire, the pod's keys are `null` until it enrolls, `refused_total` counts the requests the pod refused, and `error` is what control's last connection to the pod found. No code, path or private key is in it. `runpod` is as in [Rigs on a GPU cloud](#rigs-on-a-gpu-cloud) |
| `GET /v1/rigs/<rig>/view` | Owner | One rig as the dashboard sees it: hardware, judge, runs with their champions and attempts, goals, audits, checks, model and settings | None | `{id, last_seen, stale, state, version, ledger_id, summary, supervisor, hardware, jobs, runs, recent, judge, checks, model, settings, gpu_split}`, and `runpod` for a rig launched on a GPU cloud (a `runpod rig`, as in [Rigs on a GPU cloud](#rigs-on-a-gpu-cloud)). `stale` is true when `state` is `stale` or `offline`. `recent` is the newest 50 events, newest first. Each run has the fields the MCP tool [`get_run`](mcp-tools.md#get_run) returns, among them `queue` (every experiment of its experiment queue, with its state and place, as [`run_queue`](mcp-tools.md#run_queue) describes them), `rules` (the rules for its plan), `handouts` (the planner's newest 50 hand-outs, oldest first), `messages` (the owner's messages, with who read them) and `journal` (every note its agents wrote, oldest first: see [`get_run`](mcp-tools.md#get_run)). 404 `{"error":"not found"}` |
| `GET /v1/rigs/<rig>/runs/<run>/untried` | Owner | One run's untried experiments, ready to start a new run's queue: what **Copy the untried experiments of** in **Start a run** copies, and what `thermite assign --queue-from` sends | `campaign`: the new run's campaign; the run's own when not given | `{rig, run, campaign, queue}`. `campaign` is the run's own. `queue` holds its experiments up next, in their order, then its lanes' ideas, at most 500, each as `assign_campaign`'s [`queue`](signed-commands.md#assign_campaign) takes it: `{title, details?, family?, why?, by, state, from: {run, id}}`. Control takes the words and the author from its own records of the run, as MCP's `issue_command` does, when the run's campaign is `campaign` or one whose folder `campaign` may read; otherwise the author is `copied`. 404 `{"error":"no rig <rig>"}` or `{"error":"no run <run> on <rig>"}` |
| `GET /v1/rigs/<rig>/events` | Owner | The rig's events, in the order control received them | `after`: control's sequence number, default 0. `limit`, default 500 | `{"events":[{seq, ledger_id, id, at, actor, kind, subject, body}]}`, oldest first |
| `GET /v1/rigs/<rig>/live` | Owner or reader | The live log: what the planner, the judge, each trial and the supervisor are doing now | `after`: control's line id; without it, the newest lines. `source`: `planner`, `judge`, `supervisor` or `trial:<id>`. `limit`, default 500 | `{"sources":[{source, lane, run, last_at, lines, ended}], "entries":[{id, seq, at, source, kind, text, lane, run, signed}]}`, entries oldest first. `signed` is false for the supervisor's own lines |
| `GET /v1/leaderboard` | Owner | For each campaign, each run's champion, its gain over its own baseline and the rigs whose judges cross-verified it | None | `{"campaigns":{"<campaign>":[{rig, run, mode, status, champion_seq, gain, verified_by}]}}` |
| `GET /v1/reports` | Owner | The supervisors' daily reports, in Markdown, newest first | `limit`, default 20. `rig`: one rig only | `{"reports":[{id, rig, kind, body, at}]}` |
| `GET /v1/rigs/<rig>/champions/<run>/<seq>/patch` | Owner | Downloads a published champion as a patch | None | The patch, as `text/x-diff`, with the headers `x-thermite-base-commit` (the commit it applies to) and `x-thermite-sha256`. 404 `{"error":"no patch for that champion"}` |
| `GET /v1/rigs/<rig>/exports` | Owner | The [exports](exports.md) the rig sent to control, newest first | None | `{"exports":[{name, full, from_event, through_event, files, files_kept, bytes, bytes_received, created_at, complete_at}]}`. `complete_at` is `null` until every file is kept |
| `GET /v1/rigs/<rig>/exports/<name>` | Owner | One export on control: its manifest and each file | None | `{name, full, from_event, through_event, files, files_kept, bytes, bytes_received, created_at, complete_at, manifest}`, with `files` as `[{path, size, sha256, kept}]`. 404 `{"error":"no such export"}` |
| `GET /v1/rigs/<rig>/exports/<name>/file` | Owner | Downloads one file of an export on control | `?path=<path>` | The file, as `application/octet-stream`, with the header `x-thermite-sha256`. 404 `no such file in that export` (also for a file not kept yet) or `the file is gone from control's folder` |
| `GET /v1/rigs/<rig>/results-left` | Owner | Whether all of the rig's results have left it: in its results repository, or on control | `?export=<name>`: also that export. Optional | `{left, why, to, waiting, champions_waiting, reported_at}`. [Have all results left the rig?](exports.md#have-all-results-left-the-rig) explains each field and answer |

A live line's `kind` is `text`, `thinking`, `tool`, `result`, `message`, `status` or `log`. Control keeps the newest 20,000 live lines of each rig. [Take the result](../how-to/campaigns/take-the-result.md) uses the patch route.

### Signed commands

[Signed commands](signed-commands.md) lists every kind and its payload.

| Route | Token | What it does | Request | Answer |
| --- | --- | --- | --- | --- |
| `POST /v1/commands` | Owner | Signs a command and queues it for a rig. Control records `owner:api` as its issuer | `{rig, kind, payload, ttl_minutes}`. `kind` is any kind except `wipe_state`. `ttl_minutes` is 1 to 10080, default 60 | 201 `{"id":"<id>","status":"pending"}`. 400 `wipe_state is issued only by a full reset`, `bad <kind> payload: <field>: <message>`, `the <kind> command is too large to deliver`, for an `assign_campaign` whose contract asks for more than 16 lanes `This contract asks for <n> lanes. A rig runs 16 at most: it has users for lanes 1 to 16 only. Set lanes.count to 16 or fewer.`, or, for a `message_agent`, `Write a message first.` or why nothing on the rig would read it, such as `The planner is off on this rig (Edit rig), so nothing would read it.` or `This run has no goal the review panel reviews, so nothing would read it.` ([`message_agent`](signed-commands.md#message_agent) lists them). 404 `unknown rig <rig>`. 400 `Control sends no commands to <rig>.` and the reason, for a rig control [refuses](#rig-versions) |
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
- `Control sends no commands to <rig>.` and the reason, when control [refuses](#rig-versions) the receiving rig

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
| `POST /v1/rigs/<rig>/restart` | Owner | Restarts the rig's containers through the deployment driver that `THERMITE_LIFECYCLE` names. A rig launched on RunPod needs no setting: its pod stops and starts again through RunPod's API ([Stop, start, restart and terminate](#stop-start-restart-and-terminate)) | `{"components":["harness","supervisor"]}`, or no body for both. On RunPod, both parts restart together | `{"restarted":[…]}`; on RunPod, `{"restarted":["pod <pod>: it stops, then starts again"]}`. 409 `{"error":"no deployment driver is configured"}`; on RunPod, 409 with the reason, such as `a rig on RunPod runs its harness and its supervisor in one container: they restart together`. 500 with the driver's error |
| `POST /v1/rigs/<rig>/reset` | Owner | Starts a full reset: pause, export, verify the push, wait for the owner, wipe, restart | `{"confirm":"reset <rig>"}` | 201 `{"reset":<id>}`. 400 `confirm with "reset <rig>"`. 409, for a rig on RunPod, `<rig>'s pod is stopped: start it first, so its results can leave it before the wipe`, or `a stop of <rig> is under way: wait until it ends` (likewise a start, a restart or a terminate). 500 `a reset of <rig> is already in progress` |
| `GET /v1/resets` | Owner | The newest 20 resets | None | `{"resets":[{id, rig, state, requested_by, command, export_name, through_event, detail, created_at, updated_at}]}` |
| `POST /v1/resets/<id>/confirm` | Owner | Confirms the wipe of a reset that waits for the owner | None | `{"ok":true}`. 500 `no reset <id>` or `reset <id> is <state>, not waiting for confirmation` |
| `POST /v1/resets/<id>/cancel` | Owner | Cancels a reset before its wipe. The rig's campaigns stay paused | None | `{"ok":true}`. 500 `no reset <id>`, or `reset <id> is <state>` once it is wiping or has ended |

A reset moves through these states. Control moves open resets on every 10 seconds; a step that takes longer than its limit fails the reset, and the rig's campaigns stay paused.

| State | What happens | Limit |
| --- | --- | --- |
| `start` | Control pauses the rig's running runs | |
| `quiescing` | Waits until the judge has no queued or running jobs and no command is pending | 1 hour |
| `exporting` | A full export, until the harness reports it | 30 minutes |
| `verifying` | Waits until the supervisor reports the export pushed to the results repository, or, for a rig without one, until control holds every file of it. On RunPod, also until no other export or champion's patch waits on the pod. Fails at once if the rig has nowhere to send it | 1 hour |
| `awaiting_owner` | Waits for the owner to check the pushed commit and confirm | 24 hours |
| `confirmed` | Control sends the signed wipe | |
| `wiping` | Waits for the harness to report the wipe, then restarts the rig | 30 minutes |
| `done`, `failed`, `cancelled` | Ended. `detail` says why | |

The commands a reset sends last 30 minutes and carry the owner who asked as their issuer. [Stop, restart, remove or reset a rig](../how-to/operate/rig-lifecycle.md) gives the steps.

On a rig launched on RunPod, a reset starts only while its pod runs and no stop, start, restart or terminate is under way; one asked for otherwise (from the dashboard, say) fails at its `start` state with the same reason. At `wiping`, the pod and its GPU stay: the harness and the supervisor restart themselves in it, and `detail` says `wiped; the pod and its GPU stay: the harness and the supervisor restarted themselves in it`. Its steps are in the rig's history (`reset_requested`, `reset_done`, `reset_failed`, `reset_cancelled`).

### Audit log

| Route | Token | What it does | Request | Answer |
| --- | --- | --- | --- | --- |
| `GET /v1/audit` | Owner | One page of control's audit log, newest first, MCP calls included | `limit`, default 200. `before`: only entries older than this cursor. `after`: only entries newer than it, the page just after the cursor | `{"audit":[{id, at, actor, action, body}], "older", "newer"}`. 400 `before and after are whole numbers`, or `give before or after, not both` |

To page through the whole log, give `older` as `before` for the next older page, and `newer` as `after` for the next newer one. Each is `null` when no entry is left that way. For example, `GET /v1/audit?limit=500` answers the newest 500 entries and `"older":3512`; then `GET /v1/audit?limit=500&before=3512` answers the 500 before them. [Audit log actions](#audit-log-actions) lists the actions. [Tokens and roles](tokens.md#in-the-audit-log) lists the actors.

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

### Rigs on a GPU cloud

The owner launches rigs on RunPod with these routes, the MCP tool [`runpod_launch`](mcp-tools.md#runpod_launch) or [`thermite runpod launch`](command-line.md#runpod-launch), and stops, starts, restarts and terminates them with the routes in [Stop, start, restart and terminate](#stop-start-restart-and-terminate). Only the owner's token may launch a rig, change its limits or change its pod: an operator's, an agent's or a reader's token gets 401. A rig runs the [one-container rig image](harness-image.md#the-one-container-rig-image) in [pull mode](../explanation/trust.md#rigs-in-pull-mode). Control enrolls it once its pod runs, and follows its pod every 30 seconds.

| Route | Token | What it does | Request | Answer |
| --- | --- | --- | --- | --- |
| `POST /v1/gpu-clouds/<name>/rigs` | Owner | **Spends money.** Launches a rig on the GPU cloud `<name>` from **Providers**: one pod, billed by the hour from now until it is stopped or removed | `{gpu, gpu_count, cloud_type, datacenter, image, container_disk_gb, volume_gb, rig, enroll_within_minutes, settings, spend_limit_usd, idle_stop_minutes}`. Only `gpu` is required, nothing else is taken. See below | 201 `runpod rig`. 409 with the reason. 400 `invalid request` for a field of the wrong type or a field it does not take |
| `GET /v1/gpu-clouds/<name>/rigs` | Owner | The rigs launched on one GPU cloud, newest first | None | `[runpod rig]`. No such cloud gives `[]` |
| `GET /v1/rigs/<rig>/runpod` | Owner | One rig launched on a GPU cloud, with its history | None | `runpod rig` and `history`: `[{at, step, ok, detail, words}]`, oldest first. The steps are those the MCP tool [`rig_setup`](mcp-tools.md#rig_setup) lists; `words` says a RunPod step in words, such as `Pod stopped: its GPU is no longer billed, and its volume stays`, and is `null` for another step, such as a model download. 404 `{"error":"not found"}` |
| `POST /v1/rigs/<rig>/runpod/limits` | Owner | Sets or clears the rig's spend limit and idle stop | `{spend_limit_usd, idle_stop_minutes}`: a number sets one, `null` clears it, and one left out stays | `runpod rig`. 404 `no rig <rig> on a GPU cloud`. 400 with the reason |

What a launch takes:

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `gpu` | string | required | A GPU type's id or name from RunPod's list (**Providers**, or the MCP tool `providers`) |
| `gpu_count` | 1 to 8 | `1` | GPUs in the pod |
| `cloud_type` | `SECURE` | `SECURE` | Secure cloud on demand. `COMMUNITY` is refused: Community cloud comes in a later version. The GPU type must be offered on Secure cloud |
| `datacenter` | string | any: RunPod chooses | A data center's id from RunPod's list |
| `image` | string | control's `THERMITE_RUNPOD_RIG_IMAGE` | The one-container rig image (CUDA), at a registry RunPod can pull from |
| `container_disk_gb` | 10 to 2000 | `40` | The container's own disk, which RunPod empties when the pod stops |
| `volume_gb` | 10 to 10000 | `100` | The pod's volume at `/workspace`, which keeps the rig's state, inbox and outbox when the pod stops. Model files need about twice their size free |
| `rig` | string | `rp-` and 8 hexadecimal characters | The rig's name: 2 to 40 characters of a-z, 0-9 and -, a name no other rig has |
| `enroll_within_minutes` | number above 0 | none: the code does not expire | The one-time enrollment code expires this long after the launch |
| `settings` | object | `{"THERMITE_TARGET":"cuda-gpu","THERMITE_GPUS":"0,…"}`, one index for each GPU | The rig's [settings](settings.md) at enrollment, over the defaults. Only `THERMITE_TARGET`, `THERMITE_TARGET_CLASS`, `THERMITE_GPUS`, `THERMITE_GPU_INDEX`, `THERMITE_DEV_GPU_INDEX`, `THERMITE_JUDGE_GPUS`, `THERMITE_MAX_TRIALS`, `THERMITE_TRIAL_MINUTES` and `THERMITE_PROMOTION`, with values of letters, digits and `. _ , : -` |
| `spend_limit_usd` | number above 0 | none | Control stops the pod once it has cost this much |
| `idle_stop_minutes` | 5 or more | none | Control stops the pod once no run has run on the rig for this long, counted from its enrollment, its last start, or the setting of the stop, whichever is latest |

The pod's environment holds only pull mode's [launch values](settings.md#pull-mode): public material and the one-time code. Control's RunPod key, its tokens and every other secret stay on control. A launch that fails starts nothing, or removes the pod it started, and leaves no rig: its code can never enroll.

A `runpod rig` has `rig`, `cloud`, `pod`, `active` (control still follows the pod), `created_by`, what it was launched with (`image`, `gpu`, `gpu_name`, `gpu_count`, `cloud_type`, `datacenter`, `container_disk_gb`, `volume_gb`), `status` (the pod's status at RunPod, as control last read it, such as `RUNNING` or `EXITED`), `status_at`, `launched_at`, `price_per_hr` (USD per hour for the whole pod: RunPod's price for it, or the GPU's list price before RunPod gives one), `spend_usd` (what it has cost so far, at the prices control saw, to the cent; `null` without a price), `spend_limit_usd`, `idle_stop_minutes`, `idle_since` (since when the idle stop counts), `enrolled_at`, `stopped_at` and `stopped_by` (`spend_limit` or `idle_stop` when control stopped the pod at a limit, `owner` when the owner stopped it), `ended_at` (when RunPod no longer had the pod), `error` (what control's last read of the pod found, or why a terminate was refused) and `notes`, in words. While a stop, start, restart or terminate is under way, `op` is `{kind, by, why, phase, at, phase_at, command, export, paused}` and `op_words` says it in words, such as `stopping: waiting for its results to leave the pod`; otherwise both are `null`. `paused_runs` lists the runs the last stop paused, which the next start resumes. `last_export` is the export the last stop made, and `last_export_left` says whether it, and every result with it, had left the pod when the pod stopped.

`spend_usd` counts the time the pod ran, as control saw it, at its price per hour. It leaves out what RunPod bills for a stopped pod's volume. **Providers** shows the account's whole spend from RunPod's billing.

Neither limit has a default. A pod that reaches a limit that is set is stopped as the owner's stop is: its runs paused, its results sent out first, then the pod stopped. Its GPU is no longer billed, and its volume stays; it is never removed. A start is refused while the pod has cost its spend limit, and a pod started again in RunPod's console is stopped again at the next check, until the owner raises or clears the limit.

A launch refuses with one of these, as 409 `{"error": ...}`:

- `no GPU cloud "<name>"`
- `name a GPU type: its id or name in RunPod's list`
- `RunPod lists no GPU type "<gpu>"`
- `<gpu> is not offered on Secure cloud`
- `Community cloud comes in a later version: rigs launch on Secure cloud, on demand`
- `RunPod lists no data center "<datacenter>"`
- `a pod has 1 to 8 GPUs`
- `the container's disk is 10 to 2000 GB`, `the volume is 10 to 10000 GB`
- `the time to enroll is a number of minutes above 0`
- `a spend limit is a number of US dollars above 0`, `an idle stop is 5 minutes or more`
- `no image: give one, or set THERMITE_RUNPOD_RIG_IMAGE on control (the one-container rig image, at a registry RunPod can pull from)`
- `the rig's settings take only <names>, with values of letters, digits and . _ , : -`
- `a rig's name is 2 to 40 characters of a-z, 0-9 and -, starting and ending with a letter or digit`, `rig <rig> exists already`
- what RunPod answered, such as `RunPod answered 400 for POST /v2/pods (Bad Request: no capacity for that GPU)`, or `RunPod refused the key for this: a read-only key can't start or stop pods`

#### Stop, start, restart and terminate

These change a rig's pod through RunPod's API, the owner's alone, as the MCP tool [`runpod_rig`](mcp-tools.md#runpod_rig) and [`thermite runpod stop`](command-line.md#runpod-stop-start-restart-terminate), `start`, `restart` and `terminate` do. A restart uses the route every rig has, `POST /v1/rigs/<rig>/restart`, and a full reset `POST /v1/rigs/<rig>/reset` ([Restart and full reset](#restart-and-full-reset)). Control moves a stop or a terminate on every 30 seconds, as it follows the pod.

| Route | Token | What it does | Request | Answer |
| --- | --- | --- | --- | --- |
| `POST /v1/rigs/<rig>/runpod/stop` | Owner | Begins a stop: pauses the rig's running runs and asks for an export. Once that export and every result waiting with it have left the pod, or after 15 minutes, RunPod stops the pod | None | `runpod rig`, with `op` |
| `POST /v1/rigs/<rig>/runpod/start` | Owner | Starts a stopped pod now. Once it runs, the runs the last stop paused are resumed | None | `runpod rig` |
| `POST /v1/rigs/<rig>/runpod/terminate` | Owner | Begins a terminate: pauses the runs, waits until no judge job and no command waits on the rig, asks for a full export, and removes the pod and its volume only once every result has left it. Then it retires the rig | `{"confirm":"terminate <rig>"}` | `runpod rig`, with `op`. 400 `confirm with "terminate <rig>"` |

Each answers 404 `{"error":"no rig <rig> on a GPU cloud"}` for a rig not launched on a GPU cloud, and 409 `{"error": ...}` with the reason for a refusal:

- `<rig>'s pod is gone: RunPod no longer has it`
- `a stop of <rig> is under way: wait until it ends` (likewise a start, a restart or a terminate)
- `a full reset of <rig> is under way (<state>): cancel it, or wait until it ends`
- for a stop: `<rig>'s pod is stopped already`
- for a start: `<rig>'s pod is not stopped: RunPod says it is <status>`, or `<rig> has cost <spent>, which is at its spend limit (<limit>): raise or clear the limit first`
- for a start, when RunPod has no GPU free for the pod: `RunPod has no free GPU for pod <pod> now, so the pod stays stopped (<RunPod's answer>). Its volume stays. Try again later, or terminate it and launch a new rig`; for any other refusal by RunPod, `RunPod would not start pod <pod>: <RunPod's answer>. It stays stopped, with its volume`
- for a restart: `<rig>'s pod is stopped: start it instead of restarting it`
- for a terminate of a stopped pod: `<rig>'s pod is stopped, and results may wait on its volume (<why>): start it, so they can leave, then terminate it`

How each one goes:

| | Stop | Start | Restart | Terminate |
| --- | --- | --- | --- | --- |
| Runs | Pauses the running runs, with the reason `the owner stops the rig's pod` | Resumes the runs the last stop paused | Leaves them: they go on after the restart | Pauses the running runs, with the reason `the owner terminates the rig's pod` |
| Results | An export (`export_now`); the pod stops once it and every export and champion's patch waiting on the rig have left, or after 15 minutes, when what did not leave stays on the volume | | None: the volume keeps them | First no judge job and no command may wait (1 hour at most), then a full export (30 minutes at most), then every result must leave (1 hour at most) |
| RunPod | Stops the pod: its GPU is no longer billed, its volume stays | Starts the pod | Stops the pod, then starts it once RunPod says it stopped | Removes the pod and its volume |
| When it can't | It stops all the same, and its history says what stayed on the volume | Refused, in words; the pod stays stopped | The start is refused: the pod stays stopped, and its history says why | Refused: the pod keeps running, with its runs paused, `error` says why, and its history has `runpod_terminate_refused` |

A rig whose harness never reported holds no result: a stop or a terminate then acts on the pod at once. A stopped pod is terminated at once only when its last stop's export and every result with it had left the pod. A stop, start or restart may give the pod a different GPU, or none: RunPod keeps a stopped pod's GPU for no one, and a start says so when it has none free. When the pod runs with fewer GPUs than it was launched with, its history says so.

Each change is a step in the rig's history (`GET /v1/rigs/<rig>/runpod`, or [`rig_setup`](mcp-tools.md#rig_setup), which lists the steps), and in control's audit log: see [Audit log actions](#audit-log-actions).

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

Each rig's supervisor calls these with the rig's own token, for its own rig only. Scripts do not call them. [Trust between control and rigs](../explanation/trust.md) explains the signatures they check. Each call carries the supervisor's build in headers, and each answers 409 with the reason while control refuses the rig: see [Rig versions](#rig-versions). A rig in [pull mode](../explanation/trust.md#rigs-in-pull-mode) has no token: its supervisor makes the same calls, and control answers them in-process, through its connection to the pod, on these routes only. From the network, these routes always need a rig's token.

| Route | What it does | Request | Answer |
| --- | --- | --- | --- |
| `POST /v1/rigs/<rig>/ingest` | Takes the harness's signed report: new events and the rig's summary. Control keeps the rig's report key at first contact, or holds it for the owner. Then it adds the new events to [the knowledge base](knowledge-base.md#how-control-keeps-it-current); if that fails, it writes `kb_failed` to its audit log, and the report is still taken | `{rig, ledger_id, cursor, next, events, summary, generated_at, latest_event, rig_pubkey, signature}`, up to 32 MiB | `{"added":<n>}`. The refusals are listed below |
| `GET /v1/rigs/<rig>/commands/pending` | The rig's pending commands, oldest first. A command past its expiry is marked `expired` here and not returned | None | `{"commands":[<signed command>]}` |
| `POST /v1/rigs/<rig>/commands/<id>/ack` | Reports a command's delivery and outcome | `{status, outcome}`, `status` being `delivered`, `rejected` or `failed`; up to 256 KiB | `{"ok":true}`. 404 `no such pending command` |
| `POST /v1/rigs/<rig>/supervisor` | The supervisor's own figures: its relay position, where its exports go and what of them waits, its push or send state, its [model downloads](model-files.md#the-supervisors-report), and advisor counts and spending. Not signed. Control records each model download that starts or ends in the rig's history | Numbers and short strings only, at most 20 downloads; up to 256 KiB | `{"ok":true}` |
| `POST /v1/rigs/<rig>/live` | Live-log lines: the harness's batch, signed with the rig's accepted key, and the supervisor's own lines, which are not signed | `{batch, supervisor}`; up to 4 MiB | `{"added":<n>}`. 403 `rig mismatch` or `bad live signature`. 409 `the rig's report key is not accepted yet` or `live lines must be signed with the rig's pinned key` |
| `GET /v1/rigs/<rig>/git/kits/<repo>.git/…` | A kit kept on control, served as plain HTTP Git for the supervisor to fetch | Git's file paths | The file. 404 `not found` |
| `GET /v1/rigs/<rig>/git-access/<name>` | The secret of a Git access from **Providers**, only for a rig whose assigned campaign uses it. Written to the audit log as `git_access_handed` | None | `{"kind":"ssh","private_key":…}` or `{"kind":"token","token":…,"username":…}`. 404 `no such Git access for this rig`. 500 `the Git access could not be unsealed (control's secrets key?)` |
| `GET /v1/rigs/<rig>/model-route` | The model route of the rig's agents, with its key, and the planner's | None | `{route, planner}`, each `null` or a route. 409 `the ChatGPT login could not be renewed: sign in again on the Providers page` or `the provider's key cannot be opened: enter it again` |
| `GET /v1/rigs/<rig>/advisor-routes` | The advisors' model routes, by role, where the owner gave them models, and the [outside knowledge bases](knowledge-base.md#outside-context-for-the-teacher-pair) granted to the campaigns control assigned the rig. When the knowledge bases it hands the rig differ from the last ones it handed it, none included, control writes `outside_kb_handed` to its audit log. It compares with the newest such entry for the rig, so a restart of control writes no entry of its own | None | `{teachers, combiner, auditor, panel, outside_kb}`. Each role is `null` or a route. `outside_kb` is `[{name, mcp_url, token, tool, campaigns}]`: each outside knowledge base with its token, its search tool and the campaigns whose teacher pair may search it |
| `GET /v1/rigs/<rig>/kb` | The [past research](knowledge-base.md#a-runs-knowledge-folder) for one of the rig's runs (the supervisor asks for each running run): the items of the folders its campaign may read, changed after `after`, oldest change first, without the run's own items. Only for a run control assigned to this rig, of the campaign it assigned | `?run=<run>&after=<seq>`, `after` a whole number from 0 (default 0) | `{campaign, folders, items, next, more}`: at most 500 items; `next` is the cursor for the next call, and `more` is true while more wait. 400 `run is required` or `after is a whole number from 0`. 404 `control did not assign run <run> to this rig` or `this rig has no run <run>`. 409 `run <run> is not of the campaign control assigned` |
| `POST /v1/rigs/<rig>/champions/<run>/<seq>/patch` | Uploads a published champion's patch. Control keeps it only if its SHA-256 matches the rig's signed `champion_published` event | The patch, up to 64 MiB | 201 `{"stored":true}`. 400 `bad seq`. 409 `control has no champion_published event for it yet`. 422 `the patch is not the one the rig published` |
| `POST /v1/rigs/<rig>/exports/<name>` | Starts an [export](exports.md#how-an-export-is-sent) the rig sends to control, because it has no results repository, or says what control has of it | `{manifest, files}`: the export's manifest as the harness wrote it, and the size of each file the rig sends. They must be every file of the manifest, `ledger.sqlite` aside unless the export is full. Up to 8 MiB | `{"received":{"<path>":<bytes>}, "done":["<path>"], "complete":<bool>}`. 400 `not an export's name`, `the manifest names another rig`, `the export leaves out <paths>` or `the manifest does not list <paths>`. 409 `control has another export named <name> from this rig`. 503 `control keeps no exports: it has no folder for them` |
| `POST /v1/rigs/<rig>/exports/<name>/file` | One piece of one file of an export. Control checks the file's SHA-256 against the manifest when its last byte arrives, and keeps it only if they match | `?path=<path>&offset=<bytes>`, the place control has; the bytes, up to 16 MiB | `{"received":<bytes>, "done":<bool>, "complete":<bool>}`. 400 `<path> is not a file this export sends`, `offset is a whole number from 0` or `<path> has <n> bytes; this piece would go past its end`. 404 `no export <name>: start it first`. 409 `control has <n> bytes of <path>, not <offset>` or `<path> is being checked`, each with `received`. 422 `the SHA-256 of <path> is <sha256>, not the manifest's <sha256>: send it again`, with `"received":0`. 503 as above |
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
| 409 | `Control cannot work with this rig: …`, when the harness's build in the report, or the supervisor's, has a protocol control cannot work with ([Rig versions](#rig-versions)) |

## Rig versions

Control, each rig's harness and each rig's supervisor report their builds, and control compares the rig's with its own. A build is Thermite's version (from `package.json`), the source commit the image was built from, and the protocol: the version of the contract between control and a rig. This release speaks protocol 1.

- **The harness** puts its build in its signed report's summary, as `build`: `{version, commit, protocol, oldest_protocol}`.
- **The supervisor** sends its build in headers on every call to control:

| Header | Value |
| --- | --- |
| `x-thermite-version` | Thermite's version, such as `0.1.0` |
| `x-thermite-commit` | The source commit, when the image was built with `THERMITE_COMMIT` ([build arguments](settings.md#build-arguments)). Left out otherwise |
| `x-thermite-protocol` | The protocol it speaks |
| `x-thermite-oldest-protocol` | The oldest protocol of the other side it works with |

A part that sends no build is from before version checks: its build is unknown. For the supervisor, that is a report, a supervisor-figures call or a command fetch without the headers. A malformed value counts as not sent. Control records each part's build when it changes, with `since`, the time it first saw it.

`GET /v1/rigs`, `GET /v1/rigs/<rig>/view`, the MCP tool [`list_rigs`](mcp-tools.md#list_rigs) and [`thermite rig list`](command-line.md#rig-list) give each rig's `version`:

| Field | Type | Meaning |
| --- | --- | --- |
| `state` | string | `current`, `behind`, `ahead`, `unknown` or `refused`, as below |
| `notice` | string or null | What to know and do, in plain words. Null when the rig runs control's version |
| `refused` | `{reason, since}` or null | Why control refuses the rig, and since when |
| `control` | `{version, commit, protocol, oldest_protocol}` | Control's own build. `commit` is null when control's image was built without one |
| `harness`, `supervisor` | `{version, commit, protocol, oldest_protocol, since}` or null | What each part last reported. Null when it reports no build. A part it did not send, or sent malformed, is null |

| `state` | When | `notice` |
| --- | --- | --- |
| `current` | Both parts run control's version. Their commits may differ | Null |
| `behind` | A part runs an older version than control, and control works with it | `This rig runs an older Thermite than control: harness 0.1.0, supervisor 0.1.0. Control runs 0.2.0. Control still works with it. Update the rig's images.` |
| `unknown` | A part sends no version, or one that is not a semantic version | `The rig's harness and supervisor send no version. Their images are older than version checks. Control still works with it.` |
| `ahead` | A part runs a newer version than control, and control works with it | `This rig runs a newer Thermite than control: … Control still works with it. Update control.` |
| `refused` | A part's protocol and control's do not meet | The reason, as below |

Versions compare as semantic versions: `0.2.0` is after `0.1.9`, and `0.2.0-rc.1` is before `0.2.0`. When the parts differ, `refused` comes first, then `behind`, `unknown`, `ahead` and `current`.

### When control refuses a rig

Control refuses a rig only when it knows both protocols and they do not meet. A build with no protocol is never refused. A part's protocol does not meet control's when:

- it is older than the oldest protocol control works with: `Control cannot work with this rig: its supervisor speaks protocol 1, and control works with protocols 2 to 3. Update the rig's images.`;
- or the oldest protocol it works with is newer than control's: `Control cannot work with this rig: its harness works with protocol 4 or later, and control speaks protocol 3. Update control.`

While control refuses a rig:

- every route the rig calls answers 409 with the reason, so control takes none of its reports and it fetches no commands. Its supervisor's log has the reason in its `relay error` and `command relay error` lines;
- `POST /v1/commands`, `POST /v1/propagate`, the MCP tools that issue commands and the dashboard refuse commands for it with `Control sends no commands to <rig>.` and the reason;
- the rig is in `GET /v1/rigs` even if it never reported (then its `state` is `offline`).

Control writes `rig_refused` to its audit log when it starts to refuse a rig, or refuses it for another reason, with the reason and the builds of control and of each part; and `rig_refusal_ended` when the rig reports a build it works with. When control starts, it checks each refused rig again against its own build.

A new release keeps working with the protocol before its own, so an update of control never cuts off the rigs that still run the release before it.

### Fields control does not know

A rig on a newer build may send fields that control does not know. Where nothing depends on the exact shape, control drops such a field, at any level, and takes the rest. The fields it knows keep their checks. This holds for:

- the supervisor's figures, `POST /v1/rigs/<rig>/supervisor`: control stores and shows only the fields it knows;
- the daily report, `POST /v1/rigs/<rig>/reports`;
- a command's acknowledgement, `POST /v1/rigs/<rig>/commands/<id>/ack`;
- the start of an export, `POST /v1/rigs/<rig>/exports/<name>`. Each file is still checked against the manifest's SHA-256;
- the supervisor's own lines in `POST /v1/rigs/<rig>/live`;
- the parts of the harness's report and live batch that are outside the signature.

These stay exact, because a signature or a key exchange depends on them:

- **The harness's signed report and live batches.** Control drops what it does not know, then checks the signature over what is left. A field that a newer harness signs in the report or in an event fails the check, with 403 `bad report signature` (`bad live signature` for live lines). A field that the supervisor adds is dropped, and the report is taken. New data from the harness goes in an event's `body` or in the report's `summary`, which control keeps as they came. A change to the signed fields is a new protocol.
- **A pod's enrollment answer** in [pull mode](../explanation/trust.md#rigs-in-pull-mode), which hands control the pod's keys: an answer with a field control does not know is refused, and the pod is not enrolled.

### Reporting, stale and offline

A rig's `state` says whether it reports: `reporting` after a report within `THERMITE_CONTROL_STALE_SECONDS` (180 s by default), `stale` after that, and `offline` after `THERMITE_CONTROL_OFFLINE_SECONDS` (900 s by default) without a report. A rig that never sent a report is `offline`. See [Settings](settings.md#address-and-state).

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
| Requests | `failed` (a request that ended in an error), `refused` (a dashboard action control turned down, with the page's path and why, including a message to the agents that control refused before signing it, which the page shows as **Not sent.**; an MCP call it turned down, with `tool: "mcp:<tool>"` and why, a refused message included; or a `POST /v1/commands` it refused, with `path`, `kind` and why), `mcp:<tool>` (every MCP tool call, with its inputs) |
| Sign-in | `login`, `login_throttled` |
| Commands | `command_issued`, `command_acked`, `command_expired`, `command_cancelled` |
| Rigs and keys | `rig_enrolled`, `rig_token_rotated`, `rig_retired`, `rig_brought_back`, `rig_key_pinned`, `rig_key_changed`, `rig_key_accepted`, `report_rejected`, `report_refused`, `rig_refused` and `rig_refusal_ended` (by `rig:<rig>`: control started or stopped refusing the rig for its protocol, with the reason and the builds; see [Rig versions](#rig-versions)), `git_access_handed` |
| Joins | `joined_rig_added`, `join_command_made`, `join_command_revoked`, `join_command_used` |
| Restart and reset | `restart`, `reset_requested`, `reset_step` |
| Providers | `model_provider_added`, `model_provider_changed`, `model_provider_deleted`, `model_provider_model_added`, `rig_model_given`, `agent_model_given`, `git_access_added`, `git_access_deleted`, `git_access_token_replaced`, `gpu_cloud_added`, `gpu_cloud_deleted`, `gpu_cloud_key_replaced` |
| Machines and clusters | `machine_added`, `machine_deleted`, `machine_host_key_trusted`, `machine_install_approved`, `machine_install_finished`, `machine_rig_created`, `machine_rig_stop`, `machine_rig_start`, `machine_rig_restart`, `machine_rig_remove`, `cluster_added`, `cluster_deleted`, `cluster_slots_set`, `cluster_rig_created`, `cluster_rig_stop`, `cluster_rig_start`, `cluster_rig_restart`, `cluster_rig_remove`, `cluster_rig_images` (a cluster rig moved onto control's images, with the old and the new) |
| Test pods | `runpod_test_started`, `runpod_test_ended`, `runpod_test_done` |
| Pull mode and rigs on RunPod | `tunnel_rig_added` (a rig minted for a pod), `tunnel_rig_pod` (its pod named), `tunnel_rig_enrolled`, `tunnel_refusals` (the requests a pod refused since its last exchange), `tunnel_rig_dropped` (a minted rig whose launch failed), `runpod_rig_launched` (by the owner: the cloud, pod, GPU and count, cloud type, data center, price, image and limits), `runpod_rig_limits` (the limits now), `runpod_rig_stop`, `runpod_rig_start`, `runpod_rig_restart` and `runpod_rig_terminate` (by the owner, as asked), `runpod_rig_stopped` (the pod stopped, why, `spend_limit`, `idle_stop` or `owner`, and the spend: by `control` at a limit, by the owner otherwise), `runpod_rig_started` (by `control`: the pod runs again, its GPUs and the runs resumed), `runpod_rig_start_refused` (by `control`: why, such as no GPU free), `runpod_rig_terminated` (by the owner: the pod removed, and the spend), `runpod_rig_terminate_refused` (by `control`: why a result could not leave) |
| Campaigns | `campaign_version_created` |
| Knowledge base | `kb_grant`, `kb_revoke` (a campaign's agents may, or may no longer, read another campaign's folder), `kb_failed` (adding a report's events to the knowledge base failed) |
| Outside knowledge bases | `outside_kb_added` and `outside_kb_changed` (which name the token only as `set (<hint>)`, `replaced (<hint>)` or `kept`), `outside_kb_deleted`, `outside_kb_copy_on`, `outside_kb_copy_off`, `outside_kb_sync_now`, `outside_kb_read_granted`, `outside_kb_read_revoked` (from the campaign's page or the MCP tools `kb_grant` and `kb_revoke` with `outside:<name>`), `outside_kb_item_skipped` (by `control`: a copy skipped an item whose page the outside server refused 3 syncs in a row, with the knowledge base, the campaign, the item's kind, `ref` and run, and the tries), `outside_kb_handed` (a rig's supervisor was handed other knowledge bases than before, or none any more: their names and campaigns, `[]` for none) |

## Not in the API yet

The dashboard does some things no route does yet: **New campaign**, **Settings › Providers** (outside knowledge bases included), **Edit rig**, join commands, **Add a rig**, the **Knowledge** page and a campaign's **Knowledge** and **Outside knowledge bases** sections, and the buttons on the page of a rig control set up on a machine or a cluster: stop, start, restart and remove it, and, on a cluster, update its images. A rig's setup steps, stopping, starting and restarting a cluster rig, and updating its images are also on [MCP](mcp-tools.md) (`rig_setup`, `cluster_rig`, `update_rig_images`), and so are the knowledge base's folders, search and grants (`kb_folders`, `kb_search`, `kb_grant`, `kb_revoke`), an outside knowledge base's search for a campaign's teacher pair included. There is no OpenAPI file. Both are planned in [goal 029](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/029-api-mcp-coverage.goal).
