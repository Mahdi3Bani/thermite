---
title: "Script Thermite with the REST API"
description: "Read rigs, runs and results, and issue commands, from your own scripts with control's REST API."
type: how-to
sidebar:
  order: 2
---

Control's REST API lets a script read rigs and runs, issue commands and follow them, and download results. This page shows the calls you'll use most, with `curl`. The [REST API reference](../../reference/rest-api.md) lists every route.

## Before you start

- **The address.** The API is on control, under `/v1`: `http://127.0.0.1:8800` on the local stack, or your control's address, such as `https://control.example.com`.
- **The owner's token.** Every route for people and scripts, except `/v1/health`, needs it as `Authorization: Bearer <token>`. (The routes rigs use take each rig's own token.) Two routes also take a reader's token: `/metrics` and a rig's live log (`/v1/rigs/<rig>/live`). Operator and agent tokens don't work on the API at all: they are for [MCP](agent-over-mcp.md).
- **What a script can't do yet.** **New campaign**, **Settings › Providers** and **Edit rig** on the dashboard have no REST route, and neither has stopping, starting or restarting a rig on a cluster, moving it onto new images, or reading a rig's setup steps (MCP has `cluster_rig`, `update_rig_images` and `rig_setup`) ([goal 029](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/029-api-mcp-coverage.goal)). Thermite's knowledge base has no REST route for its search or for letting a campaign read another's folder (MCP has `kb_folders`, `kb_search`, `kb_grant` and `kb_revoke`, for the operator's and the owner's tokens), and outside knowledge bases have no REST route, and over MCP only their grants, through `kb_grant` and `kb_revoke` with `outside:<name>` ([goal 065](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/065-journals-and-corpus.goal)). A script can start a campaign with `thermite assign` ([Start a campaign from the command line](../campaigns/start-from-command-line.md)), but not one whose kit is described on the dashboard, and the command line can't name a [Git access](../campaigns/private-repository.md) for a private repository. Start those from **New campaign**. A campaign a script started has a page on the dashboard too, whose **Start a run** assigns it again, on the same or another rig.

Set the address and the token once in your shell. The examples use the owner's token file of the local stack, `.dev/secrets/control-admin-token`. If you made an owner's token of your own, use its file instead. On the local stack:

```sh
CONTROL=http://127.0.0.1:8800
AUTH="Authorization: Bearer $(cat .dev/secrets/control-admin-token)"
curl -sS "$CONTROL/v1/health"
```

The last line prints `{"ok":true}`: control is up. That route needs no token.

## List the rigs

```sh
curl -sS -H "$AUTH" "$CONTROL/v1/rigs"
```

```text
{"rigs":[{"id":"rig-1","last_seen":"…","last_cursor":120,"ledger_id":"…","summary":{…}}],"enrolled":[…]}
```

`rigs` holds every rig that has reported and is not retired. `enrolled` holds the rigs control made tokens for, even those that haven't reported yet, and those retired since (with `retired_at` set).

## Read one rig

```sh
curl -sS -H "$AUTH" "$CONTROL/v1/rigs/rig-1/view"
```

The answer is the rig's whole page as JSON: `stale` (true when it stopped reporting), `hardware`, `judge`, `jobs`, `checks` with each check's result, `model`, `settings`, its `runs` with their champions, attempts and verdicts, and `recent`, its newest 50 events. Each run also has `queue`, every experiment in its [experiment queue](../campaigns/choose-what-runs-next.md) with its state (`proposed`, `queued`, `assigned`, `done` or `dropped`) and, for those up next, its place; `handouts`, what the planner gave each lane and why; `rules`, the rules for its plan in force; `messages`, your messages to its agents and advisors, with who read each one and the advisors' answers; and `journal`, all its agents' field notes and research notes, oldest first. Reading a rig that control doesn't know answers `404 {"error":"not found"}`; a command to such a rig answers `500` instead ([Errors to expect](#errors-to-expect)). For all of a rig's events, page through `GET /v1/rigs/rig-1/events?after=<seq>&limit=500`.

## Issue a command and follow it

Commands are how anything changes on a rig. This one pauses the run `run-1`:

```sh
curl -sS -H "$AUTH" -H 'content-type: application/json' \
  -d '{"rig":"rig-1","kind":"pause_run","payload":{"run":"run-1","reason":"checking the kit"}}' \
  "$CONTROL/v1/commands"
```

