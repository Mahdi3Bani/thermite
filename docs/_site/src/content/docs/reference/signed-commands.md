---
title: "Signed commands"
description: "Every command control sends to rigs: its fields, who may issue it, how it expires or is cancelled, and what the harness does with it."
type: reference
sidebar:
  order: 8
---

Control tells a [rig](glossary.md) what to do only through **signed commands**. Control signs each command with its own Ed25519 key. The rig's [supervisor](glossary.md) carries the command to the [harness](glossary.md), which checks the signature, the rig's name and the time before it does anything. The supervisor can carry a command, but it cannot make one or change one.

```json title="A signed command"
{
  "envelope": {
    "v": 1,
    "id": "3f6c2a8e-5b1d-4c7a-9e2f-0a1b2c3d4e5f",
    "rig": "rig-1",
    "kind": "pause_run",
    "issued_by": "owner:api",
    "issued_at": "2026-10-19T09:00:00.000Z",
    "expires_at": "2026-10-19T10:00:00.000Z",
    "payload": { "run": "run-1", "reason": "checking the kit" }
  },
  "signature": "<base64 Ed25519 signature>"
}
```

Commands come from the dashboard, the [REST API](rest-api.md), the [command line](command-line.md) and the [MCP tools](mcp-tools.md). All of them go through the same code in control, so a command is checked and signed the same way wherever it comes from. For the reasons behind this design, see [Trust between control and rigs](../explanation/trust.md).

## The command