It answers `{"id":"<command id>","status":"pending"}`: control has signed the command and queued it for the rig. Add `"ttl_minutes"` to change how long it may wait for the rig (60 minutes by default, 7 days at most). [Signed commands](../../reference/signed-commands.md) lists every kind and its payload. For example, `message_agent` with `{"run":"run-1","to":"all","text":"…"}` writes to everyone working in the run, and `unkeep_message` removes a message you kept in force; [Steer a run](../campaigns/steer-a-run.md) says who reads what. Control refuses a message with no words, or one that nothing would read, with `500` and the reason, such as `{"error":"Write a message first."}`: see [If a message doesn't arrive](../campaigns/steer-a-run.md#if-a-message-doesnt-arrive). `queue_add` with `{"run":"run-1","title":"Unroll the dequantize loop by 4","position":"top"}` puts an experiment at the top of the run's queue, and `queue_move`, `queue_edit`, `queue_drop`, `queue_accept` and `drop_directive` change it further; [Choose what a run tries next](../campaigns/choose-what-runs-next.md#from-the-command-line-and-over-mcp) gives a payload for each. An `assign_campaign` sent here keeps its copied experiments (`queue`) and its background from past research (`briefing`) as you give them; over MCP, control takes their words from its own records instead ([Use past research in a new run](../campaigns/use-past-research.md)).

Follow it with its id:

```sh
curl -sS -H "$AUTH" "$CONTROL/v1/commands/<command id>"
```

Within seconds the status becomes `delivered`, and `outcome` holds the rig's answer. Other statuses are `rejected` or `failed`, with the rig's reason in `outcome`, and `expired`. `GET /v1/commands?limit=20` lists the newest commands of every rig. A command still `pending` can be [cancelled](../operate/cancel-a-command.md).

The `thermite` command line uses the same route. Run `npx thermite` in your Thermite folder, after `npm ci` and `npm run build` (see [the command line](../../reference/command-line.md)):

```sh
npx thermite command --control "$CONTROL" --token-file .dev/secrets/control-admin-token \
  --rig rig-1 --kind pause_run --payload '{"run":"run-1","reason":"checking the kit"}'
```

## Read the leaderboard

```sh
curl -sS -H "$AUTH" "$CONTROL/v1/leaderboard"
```

```text
{"campaigns":{"my-campaign":[{"rig":"rig-1","run":"run-1","mode":"hill_climb","status":"running","champion_seq":2,"gain":0.67,"verified_by":[]}]}}
```

For each hill-climb campaign, best first: each run's champion, its `gain` over the run's own starting point, measured on its own rig (0.67 is 67%), and the other rigs whose judges confirmed it (`verified_by`).

## Download a champion

A run's champion is a patch from the run's starting commit. It reaches control with the rig's next export, which comes every hour. To export at once, send an `export_now` command (payload `{}`), or press **Export now** on the rig's page; the patch is there within a minute. Then download it by run and champion number:

```sh
curl -sS -H "$AUTH" -D headers.txt -o run-1-champion-2.patch \
  "$CONTROL/v1/rigs/rig-1/champions/run-1/2/patch"
grep -i '^x-thermite' headers.txt
```

`x-thermite-base-commit` is the commit to apply the patch to, and `x-thermite-sha256` is the patch's SHA-256. Before the rig has published that champion, the answer is `404 {"error":"no patch for that champion"}`. [Take the result](../campaigns/take-the-result.md) says how to apply it.

## Errors to expect

| Answer | Why |
| --- | --- |
| `401 {"error":"unauthorized"}` | The token is missing or isn't the owner's |
| `400 {"error":"invalid request"}` | The JSON body has a missing or wrong field. The answer doesn't say which, but the `failed` entry in the audit log does (see below). The [reference](../../reference/rest-api.md) gives each route's fields |
| `404` | Control doesn't have what the route names: a rig, when you read its view; a command; a champion patch; a pending command to cancel; or a key waiting with that fingerprint |
| `409` | The action can't happen now, for example `{"error":"no deployment driver is configured"}` for a restart |
| `400` or `404` with a reason, for a command | Control refused the command before signing it, for example `{"error":"bad pause_run payload: …"}`, a message that nothing would read (`400`), or `{"error":"unknown rig rig-9"}` for a rig it doesn't know (`404`) |
| `500` with a reason | Control refused another action while doing it, for example a propagation it can't make |

Control also writes each `invalid request` and each `500` to its audit log, as a `failed` entry with the route and the reason. A command it refuses before signing it (`400` or `404` with a reason) is written as a `refused` entry, with the kind and the reason. `GET /v1/audit?limit=20` lists the newest entries.