| Field | Type | Meaning |
| --- | --- | --- |
| `envelope.v` | `1` | The format's version |
| `envelope.id` | UUID | The command's id. Control makes it |
| `envelope.rig` | text | The one rig that may apply it |
| `envelope.kind` | text | One of the [kinds](#every-kind) below |
| `envelope.issued_by` | text | Who issued it, as control knows them: `owner:ui`, `owner:api`, `owner:mcp`, `owner:operator`, `agent:mcp`, or the owner's actor for a full reset's steps. See [Tokens and roles](tokens.md#in-the-audit-log). The caller cannot choose it |
| `envelope.issued_at` | ISO 8601 time | When control signed it, by control's clock |
| `envelope.expires_at` | ISO 8601 time | When it stops being valid |
| `envelope.payload` | object | The kind's own fields, checked against the kind's schema before signing |
| `signature` | base64 | An Ed25519 signature over the envelope's canonical JSON |

Control's key pair is `control-signing.key` and `control-signing.pub` in control's data directory (`THERMITE_CONTROL_DIR`). Control makes the pair the first time it starts. `THERMITE_CONTROL_PUBKEY_EXPORT` copies the public key to a file for rigs, and the harness reads it from `THERMITE_CONTROL_PUBKEY_FILE`.

## How a command travels

| Step | Where | What happens |
| --- | --- | --- |
| 1. Issue | Control | Control checks that it knows the rig (it has reported and is not retired, is enrolled, or is in the rig tokens file), checks the payload against the kind's schema, signs the envelope and stores the command as `pending`. A signed command larger than 3.5 MiB is refused: `the <kind> command is too large to deliver` |
| 2. Fetch | Supervisor | The supervisor asks control for its rig's pending commands, oldest first, every `THERMITE_COMMAND_POLL_SECONDS` seconds (default 5) |
| 3. Stage | Supervisor | If the command names content to fetch (a project, a kit, a model or another rig's champion), the supervisor fetches it into the rig's inbox first. The command stays `pending` while it waits |
| 4. Apply | Harness | The supervisor posts the command to the harness, which checks it and applies it once |
| 5. Acknowledge | Supervisor | The supervisor tells control the status and the harness's answer, which become the command's status and outcome |
| 6. Confirm | Control | The harness records each command it applied in its ledger. When the rig's next signed report brings that record, control takes the status and outcome from it, in place of the supervisor's |

`GET /v1/commands/<id>`, the MCP tool `command_status` and the dashboard's **Commands** page, which lists the newest 200 commands, show a command's status and outcome.

## Statuses

| Status | Meaning | Outcome |
| --- | --- | --- |
| `pending` | Waiting for the rig's supervisor to take it, or for the content it names to arrive | None |
| `delivered` | The harness applied it | The harness's answer: `{"status": "applied", "accepted": true, "result": …}`, or `"replayed"` with the first answer |
| `rejected` | The harness refused it before applying it (HTTP 403): signature, rig, time, payload, or issued before the rig's state was wiped | `{"status": "rejected", "reason": "…"}` |
| `failed` | The harness applied it but it did not succeed, or the harness answered with another error, or its content could not be fetched, or the owner cancelled it | `{"status": "applied", "accepted": false, "result": {"error": "…"}}`; `{"http": <status>, "error": "…"}`; `{"error": "staging: …"}`; or `{"cancelled_by": "owner:api"}` |
| `expired` | It was still `pending` after `expires_at` | None |

Once control has the harness's own record of an applied command (step 6), the outcome is `{"source": "harness", "kind": …, "accepted": …, "result": …}`, and the status is `delivered` if `accepted` is true, else `failed`.

`delivered` means the harness carried the command out, not that what it started went well. A `rig_check`, for example, is `delivered` as soon as the check starts; its finding comes later, as a `rig_check_finished` event.

## Expiry and cancelling

| | Value |
| --- | --- |
| Time to live, set by the issuer (`ttl_minutes`, `--ttl`) | 1 to 10080 minutes (7 days). Default 60 |
| `propagate`, built by control (`POST /v1/propagate`, `propagate_champion`, **Send champion**) | 24 hours, because the champion may still be on its way to the results repository. A `propagate` sent through `POST /v1/commands` takes its `ttl_minutes` like any other kind |
| Every other command the dashboard sends | 60 minutes |
| A full reset's steps (`pause_run`, `export_now`, `wipe_state`) | 30 minutes each |
| Clock difference the harness allows between control and the rig | 5 minutes |

- **Expiry at control.** When the supervisor next asks for commands, control marks each pending command past its `expires_at` as `expired` and does not hand it over. Time spent fetching a command's content counts toward its time to live.
- **Expiry at the harness.** The harness refuses a command whose `expires_at` has passed by the rig's clock (`expired`), or whose `issued_at` is more than 5 minutes ahead of it (`issued in the future`).
- **Cancelling.** The owner can cancel a command while it is `pending`, with `POST /v1/commands/<id>/cancel` and the owner's token. The command becomes `failed` with the outcome `{"cancelled_by": "owner:api"}`. A command that is not pending gives `404 {"error":"no such pending command"}`. The dashboard, the command line and MCP have no way to cancel. See [Cancel a pending command](../how-to/operate/cancel-a-command.md).

## What the harness checks

The harness checks every command in this order. A command that fails a check marked `rejected` is not applied: the harness answers with HTTP 403 and records a `command_rejected` event in the rig's ledger.

| Check | Reason given | Status at control |
| --- | --- | --- |
| The command has the right shape | `malformed command` | `rejected` |
| Control's public key can be read | `control public key unusable` | `rejected` |
| The signature matches control's public key | `bad signature` | `rejected` |
| The command names this rig | `command is for rig <rig>` | `rejected` |
| It was not applied before | None: a command already applied answers `replayed` with its first answer, even if it has expired since | As the first answer |
| It is not more than 5 minutes in the future | `issued in the future` | `rejected` |
| It has not expired | `expired` | `rejected` |
| The payload fits the kind | `bad payload: <field>: <problem>` | `rejected` |
| It was issued after the rig's state was last wiped | `issued before this rig's state was wiped` | `rejected` |
| It is not being applied right now | None: the harness answers `in_progress`, and the supervisor asks again later | Stays `pending` |
| An owner-only kind was issued by the owner (`issued_by` is `owner` or starts with `owner:`) | `<kind> is the owner's to issue, not <issuer>'s` | `failed` |

The owner-only kinds are `approve_promotion`, `decline_promotion`, `accept_review`, `conclude`, `wipe_state`, `message_agent`, `unkeep_message` and `rig_settings`. The owner-only check is the first step of applying a command, so a command it refuses is recorded like any applied command, as not accepted. Every applied command is recorded in the ledger with the actor `control:<issued_by>`.

## Who may issue each kind

| Kind | Dashboard (`owner:ui`) | REST and `thermite` (`owner:api`) | MCP owner (`owner:mcp`) | MCP operator (`owner:operator`) | MCP agent (`agent:mcp`) | Owner only |
| --- | --- | --- | --- | --- | --- | --- |
| `assign_campaign` | **New campaign**; **Start the run** in the **Start a run** panel of a campaign's page | Yes; `thermite assign` | Yes | Yes | Yes | |
| `rig_check` | **Run it** in a rig's **Checks**; **Check** on **Settings** | Yes | Yes | Yes | Yes | |
| `pause_run` | **Pause** in a run's header, in the header of the run's **Live**, and on the run's card under **At work now** | Yes | Yes | Yes | Yes | |
| `resume_run` | **Resume** in a run's header, in the header of the run's **Live**, and on a paused run's row under **Earlier runs** | Yes | Yes | Yes | Yes | |
| `redirect` | **Add the rule** on a run's **Planner** tab (one rule, added to the earlier ones) | Yes | Yes | Yes | Yes | |
| `reset_workers` | **Restart the lanes**, under **⋯** in a run's header | Yes | Yes | Yes | Yes | |
| `export_now` | **Export now** on a rig's page | Yes | Yes | Yes | Yes | |
| `message_agent` | **Send** in the message box of a run's **Live**; **Send to the planner** on a run's **Planner** tab; the message box of a rig's own live view (**Live** on the rig's page) | Yes | Yes | Yes | No | Yes |
| `unkeep_message` | **Remove** in the **📌 &lt;n&gt; kept** list of a run's **Live** | Yes | Yes | Yes | No | Yes |
| `propagate` | **Send champion #&lt;n&gt;** on a run's **Planner** tab, under **Other rigs** | `POST /v1/propagate`, or `POST /v1/commands` | `propagate_champion` | `propagate_champion` | `propagate_champion` | |
| `approve_promotion` | **Needs you**: **Make it the champion**, **Overrule the auditor** | Yes | Yes | No | No | Yes |
| `decline_promotion` | **Needs you**: **Reject it** | Yes | Yes | No | No | Yes |
| `accept_review` | **Needs you**: **Accept**, **Reject** | Yes | No | No | No | Yes |
| `conclude` | **Needs you**: **End it: not possible**, **Keep going** | Yes | No | No | No | Yes |
| `rig_settings` | **Save changes** on **Edit rig**; **GPUs for the judge** on **New campaign** and in the **Start a run** panel | Yes | No | No | No | Yes |
| `wipe_state` | Only as a step of a full reset | No: `wipe_state is issued only by a full reset` | No | No | No | Yes |

Control's own lists decide what each MCP role may issue; the harness's owner-only check is a second gate behind them. The operator acts for the owner, so its `owner:operator` passes that gate for `message_agent` and `unkeep_message`. During the owner's full reset of a rig, MCP's `issue_command` refuses an agent's token for that rig: `<rig> is being reset by the owner`. [Tokens and roles](tokens.md) describes each token.

A run's **Experiments** tab, which will hold the run's experiment queue, and **Remove** on a rule on its **Planner** tab send commands that are not kinds yet: control answers `unknown command` until the rig's side of the queue lands ([goal 064](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/064-experiment-queue.goal)).

## Every kind

Ids such as `run` are lowercase ids: letters `a`–`z`, digits, `.`, `_` and `-`, starting with a letter or digit, at most 64 characters. Commits are full commit ids, 40 or 64 hexadecimal characters. A run that does not exist gives `no run <run>`.

Except where a section says control refuses, the refusals listed under each kind come while the harness applies the command. Such a command is `failed`, and its outcome's `result` is `{"error": "<the refusal>"}`.

### `assign_campaign`

Starts a run of a campaign on the rig.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `run` | lowercase id | required | The new run's id |
| `contract` | object | required | The whole [contract](contract.md) |
| `contract_sha` | 64 hexadecimal characters | required | The contract's SHA-256, as `thermite contract validate` prints it |
| `seed` | `{repo, commit}` | none | The repository (a lowercase id) and the commit the run starts from. Required for hill climb and goal campaigns; research campaigns have none |
| `direction` | text | none | Recorded with the run |
| `imports` | list of [imports](#imports) | `[]` | What the rig must take in first: the project, the kit, models |
| `agents` | boolean | worker agents run | `false`: a judge-only run |
| `promotion` | `auto` or `owner_approval` | the rig's own setting | The run's promotion rule |
| `queue` | up to 500 experiments, each `{title, details?, family?, why?, by, state, from: {run, id}}`, `state` being `queued` or `proposed` | none | Untried experiments copied from another run, in order, for the new run's queue. Rigs accept the field and do nothing with it until the rig's side of the experiment queue lands ([goal 064](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/064-experiment-queue.goal)) |

**Start a run** on a campaign's page also works for a campaign that was assigned over the REST API, MCP or the command line, with no version saved on control. Control then signs again the campaign's newest `assign_campaign` whose status is `pending` or `delivered`, as a new run: the same `contract`, `seed`, `imports` and `direction`, with a new `run`, and `agents` and `promotion` from the panel.

The harness creates the run only after every check passes. In order, it refuses:

| Message | When |
| --- | --- |
| `invalid contract: …` | The contract does not pass its schema |
| `contract hash does not match contract_sha` | The hash differs |
| `run <run> already exists` | The run id is taken on this rig |
| `contract <campaign> v<version> exists with other content` | The rig has this contract version with different content |
| `model <name> is not listed in the contract` | A `model` import the contract does not list |
| `a <mode> campaign needs a seed commit` | No `seed` for a hill climb or goal campaign |
| An import's message (see [Imports](#imports)) | An import fails |
| `model <name> (<sha256>) has not been imported` | A model the contract lists is not on the rig |
| `kit commit <commit> is not in kit <repo>; import its bundle first` | The contract's kit commit is not on the rig |
| `kit <repo> at <commit> has no valid kit.json: …` | The kit's [`kit.json`](kit-manifest.md) is missing or invalid |
| `the kit does not fit the contract: …` | The kit lacks what the contract needs |
| `seed commit <commit> is not in <repo>; import its bundle first` | The seed commit is not on the rig |

Then it creates the run as running, and pauses the rig's other running runs with the reason `replaced by <run>`. Result: `{"run", "contract_sha", "imported", "agents"}`.

### `rig_check`

Starts one of the rig's [checks](rig-checks.md).

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `check` | `model`, `isolation` or `smoke` | required | Which check |
| `force` | boolean | `false` | Run it even though the rig is busy. Isolation and smoke want an idle rig; forcing may end running trials |

Result: `{"check", "id", "started": true}`. The finding arrives later as a `rig_check_finished` event. Refusals: `this rig cannot run the <check> check`, `the <check> check is still running`, `not now: <why>`.

### `pause_run`

| Field | Type | Meaning |
| --- | --- | --- |
| `run` | lowercase id | The run |
| `reason` | text, at least 1 character | Why. The dashboard sends `paused from the dashboard` |

The run becomes `paused` with the reason. Result: `{"run", "status": "paused"}`.

### `resume_run`

| Field | Type | Meaning |
| --- | --- | --- |
| `run` | lowercase id | The run |

The run becomes `running`, and the rig's other running runs are paused: a rig runs one run at a time. A closed run is refused: `run <run> is closed`. Result: `{"run", "status": "running"}`.

### `redirect`

A set of directives for the run's planner. See [Steer a run](../how-to/campaigns/steer-a-run.md).

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `run` | lowercase id | required | The run |
| `directives` | 1 to 40 directives | required | The set |
| `replace` | boolean | `true` | Replace the set this issuer gave before. `false` adds to it |

Each directive has only these fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `kind` | `avoid`, `try`, `mandate`, `priority`, `lane_count` or `note` | `avoid`, `try` and `mandate` (**Always** on the dashboard) name a direction family; `priority` ranks one; `lane_count` sets how many lanes work, up to the contract's count; `note` is text for the planner only |
| `family` | 2 to 41 characters of `a`–`z`, `0`–`9` and `-`, starting with a letter or digit | The direction family it refers to, when the kind needs one |
| `value` | text up to 1000 characters, or a number | The value, when the kind needs one |
| `rationale` | text, 1 to 2000 characters | Why. The planner sees it; workers never do |
| `citations` | up to 20 texts of 1 to 500 characters | Sources. Default `[]` |

A set that both avoids a family and tries or mandates it is refused: `the set both avoids and asks for <families>`. Result: `{"run", "directives": [<ids>]}`.

The dashboard calls directives **rules**. **Add the rule** on a run's **Planner** tab sends one directive, `avoid`, `try` or `mandate`, with `replace: false`: it adds to the rules given from the dashboard before, and replaces none. Its **Direction** must be a direction family's name, which it sends as `family`. Other words are refused before signing, with `refused: bad redirect payload: directives.0: Unrecognized key: "match"`: rules in your own words wait for [goal 064](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/064-experiment-queue.goal).

### `reset_workers`

| Field | Type | Meaning |
| --- | --- | --- |
| `run` | lowercase id | The run |
| `reseed_commit` | commit | Accepted by the schema, but the harness refuses it: `re-seeding lanes is not available in this version; reset without it` |

The run's running trials end, along with the current [epoch](glossary.md) (a round, on the dashboard), and every lane starts again from the champion. Result: `{"run", "reset": true}`.

### `message_agent`

The owner's message to the run's agents. The judge is code and takes no messages.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `run` | lowercase id | required | The run |
| `to` | one of the recipients below | required | Who gets it |
| `text` | text, 1 to 4000 characters | required | The message |
| `keep` | boolean | `false` | `true` keeps the message in force: it goes into the brief of every new trial it is for, until an [`unkeep_message`](#unkeep_message) removes it. Only for `all` or a lane |

| `to` | Who reads it |
| --- | --- |
| `all` | Everyone working: every lane, and the planner of a hill-climb or goal run whose planner is on |
| `lane-1` to `lane-16` | That [lane](glossary.md) |
| `trial:t-` and 8 to 32 hexadecimal characters | That trial. If it ends before it reads the message, its lane's next trial reads it, with a note that it was sent to an earlier trial |
| `planner` | The planner. A research run has none |
| `advisors` | The teacher pair, the auditor and the review panel, each once, except those that a refusal below names |
| `teachers` | The teacher pair |
| `auditor` | The auditor |
| `panel` | The review panel |

Each reader reads a message once: each lane, the planner and each advisor role. Only a message kept in force is given again, to each new trial. The harness records a read when it gives the text to the agent (in a brief, at a step, in a continued session or in an advisor's package), not when the text is only fetched. When each one reads it:

| Reader | When |
| --- | --- |
| A lane with no trial at work | In the brief of its next trial |
| A worker in Pi | At its next step: after its model's current turn |
| A worker in OpenCode or Claude Code | When its current run ends without a submission. The harness then continues the session with the message |
| A worker that has submitted | It does not read it: a submission ends the trial, and the lane's next trial reads the message in its brief |
| The planner | At its next plan, if its model answers. While the planner is off, or its model can't be reached, the message waits |
| The teacher pair | In its next round. For a running run, a message starts that round: between rounds the supervisor looks for one every 5 seconds, and a round under way finishes first |
| The auditor | With its next audit |
| The review panel | With its next review |

The teacher pair, the auditor and the review panel are asked to answer each message they are given, in one or two sentences, and the harness records each answer. A message kept in force goes into every new trial's brief under `# Messages from the campaign's owner, in force`; the others go under `# Messages from the campaign's owner`.

Control refuses `keep` with any other `to` before signing: `bad message_agent payload: keep: only a message to everyone working (all) or to a lane can be kept in force`. The harness refuses a message in these cases, and records no message:

| Message | When |
| --- | --- |
| `run <run> is closed: nothing will read this message` | The run is closed |
| `a research run plans its rounds with a fixed method; it has no planner to message` | `planner`, in a research run |
| `the planner is off on this rig (Edit rig), so nothing would read this message` | `planner`, with the planner switched off on **Edit rig** |
| `the teacher pair is off on this rig (Edit rig), so nothing would read this message` | `teachers`, with the teacher pair switched off |
| `the auditor is off on this rig (Edit rig), so nothing would read this message` | `auditor`, with the auditor switched off |
| `a research run has no audits, so the auditor would never read this message` | `auditor`, in a research run |
| `the review panel is off on this rig (Edit rig), so nothing would read this message` | `panel`, with the review panel switched off |
| `this run has no goal the review panel reviews, so the panel would never read this message` | `panel`, in a run with no goal checked by review |
| `none of the advisors would read this message: <each reason, joined by "; ">` | `advisors`, when no role would read it |
| `run <run> has <n> lanes`, or `… has 1 lane` | A lane beyond the contract's number of lanes |
| `no trial t-… in run <run>` | A trial the run does not have |

The harness writes the live line `Owner to <to> (#<id>): <text>`, with `, kept in force` after the id for a kept message; a run's **Live** shows it as **To** the recipient and the text. Result: `{"message": <id>, "to", "keep", "readers", "note"}`. `readers` lists who will read it: lanes, `planner`, `teachers`, `auditor` or `panel`. `note` is there only for a trial that has ended: `trial t-… has ended; lane-<n>'s next trial reads this`.

The run's ledger records the message with its text (`agent_message`), each reader's first read (`agent_message_read`) and each advisor's answer (`advisor_answer`). The run's **Live** shows all three.

### `unkeep_message`

Removes a message from force: new trials' briefs no longer carry it, and no reader that has not read it yet is given it.

| Field | Type | Meaning |
| --- | --- | --- |
| `run` | lowercase id | The run |
| `message` | positive whole number | The message's id: `message` in the result of its `message_agent` |

The harness refuses: `no message <id> in run <run>`, `message <id> is not kept in force`, and `message <id> was already removed from force at <time>`. The live view shows `the owner's message #<id> is no longer in force`, and the ledger records `agent_message_unkept`. Result: `{"message": <id>, "unkept": true}`.

### `propagate`

Another rig's published champion, sent as a candidate for this rig's judge. Control builds it from the source rig's signed report. See [Run a campaign on several rigs](../how-to/campaigns/several-rigs.md).

| Field | Type | Meaning |
| --- | --- | --- |
| `run` | lowercase id | The run on this rig |
| `source_rig` | text | The rig the champion comes from |
| `source_run` | lowercase id | Its run |
| `source_seq` | positive whole number | The champion's number in that run |
| `import` | a `champion_patch` [import](#imports) | The champion as a patch, with its path `propagate/<rig>/<run>/<seq>.patch` |

Control refuses to build one: `propagate between two different rigs`, `no run <run> on <rig>`, `the source run has no champion beyond its seed`, `champion seq <n> is not published yet (it is published with the rig's next export)`, `<run> runs <campaign>, not <campaign>`, `the target works on <repo>, the champion is in <repo>`.

The supervisor takes the patch from the [results repository](../how-to/operate/results-repository.md), and waits while it is not there yet. The harness then refuses: `research campaigns do not take propagations`, `propagate takes a champion_patch import (a published champion)`, `the champion is in <repo>; this run works on <repo>`, `base commit <commit> is not in this rig's repository`, `the champion patch does not apply to the base: …`, `tree mismatch: the signed tree is <tree>, the patch gives <tree>`. If this rig's champion already has the same files, the result is `{"identical": true, "note": "this rig's champion already has the same tree"}`. Otherwise the patch becomes an attempt that this rig's judge measures against its own champion. Result: `{"attempt", "lifecycle", "tree"}`.

### `export_now`

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `full` | boolean | `false` | `true` also writes the research archive and a snapshot of the ledger. A full reset asks for a full export |

The harness writes an export to its outbox for the supervisor to push. Result: `{"export", "export_id", "through_event", "attempts", "events"}`.

### `wipe_state`

Only control's full reset issues it, as the owner who asked for the reset, after the owner confirmed the wipe. See [Stop, restart, remove or reset a rig](../how-to/operate/rig-lifecycle.md).

| Field | Type | Meaning |
| --- | --- | --- |
| `confirm` | `"wipe"` | Must be exactly this |
| `export` | text, 1 to 100 characters | The full export that reached the results repository |
| `through_event` | whole number, 0 or more | The last event that export holds |

The harness refuses: `no export <export> in this rig`, `export <export> is not a full export`, `the export does not cover the events`, and `research was recorded after the export (<what>): export again`. Otherwise it pauses the running runs, and the rig's state is wiped when the harness next starts, a few seconds later. The rig keeps its own signing key. Result: `{"wiping": true, "export"}`.

### `approve_promotion`

| Field | Type | Meaning |
| --- | --- | --- |
| `run` | lowercase id | The run |
| `attempt` | text, 1 to 64 characters | The attempt |

Promotes a confirmed win that waits for the owner, or overrules an audit that is pending or that blocked it. The judge's verdict must still allow promotion, and approving an attempt with declared flaws accepts them. If the champion moved since the attempt was judged, it is measured again against the new champion. Refusals: `attempt <attempt> is not in <run>`, `attempt <attempt> is <lifecycle>, not awaiting approval`, `no pending promotion for <attempt>`.

### `decline_promotion`

| Field | Type | Meaning |
| --- | --- | --- |
| `run` | lowercase id | The run |
| `attempt` | text, 1 to 64 characters | The attempt |
| `note` | text up to 2000 characters | Optional. Why |

The attempt never becomes the champion and stays in the record as `declined`. Refusals: `attempt <attempt> is not in <run>`, `attempt <attempt> is <lifecycle>: there is nothing to decline`. Result: `{"attempt", "declined": true, "was"}`.

### `rig_settings`

The rig's own settings, as on its **Edit rig** page. Only the fields that change are sent, and no other field is allowed.

| Field | Type | Meaning |
| --- | --- | --- |
| `judge` | boolean | The judge builds and measures. Off: changes wait in its queue |
| `workers` | boolean | Workers start trials. Off: no new trial starts |
| `lanes` | 1 to 16 | Trials at the same time |
| `planner` | boolean | The planner gives each worker its direction. Off: a fixed plan made without a model |
| `auditor` | boolean | The supervisor's auditor runs, where configured |
| `teachers` | boolean | The supervisor's teacher pair and combiner run, where configured |
| `review` | boolean | The supervisor's review panel runs, where configured |
| `exports` | boolean | Hourly exports for the supervisor to push |
| `trial_minutes` | 1 to 10080 | A trial's length when its contract sets none |
| `max_turns` | 1 to 100000, or `null` | A limit on each trial's model turns. `null`: no limit |
| `promotion` | `auto` or `owner_approval` | The rig's promotion rule, for runs that set none |
| `judge_gpus` | 1 to 8, or `null` | On a rig given its set of GPUs, how many are the judge's. `null`: the rig's default. A change restarts the harness to regroup the cards |

The harness keeps the settings, applies them at once and reports them. Result: `{"settings": <all the rig's settings>}`.

### `accept_review`

The owner's final word on a goal that the review panel passed.

| Field | Type | Meaning |
| --- | --- | --- |
| `run` | lowercase id | The run |
| `review` | positive whole number | The review |
| `accept` | boolean | `true` accepts, `false` rejects |
| `note` | text up to 2000 characters | Optional |

The judge then checks the champion's goals again. Result: `{"review", "decision": "accepted"}` or `"rejected"`.

### `conclude`

The owner's answer to the harness's proposal that a goal campaign's goals cannot be reached.

| Field | Type | Meaning |
| --- | --- | --- |
| `run` | lowercase id | The run |
| `proposal` | positive whole number | The proposal |
| `accept` | boolean | `true` closes the run as not possible; `false` dismisses the proposal and the agents carry on |
| `note` | text up to 2000 characters | Optional |

## Imports

`assign_campaign` lists its imports in `imports`, and `propagate` carries one in `import`. Every `path` is relative to the rig's inbox and may not contain `..`. The harness copies each file into its own store, hashing it as it copies.

| Kind | Fields | Used in |
| --- | --- | --- |
| `repo_bundle` | `path`; `repo` (lowercase id); `commit`; `sha256` (optional: the bundle file's hash, checked as well as the commit); `source` (optional) | `assign_campaign`: the project |
| `kit_bundle` | The same fields | `assign_campaign`: the kit |
| `model` | `path`; `name`; `sha256` (required); `source` (optional) | `assign_campaign`: a model the contract lists |
| `champion_patch` | `path`; `repo`; `base_commit`; `tree`; `sha256` (all required) | `propagate` only. In `assign_campaign` it is refused: `a champion patch comes only with a propagate command` |

`source` tells the supervisor where to fetch the content before it relays the command:

| Source | For | Meaning |
| --- | --- | --- |
| `{"git": "<URL>"}` | `repo_bundle`, `kit_bundle` | A git repository that has the commit: an `https://`, `ssh://`, `git://` or `file://` address, or `user@host:path`, up to 2000 characters. The supervisor fetches the commit and writes it to `path` as a bundle |
| `{"git": "<URL>", "access": "<name>"}` | `repo_bundle`, `kit_bundle` | The same, with Git access that control keeps for a private repository, by name. See [Use a private repository](../how-to/campaigns/private-repository.md) |
| `{"control": "kits/<name>"}` | `kit_bundle` | A kit that control wrote and keeps itself |
| `{"url": "<URL>"}` | `model` | An `http://` or `https://` address, up to 4000 characters |

A source that cannot be fetched makes the command `failed` with `{"error": "staging: <reason>"}`. Without a source, the file must already be in the inbox.

The harness refuses an import with: `path escapes inbox: <path>`, `not found in inbox: <path>`, `symlink escapes inbox: <path>`, `sha256 mismatch for <path>: expected <hash>, got <hash>`, or `bundle does not contain commit <commit>`.

## Older names

Commands signed before runs and rigs were renamed still verify. Their envelope names `unit` instead of `rig`; their payloads may name `instance`, `source_instance` and `source_unit`, read as `run`, `source_run` and `source_rig`; and the kinds `pause_instance` and `resume_instance` are read as `pause_run` and `resume_run`.
