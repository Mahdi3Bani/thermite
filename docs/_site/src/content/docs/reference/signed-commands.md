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
| 1. Issue | Control | Control checks that it knows the rig (it has reported and is not retired, is enrolled, or is in the rig tokens file), checks the payload against the kind's schema, signs the envelope and stores the command as `pending`. For a `message_agent`, it first trims the text and refuses a message that nothing on the rig would read (see [`message_agent`](#message_agent)). A signed command larger than 3.5 MiB is refused: `the <kind> command is too large to deliver` |
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

The owner-only kinds are `approve_promotion`, `decline_promotion`, `accept_review`, `conclude`, `wipe_state`, `message_agent`, `unkeep_message`, `rig_settings`, and the six kinds that change a run's experiment queue and its rules: `queue_add`, `queue_move`, `queue_edit`, `queue_drop`, `queue_accept` and `drop_directive`. The owner-only check is the first step of applying a command, so a command it refuses is recorded like any applied command, as not accepted. Every applied command is recorded in the ledger with the actor `control:<issued_by>`.

## Who may issue each kind

| Kind | Dashboard (`owner:ui`) | REST and `thermite` (`owner:api`) | MCP owner (`owner:mcp`) | MCP operator (`owner:operator`) | MCP agent (`agent:mcp`) | Owner only |
| --- | --- | --- | --- | --- | --- | --- |
| `assign_campaign` | **New campaign**; **Start the run** in the **Start a run** panel of a campaign's page | Yes; `thermite assign` | Yes | Yes | Yes | |
| `rig_check` | **Run it** in a rig's **Checks**; **Check** on **Settings** | Yes | Yes | Yes | Yes | |
| `pause_run` | **Pause**, then **Pause the run** in its menu, in a run's header, in the header of the run's **Live**, and on the run's card under **At work now** | Yes | Yes | Yes | Yes | |
| `resume_run` | **Resume** in a run's header, in the header of the run's **Live**, and on a paused run's row under **Earlier runs** | Yes | Yes | Yes | Yes | |
| `redirect` | None: on the dashboard, rules come from **Tell the planner**, a `message_agent` to the planner, which makes them | Yes | Yes | Yes | Yes | |
| `reset_workers` | **Restart the lanes**, under **⋯** in the header of a running run with agents, on its page and in Live | Yes | Yes | Yes | Yes | |
| `export_now` | **Export now** on a rig's page | Yes | Yes | Yes | Yes | |
| `drain_rig` | **Update to these images** on the page of a rig at work set up on a cluster, and **Call the update off**; control issues it as the caller | No | `update_rig_images` | `update_rig_images` | No | |
| `message_agent` | **Send** in the message box of a run's **Live**; **Send to the planner** on a run's **Planner** tab, while the planner is on | Yes | Yes | Yes | No | Yes |
| `unkeep_message` | **Remove** in the **📌 &lt;n&gt; kept** list of a run's **Live** | Yes | Yes | Yes | No | Yes |
| `queue_add` | **Add** under **Up next** on a run's **Experiments** tab | Yes | Yes | Yes | No | Yes |
| `queue_move` | **↑ Top**, or dragging an experiment, under **Up next** on a run's **Experiments** tab | Yes | Yes | Yes | No | Yes |
| `queue_edit` | **Edit**, then **Save**, on an experiment under **Up next** on a run's **Experiments** tab | Yes | Yes | Yes | No | Yes |
| `queue_drop` | **Drop**, then **Drop it**, on an experiment under **Up next**; **Drop** on a lane's idea under **Ideas from the lanes** | Yes | Yes | Yes | No | Yes |
| `queue_accept` | **Queue it** on a lane's idea under **Ideas from the lanes** | Yes | Yes | Yes | No | Yes |
| `drop_directive` | **Remove** on a rule on a run's **Planner** tab | Yes | Yes | Yes | No | Yes |
| `propagate` | **Send champion #&lt;n&gt;** on a run's **Planner** tab, under **Other rigs** | `POST /v1/propagate`, or `POST /v1/commands` | `propagate_champion` | `propagate_champion` | `propagate_champion` | |
| `approve_promotion` | **Needs you**: **Make it the champion**, **Overrule the auditor** | Yes | Yes | No | No | Yes |
| `decline_promotion` | **Needs you**: **Reject it** | Yes | Yes | No | No | Yes |
| `accept_review` | **Needs you**: **Accept**, **Reject** | Yes | No | No | No | Yes |
| `conclude` | **Needs you**: **End it: not possible**, **Keep going** | Yes | No | No | No | Yes |
| `rig_settings` | **Save changes** on **Edit rig**; **GPUs for the judge** on **New campaign** and in the **Start a run** panel | Yes | No | No | No | Yes |
| `wipe_state` | Only as a step of a full reset | No: `wipe_state is issued only by a full reset` | No | No | No | Yes |

Control's own lists decide what each MCP role may issue; the harness's owner-only check is a second gate behind them. The operator acts for the owner, so its `owner:operator` passes that gate for `message_agent`, `unkeep_message` and the six queue kinds. During the owner's full reset of a rig, MCP's `issue_command` refuses an agent's token for that rig: `<rig> is being reset by the owner`. [Tokens and roles](tokens.md) describes each token.

On the dashboard, only an experiment up next has **Edit**: a lane's idea's words change only over the REST API, the command line or MCP. [Choose what runs next](../how-to/campaigns/choose-what-runs-next.md) walks through the **Experiments** and **Planner** tabs.

## Every kind

Ids such as `run` are lowercase ids: letters `a`–`z`, digits, `.`, `_` and `-`, starting with a letter or digit, at most 64 characters. Commits are full commit ids, 40 or 64 hexadecimal characters. A run that does not exist gives `no run <run>`.

Except where a section says control refuses, the refusals listed under each kind come while the harness applies the command. Such a command is `failed`, and its outcome's `result` is `{"error": "<the refusal>"}`.

### `assign_campaign`

Starts a run of a campaign on the rig. On a [rig launched on RunPod](rest-api.md#rigs-on-a-gpu-cloud) whose pod is stopped, control starts the pod first, then queues the command, which waits until the pod runs ([A run on a stopped RunPod pod](rest-api.md#signed-commands)). Only the owner's token starts a pod.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `run` | lowercase id | required | The new run's id |
| `contract` | object | required | The whole [contract](contract.md) |
| `contract_sha` | 64 hexadecimal characters | required | The contract's SHA-256, as `thermite contract validate` prints it |
| `seed` | `{repo, commit}` | none | The repository (a lowercase id) and the commit the run starts from. Required for hill climb and goal campaigns; research campaigns have none. When the contract names a `project.folder`, `commit` is the whole repository's commit, and the run starts from that folder of it |
| `direction` | text | none | The run's note, recorded with the run (`thermite assign --note`). The field keeps its old name; it is not one of the run's directions |
| `imports` | list of [imports](#imports) | `[]` | What the rig must take in first: the project, the kit, models |
| `agents` | boolean | worker agents run | `false`: a judge-only run |
| `promotion` | `auto` or `owner_approval` | the rig's own setting | The run's promotion rule |
| `ask_owner` | `{above_gain?, declared_flaws?, reviews?, not_possible?}` | nothing: hands-off | What else the run asks the owner about. `above_gain`, a fraction above 0, at most 100: a confirmed gain above it waits for the owner (0.15 is 15%); `declared_flaws`, `true`: a win whose worker declared flaws waits; `reviews`, `true`: a review panel's pass waits for the owner's acceptance; `not_possible`, `true`: a "not possible" proposal waits. See [Decide what waits for you](../how-to/campaigns/decide-what-waits.md#choose-what-waits) |
| `queue` | up to 500 experiments, each as below | none | Experiments to start the new run's [experiment queue](#queue_add) with, in order: usually another run's untried ones |
| `briefing` | up to 200 items, each as below | none | Background from past research for every agent's brief, in order: findings, claims, notes and reports from [the knowledge base](knowledge-base.md#briefings) |
| `mcp_servers` | the kit's [`mcp_servers`](kit-manifest.md#mcp-servers) list | none | The MCP servers the run's kit names (a research contract's, for a research run), with the agents that get each. Control fills it in from a kit it keeps, from the page's reading of a kit in a repository, or from a research contract, and refuses a server **Settings** lacks. The harness refuses the run when it differs from what the kit names. Control gives the rig only the servers its runs name. For a research run, leave it out: control takes the contract's list, and refuses another with `The assignment names the MCP servers <list>, and the contract names <list>. Leave mcp_servers out: control takes the contract's.` |

Each experiment in `queue` has these fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `title` | text, 1 to 200 characters | What to try |
| `details` | text up to 4000 characters | Optional. More about it |
| `family` | text, 1 to 80 characters | Optional. Its direction, in words or as a direction family's name |
| `why` | text up to 2000 characters | Optional. Why it is worth trying |
| `by` | text, 1 to 80 characters | Who added it in the first place, such as `owner`, `planner`, `teacher` or `lane-2`. The new run keeps it as the experiment's author. Over MCP, control replaces it, as below |
| `state` | `queued` or `proposed` | `queued`: up next. `proposed`: a lane's idea, which stays an idea in the new run |
| `from` | `{run, id}` | The run and the experiment it was copied from |

Over MCP, control does not keep the caller's words for a copied experiment that it can take from its own record. It takes `title`, `details`, `family`, `why` and `by` from its record of the experiment that `from` names: the rigs' signed events, with every edit applied. A field that the record does not have is left out. It does this only when the run that `from` names is [filed](knowledge-base.md#campaign-folders) in the folder of the new run's campaign (`contract.campaign`), or of a campaign whose folder that campaign may read ([Grants](knowledge-base.md#grants)). Any other experiment keeps the caller's words, and its `by` is `copied`: one that control has no record of (no rig reported it, or more than one did), and one from a run in any other folder, or in none. To an experiment taken from its record, control adds the line `In <run> (<campaign>) it was <result>.` after the details when the experiment's item in the [knowledge base](knowledge-base.md#items) has a result, as **Start a run** does, and cuts `details` to 4,000 characters.

Each item in `briefing` has these fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `text` | text, 1 to 4000 characters, trimmed | The item's words |
| `from` | `{campaign, run, kind, ref}` | Where it came from: the campaign's folder (1 to 200 characters), the run (a lowercase id), the item's kind (1 to 40 characters, such as `finding`) and its `ref` in that run (1 to 200 characters) |

Over MCP, control does not keep the caller's words for a briefing either. It looks up the knowledge base's item that `from` names and puts that item's words in `text`. It leaves out an item it cannot find, one it finds more than once (run names are unique on one rig only), and one from a folder the new run's campaign may not read. With none left, it sends no `briefing`. It does this before it looks up the copied experiments. The REST API (`POST /v1/commands`) and `thermite command` send `briefing` and `queue` as given: control looks nothing up. `thermite assign` has no option for a briefing. Its `--queue-from` fills `queue` with a past run's untried experiments, as **Start a run** does below, and takes them from control first (`GET /v1/rigs/<rig>/runs/<run>/untried`), with the words and authors control's records hold, as over MCP. See [the command line](command-line.md#copy-a-past-runs-untried-experiments).

**Start a run** on a campaign's page also works for a campaign that was assigned over the REST API, MCP or the command line, with no version saved on control. Control then signs again the campaign's newest `assign_campaign` whose status is `pending` or `delivered`, as a new run: the same `contract`, `seed`, `imports` and `direction` (the run's note), with a new `run`, and `agents` and `promotion` from the panel. With **Agents** on and **Copy the untried experiments of** ticked, the panel also sends `queue`: the chosen run's experiments still up next, in their order, then its lanes' ideas, at most 500 of them. Its help says "They join the new run's queue in the same order, up to 500." With **Agents** off, the panel hides that field, and control sends no `queue` even when the form has it: a run without agents has no queue. Its **From past research** sends the ticked past experiments in `queue`, after the copied ones (at most 500 in all), and the ticked findings, claims, notes and reports in `briefing`, each looked up again in control's knowledge base. With **Agents** off, the panel hides **From past research** too and sends none of it. If ticked items reach control all the same (the page shown without its script), control leaves them out, starts the try, and says "A try (agents off) takes no experiments and no background: what you ticked was left out." [Use past research in a new run](../how-to/campaigns/use-past-research.md) gives the steps. Start a run's twins, `POST /v1/campaigns/<campaign>/runs`, MCP's `start_run` and `thermite run start`, run the panel's code and send the same `assign_campaign`; they refuse a run to copy from, a model or past research for a try instead of leaving them out.

The harness creates the run only after every check passes. In order, it refuses:

| Message | When |
| --- | --- |
| `invalid contract: …` | The contract does not pass its schema |
| `contract hash does not match contract_sha` | The hash differs |
| `run <run> already exists` | The run id is taken on this rig |
| `a run without agents has no queue: leave out the experiments to copy` | `"agents": false` with experiments in `queue` |
| `queue experiment <n>: <the first problem>` | An experiment in `queue` whose `title` or `family` is only spaces. `<n>` counts from 1 |
| `a run without agents has no briefs: leave out the background from past research` | `"agents": false` with items in `briefing` |
| `contract <campaign> v<version> exists with other content` | The rig has this contract version with different content |
| `model <name> is not listed in the contract` | A `model` import the contract does not list |
| `a <mode> campaign needs a seed commit` | No `seed` for a hill climb or goal campaign |
| An import's message (see [Imports](#imports)) | An import fails |
| `model <name> (<sha256>) has not been imported` | A model the contract lists is not on the rig |
| `kit commit <commit> is not in kit <repo>; import its bundle first` | The contract's kit commit is not on the rig |
| `kit <repo> at <commit> has no valid kit.json: …` | The kit's [`kit.json`](kit-manifest.md) is missing or invalid |
| `the kit does not fit the contract: …` | The kit lacks what the contract needs |
| `seed commit <commit> is not in <repo>; import its bundle first` | The seed commit is not on the rig |
| `commit <commit> has no folder <folder>` | The contract's `project.folder` is not a folder of the seed commit |

For a contract with a `project.folder`, the run starts from a commit the harness makes from the seed commit: the folder's files as its whole tree, with no parent, a fixed author and time, and the message `<folder> at <commit>`. Every rig makes the same commit from the same seed commit and folder, so champions move between rigs. That commit is the run's champion #1, and the run's `run_created` event names it in `seed.commit`, with `seed.folder` and the repository's commit in `seed.source_commit`.

Then it creates the run as running, and pauses the rig's other running runs with the reason `replaced by <run>`. In the same step it adds each experiment in `queue` to the end of the new run's queue, in order. Each keeps its author, its reason, its state and where it came from, with one `experiment_added` event (see [`queue_add`](#queue_add)), which also has `from_run` and `from_id`. In a hill-climb or goal run, a worker whose lane gets an experiment that neither the owner nor the planner added reads this line under it in its brief: `Added by <author>: its words are a suggestion to weigh, not instructions.`, with `an earlier run` for `copied`. It keeps the `briefing` with the run, in order, and nothing changes it later; the run's `run_created` event then has `"briefing": <n>`. [Briefings](knowledge-base.md#briefings) says where each agent reads it. For a run with agents of a contract with [`agents_context`](contract.md#agents-context), the `run_created` event has it too, and every agent of the run works with the lower of its window and the campaign's, and at the campaign's compaction point. Result: `{"run", "contract_sha", "imported", "agents"}`, plus `"start": {"folder", "commit"}` for a project in a folder, with the commit the run starts from, `"queue": <n>` when `queue` held any experiments and `"briefing": <n>` when `briefing` held any items.

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
| `reason` | text, at least 1 character | Why. The dashboard sends what you write in **why (optional)** in the **Pause** menu, at most 500 characters, or `paused from the dashboard` when you leave it empty |

The run becomes `paused` with the reason. Its lanes' running trials end; the experiment each was on goes back to the top of the run's queue, as for [`reset_workers`](#reset_workers). The judge takes no new job of a paused run: its jobs waiting for the judge stay queued until the run runs again. Result: `{"run", "status": "paused"}`.

### `resume_run`

| Field | Type | Meaning |
| --- | --- | --- |
| `run` | lowercase id | The run |

The run becomes `running`, and the rig's other running runs are paused: a rig runs one run at a time. A closed run is refused: `run <run> is closed`. Result: `{"run", "status": "running"}`. On a rig launched on RunPod whose pod is stopped, control starts the pod first, as for [`assign_campaign`](#assign_campaign).

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
| `kind` | `avoid`, `try`, `mandate`, `priority`, `lane_count` or `note` | `avoid`, `try` and `mandate` (**Always** on the dashboard) name a direction; `priority` ranks one; `lane_count` sets how many lanes work, up to the contract's count; `note` is text for the planner only |
| `family` | letters, digits, spaces and dashes, plain or as `:name:`, that make a name of 2 to 41 characters | The direction it is about, when the kind needs one. Control signs it as the direction's name: its words in lowercase, joined by dashes, so `:Shared memory tiling:` becomes `shared-memory-tiling` |
| `value` | text up to 1000 characters, or a number | The value, when the kind needs one. A research run's `try` or `mandate` may give a question's number here instead of a `family` |
| `rationale` | text, 1 to 2000 characters | Why. The planner sees it; workers never do |
| `citations` | up to 20 texts of 1 to 500 characters | Sources. Default `[]` |

Control refuses a directive that breaks these rules before signing, with `bad redirect payload: directives.<i>[.<field>]: <message>`, `<i>` counting from 0:

| Field and message | When |
| --- | --- |
| `a rule no longer takes match: name its direction in family, in plain words or as :name:` | The directive has `match`, a rule in words |
| `family: "<text>" is not a direction's name: write it in letters, digits, spaces and dashes, such as shared memory tiling or :shared memory tiling:` | Other characters in `family` |
| `family: "<text>" is too long for a direction's name: use at most 41 letters, digits, spaces and dashes` | A name over 41 characters |
| `family: an avoid, try or mandate rule names a direction (family)` | An `avoid`, `try` or `mandate` with no `family` (and, for `try` and `mandate`, no `value`) |

A `family` may name a direction the run doesn't have yet. The rig takes it, and the planner's model designs the direction at its next round: it says what the direction means, in its own words, and the run then has it ([Directions](../how-to/campaigns/choose-what-runs-next.md#directions)). A research run has no planner to design one: control and the rig refuse there any direction but a task kind, `A research run's directions are its task kinds: :explore:, :primary:, :contradict:, :consolidate:. It has no planner to design a new direction, so a rule for :<name>: would do nothing. Name a task kind.`

A set that both avoids a direction and tries or mandates it is refused: `the set both avoids and asks for <directions>`. A closed run is refused: `run <run> is closed: its queue and rules no longer change`. Result: `{"run", "directives": [<ids>]}`, with `"new_directions": [<names>]` when the set names directions the run doesn't have yet.

A rule in words (`match`) set before rules named directions stays in force, marked legacy, until the planner's next round with its model converts it. No command converts it: the rig does, at the planner's round, with new records, and no signed command or earlier record changes. The new directive has the old one's author, `kind`, `rationale`, `citations` and `from_message`, the `family` the planner named, and `"converted_from": {"rule": <id>, "words": "<the old words>"}`; its `directive` event is its author's. The old directive leaves force as converted, with the event `directive_converted` by the planner: `{"id": <old id>, "to": <new id>, "kind", "family", "words"}`. Until then, only the planner's model reads it. The fixed rules that give out work without the model (no model, a model answer that code refused, the planner switched off, and every research run) keep only the directives that name a `family`; a research run has no planner, so a rule in words there is never converted ([Old rules in words](../how-to/campaigns/choose-what-runs-next.md#old-rules-in-words)).

`redirect` is not the only source of rules. The teachers' set (a teacher's recommendations, or the merged by model's directives: see [What each role must answer](advisors-file.md#what-each-role-must-answer)) and a rule that the planner adds because an owner's message asked for it name a direction the same way.

The owner's `redirect`, or an operator's for the owner, can set again a rule that was removed with [`drop_directive`](#drop_directive). An agent token's `redirect`, the teachers' set and the planner's cannot.

The dashboard calls directives **rules**. It sends no `redirect`: on a run's **Planner** tab, **Tell the planner** sends a [`message_agent`](#message_agent) to the planner, and the planner adds the rules the message asks for at its next round, each with `from_message` set to the message. **Remove** sends [`drop_directive`](#drop_directive), which removes one rule. Control's own command form refuses a `redirect`: `this command is not available from the dashboard`.

### `reset_workers`

| Field | Type | Meaning |
| --- | --- | --- |
| `run` | lowercase id | The run |
| `reseed_commit` | commit | Accepted by the schema, but the harness refuses it: `re-seeding lanes is not available in this version; reset without it` |

The run's running trials end, along with the current [epoch](glossary.md) (a round, on the dashboard), and every lane starts again from the champion. The experiment each ended trial was on goes back to the top of the run's queue, the same experiment with its author and its why, and counts the return (`returns`) with its cause; its `experiment_returned` event has `{id, lane, trial, result: "interrupted", cause, returns, position: "top"}`. Result: `{"run", "reset": true}`.

The run page's **History** says "You restarted the lanes: their trials ended, and every lane starts again from the champion." (with the issuer's name in place of "You" for the agent's token), and, for each experiment, `"<title>" went back to the top of the queue: its trial on <lane> was interrupted (<cause>).` The dashboard offers **Restart the lanes** only on a running run with agents: a run without agents (a try, a rig check) has no lanes.

### `message_agent`

The owner's message to the run's agents. The judge is code and takes no messages.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `run` | lowercase id | required | The run |
| `to` | one of the recipients below | required | Who gets it |
| `text` | text, 1 to 4000 characters | required | The message. Control trims it before it signs it |
| `keep` | boolean | `false` | `true` keeps the message in force: it goes into the brief of every new trial it is for, until an [`unkeep_message`](#unkeep_message) removes it. Only for `all` or a lane |

| `to` | Who reads it |
| --- | --- |
| `all` | Everyone working: each lane at work, and the planner of a hill-climb or goal run whose planner is on. The lanes at work are the contract's `lanes.count`, or fewer when the newest `lane_count` rule in force says so |
| `lane-1` to `lane-16` | That [lane](glossary.md) |
| `trial:t-` and 8 to 32 hexadecimal characters | That trial. If it ends before it reads the message, its lane's next trial reads it, with a note that it was sent to an earlier trial |
| `planner` | The planner. A research run has none |
| `advisors` | The teachers, the auditor and the review panel, each once, except those that a refusal below names |
| `teachers` | The teachers |
| `auditor` | The auditor |
| `review_panel` | The review panel. Its old name, `panel`, is still taken in v0.1.0: control signs the command with `panel`, the name every rig takes |

Each reader reads a message once: each lane, the planner and each advisor role. Only a message kept in force is given again, to each new trial. A read is recorded when the reader works with the message, not when the text is only fetched or put in a brief. When each one reads it:

| Reader | When |
| --- | --- |
| A lane with no trial at work | In the brief of its next trial, once that trial's agent is at work: its first session line, or a model turn or tokens counted. If the trial fails before that, the lane's next trial gets the message. A message in a trial's brief is not given to it again during the trial |
| A worker in Pi | At its next step: after its model's current turn |
| A worker in OpenCode, Claude Code or Codex | When its current run ends without a submission. The harness then continues the session with the message |
| A worker that has submitted | It does not read it: a submission ends the trial, and the lane's next trial reads the message in its brief |
| The planner | At its next plan whose model's plan is used. While the planner is off, its model can't be reached, or code refuses its plan on both tries (the fixed rules give out the round's work), the message waits for the next plan |
| The teachers | In their next round, once at least one teacher has given its review. For a running run, a message starts that round: between rounds the supervisor looks for one every 5 seconds, and a round under way finishes first. When the advisors have reached the day's [spending limit](advisors-file.md#spending), a message starts no round; the run's live view says once `the advisors reached the day's spending limit (<limit> USD): the teachers read your message after midnight UTC` |
| The auditor | With its next audit, once the audit is posted to the harness |
| The review panel | With its next review, once the review is posted. If a reviewer gives no answer, the review is not posted, and its next try gives every reviewer the message again |

An advisor's brief or package puts the owner's messages first, and they are never cut when it is shortened. The teachers, the auditor and the review panel are asked to answer each message they are given, in one or two sentences, and the harness records each answer. An answer with no text is left out, and one malformed answer does not lose the advisor's others. A message kept in force goes into every new trial's brief under `# Messages from the campaign's owner, in force`; the others go under `# Messages from the campaign's owner`.

Control checks every message before it signs it, wherever it comes from: a run's **Live** or **Planner** tab, the REST API, `thermite command` or MCP. It trims the text, and refuses a message with no words in it, or one that nothing on the rig would read. It judges that from what the rig last reported: the run, the rig's settings (**Edit rig**) and the advisor roles its supervisor has set up. While the rig has not reported the run, or its supervisor has not reported its roles, control does not refuse for that reason, and the harness decides, as below. Control refuses with these messages:

| Message | When |
| --- | --- |
| `Write a message first.` | `text` is empty, or only spaces |
| `This run has no agents (the judge alone tries the kit), so nothing would read it.` | `all`, `planner`, a lane or a trial, in a run started without agents |
| `A research run plans its rounds with a fixed method: it has no planner to message.` | `planner`, in a research run |
| `The planner is off on this rig (Edit rig), so nothing would read it.` | `planner`, with the planner switched off on **Edit rig** |
| `A research run has no attempts to audit.` | `auditor`, in a research run |
| `A research run has no conclusions to review.` | `review_panel`, in a research run |
| `The teachers are off on this rig (Edit rig), so nothing would read it.`, and `The auditor is off …` or `The review panel is off …` | `teachers`, `auditor` or `review_panel`, with that role switched off on **Edit rig** |
| `This rig's supervisor has no teachers set up, so nothing would read it.`, and the same with `auditor` or `review panel` | `teachers`, `auditor` or `review_panel`, when the rig's supervisor reports that it has no such role |
| `This run has no goal the review panel reviews, so nothing would read it.` | `review_panel`, when the run's contract has no goal checked by review |
| `This rig's supervisor has no advisors set up, so nothing would read it.` | `advisors`, when the supervisor reports none of the three roles |
| `No advisor would read it.`, followed by the reason for each role, in the order teachers, auditor, review panel | `advisors`, when each of the three roles has one of the reasons above |

`panel`, the review panel's old name, is refused for the same reasons.

Over the REST API and `thermite command`, a refusal is `400 {"error":"<message>"}`, written as `refused`. Over MCP, `issue_command` answers `{"error":"<message>"}` with `isError: true`, written as `refused`. On the dashboard it shows as **Not sent.** and the message (below), written as `refused`. A run's **Live** also greys out each recipient that control would refuse, with the same words when you point at it (on a run without agents that includes everyone working and the lanes, and the box starts on the advisors), and its message box asks for words before it sends: "Write a message first."

Control refuses `keep` with any other `to` before signing: `bad message_agent payload: keep: only a message to everyone working (all) or to a lane can be kept in force`. The harness checks again when it applies the command. It refuses a message in these cases, and records no message:

| Message | When |
| --- | --- |
| `run <run> is closed: nothing will read this message` | The run is closed |
| `run <run> has no agents (the judge alone tries the kit): nothing would read this message` | `all`, `planner`, a lane or a trial, in a run started without agents |
| `a research run plans its rounds with a fixed method; it has no planner to message` | `planner`, in a research run |
| `the planner is off on this rig (Edit rig), so nothing would read this message` | `planner`, with the planner switched off on **Edit rig** |
| `the teachers are off on this rig (Edit rig), so nothing would read this message` | `teachers`, with the teachers switched off |
| `the auditor is off on this rig (Edit rig), so nothing would read this message` | `auditor`, with the auditor switched off |
| `a research run has no audits, so the auditor would never read this message` | `auditor`, in a research run |
| `the review panel is off on this rig (Edit rig), so nothing would read this message` | `panel`, with the review panel switched off |
| `this run has no goal the review panel reviews, so the review panel would never read this message` | `panel`, in a run with no goal checked by review |
| `none of the advisors would read this message: <each reason, joined by "; ">` | `advisors`, when no role would read it |
| `run <run> has <n> lanes`, or `… has 1 lane` | A lane beyond the contract's number of lanes. A lane within it, but above the number a `lane_count` rule leaves at work, is accepted |
| `no trial t-… in run <run>` | A trial the run does not have |

The run's **Live** shows the rig's refusal of the newest message to the run, from wherever it was sent, as **Not sent.** `The rig refused your last message: <reason>` above its message box, the next time the page loads. The run's **Planner** tab does the same for the newest message to the planner, above **Tell the planner**: **Not sent.** `The rig refused your last message to the planner: <reason>`. A message from the dashboard that control refuses before it signs it shows in the same place at once, as **Not sent.** and control's reason. Control's audit log records that refusal as `refused`, with the page's path and the reason ([Audit log actions](rest-api.md#audit-log-actions)). While the planner is off on **Edit rig**, the **Planner** tab has no form under **Tell the planner**, only "The planner is off on this rig, so it reads no messages. The lanes take the queue in order and keep to the rules. Switch it on in Edit rig to tell it something.", with **Switch it on in Edit rig** as a link to the rig's **Edit rig** page.

The harness writes the live line `Owner to <to> (#<id>): <text>`, with `, kept in force` after the id for a kept message. A run's **Live** shows a signed line as **To** the recipient and the text. A line for everyone working, a lane, the planner or the advisors shows so at once, in its own words. A line for a trial shows as a plain line until the run's `agent_message` event, below, reaches control with the rig's report; **Live** then draws it again in place, with the event's words. Result: `{"message": <id>, "to", "keep", "readers", "note"}`. `readers` lists who will read it: lanes, `planner`, `teachers`, `auditor` or `panel` (the review panel, by the name the rig takes). `note` is there only for a trial that has ended: `trial t-… has ended; lane-<n>'s next trial reads this`.

The run's ledger records the message with its text (`agent_message`), each reader's first read (`agent_message_read`, `{message, by}`, with `trial` for a lane's read and `round` for the planner's: the round whose plan read it) and each advisor's answer (`advisor_answer`). A rule the planner makes from the message is a `directive` whose body has `from_message`. The run's **Planner** tab shows a message to the planner, or to everyone working, under **Tell the planner**: waiting until the planner's round reads it, then with the planner's answer, made from these records: the rules it made from the message, the directions it designed for them, any rules it left out because the owner had removed them, and the round's notes. The run's **Live** shows the message, each read and each answer only from the harness's signed live lines; an unsigned line that looks like one shows as a plain line. A lane's read, like a message to a trial, shows plainly until the run's `agent_message` event reaches control.

### `unkeep_message`

Removes a message from force: new trials' briefs no longer carry it, and no reader that has not read it yet is given it.

| Field | Type | Meaning |
| --- | --- | --- |
| `run` | lowercase id | The run |
| `message` | positive whole number | The message's id: `message` in the result of its `message_agent` |

The harness refuses: `no message <id> in run <run>`, `message <id> is not kept in force`, and `message <id> was already removed from force at <time>`. The harness writes the live line `the owner's message #<id> is no longer in force`, and the ledger records `agent_message_unkept`. A run's **Live** shows that line, when the harness signed it, under **You** (and the message's lane, for a message to a lane) as `📌 You removed your kept message: “<text>”. New trials no longer get it.`, the text cut to 120 characters, or with `(#<id>)` in place of the text when control does not have the message. Result: `{"message": <id>, "unkept": true}`.

### `queue_add`

Adds an experiment to the run's **experiment queue**. Each run has its own queue: the [experiments](glossary.md) still to try, in order (**Up next**), the lanes' ideas that wait for a decision, and every experiment tried, with what became of it. At the start of each round the planner gives the experiments at the top to free lanes, never the same one to two lanes. [Choose what runs next](../how-to/campaigns/choose-what-runs-next.md) shows the queue on the dashboard.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `run` | lowercase id | required | The run |
| `title` | text, 1 to 200 characters, trimmed | required | What to try |
| `details` | text up to 4000 characters | none | More about it |
| `family` | text, 1 to 80 characters, trimmed | none | Its direction: in your own words, or a direction's name. Written as `:name:`, it is kept without the colons |
| `why` | text up to 2000 characters | none | Why it is worth trying. The planner reads it, and so does the worker whose lane gets the experiment |
| `position` | `"top"`, `"end"`, or a whole number from 0 to 100000 | `"end"` | Where it goes among the queued experiments |

The dashboard's **Add** sends **Add an experiment** as `title`, and **Direction**, **Why** and **Details** as `family`, `why` and `details` when they are not empty. It puts the experiment at the top, unless **Where** says **at the end**. Over the REST API, the command line and MCP it goes to the end unless `position` says otherwise.

These rules hold for the five queue kinds:

- An experiment's id is `x-` and 12 hexadecimal characters, such as `x-3f6c2a8e5b1d`. Control refuses another before signing: `bad <kind> payload: id: an experiment id (x-...)`.
- An experiment's place is its index among the queued experiments, 0 first. A number puts it at that index among the others; a number past the last puts it at the end.
- The harness refuses a run it doesn't have (`no run <run>`), a closed run (`run <run> is closed: its queue and rules no longer change`), and an experiment the run doesn't have (`no experiment <id> in run <run>`).
- The harness writes the experiment and one event in one step. The event's actor is `control:<issued_by>`, such as `control:owner:ui`, and its `by` is `owner`, whoever issued the command.

The new experiment is up next, with `owner` as its author. Result: `{"experiment": "x-…", "state": "queued", "position": <n>}`, `position` being its place now. Event: `experiment_added`, `{id, title, details?, family?, why?, by, state, position}`.

### `queue_move`

Moves an experiment that is up next to another place.

| Field | Type | Meaning |
| --- | --- | --- |
| `run` | lowercase id | The run |
| `id` | experiment id | The experiment |
| `position` | `"top"`, `"end"`, or a whole number from 0 to 100000 | Its new place |

**↑ Top** on the dashboard sends `"top"`; dragging an experiment sends its new index. The harness refuses an experiment that is not up next: `experiment <id> is <state>: only queued experiments move`. Result as for `queue_add`. Event: `experiment_moved`, `{id, by, position}`.

### `queue_edit`

Changes the words of an experiment that still waits: one up next, or a lane's idea.

| Field | Type | Meaning |
| --- | --- | --- |
| `run` | lowercase id | The run |
| `id` | experiment id | The experiment |
| `title`, `details`, `family`, `why` | as for `queue_add` | The new words. Give at least one; the others stay as they are |

An empty `details` or `why` clears it; `title` and `family` cannot be empty.

**Edit** on an experiment under **Up next** opens a form with its words: **What to try** (`title`), **Details**, **Direction** (`family`) and **Why**. **Save** always sends `details` and `why`, so a field you empty is cleared. It sends `title` and `family` only when they are not empty, so an emptied one keeps its old words. A lane's idea has no **Edit** on the dashboard.

Control refuses an edit with none before signing: `bad queue_edit payload: payload: change at least one of title, details, family and why`. The harness refuses an experiment that no longer waits: `experiment <id> is <state>: only proposed or queued experiments can be edited`. Result as for `queue_add`; `position` is `null` for a lane's idea. Event: `experiment_edited`, `{id, by}` and the fields that changed.

### `queue_drop`

Drops an experiment that still waits, so no lane tries it. It stays in the run's record as dropped, with who dropped it and why.

| Field | Type | Meaning |
| --- | --- | --- |
| `run` | lowercase id | The run |
| `id` | experiment id | The experiment |
| `why` | text, 1 to 2000 characters, trimmed | Why. Required |

**Drop it** on the dashboard sends what you write in its **why** field. **Drop** on a lane's idea sends `the owner dropped this idea`. The harness refuses an experiment that no longer waits: `experiment <id> is <state>: only proposed or queued experiments can be dropped`. Result: `{"experiment": "x-…", "state": "dropped", "position": null}`. Event: `experiment_dropped`, `{id, by, why}`.

### `queue_accept`

Queues a lane's idea: an experiment a worker proposed (with `thermite-trial idea` or Pi's `idea` tool) goes up next. The planner's model also queues or drops ideas as it plans. Under **Ideas from the lanes**, the **Experiments** tab says: "The planner's model queues or drops these at its next hand-out, and you can decide first. Without its model (none set, its answer refused, the planner off, or a research run) they wait for you."

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `run` | lowercase id | required | The run |
| `id` | experiment id | required | The idea |
| `position` | `"top"`, `"end"`, or a whole number from 0 to 100000 | the end | Where it goes |

**Queue it** on the dashboard sends no position, so the idea goes to the end. The harness refuses anything but an idea: `experiment <id> is <state>, not a proposed idea`. Result as for `queue_add`. Event: `experiment_accepted`, `{id, by, position?}`.

### `drop_directive`

Removes one [directive](#redirect), a rule for the plan, whoever set it: the owner, the teachers or the planner.

| Field | Type | Meaning |
| --- | --- | --- |
| `run` | lowercase id | The run |
| `id` | positive whole number | The directive's id: one of `directives` in its `redirect`'s result, or `id` in the run's `rules` ([`run_queue`](mcp-tools.md#run_queue)) |

The harness refuses: `no run <run>`, a closed run (`run <run> is closed: its queue and rules no longer change`), and `no rule <id> in force in run <run>`. The directive stays in the record with the status `dropped`, and the ledger records `directive_dropped`, `{id}`. Result: `{"run", "dropped": <id>}`.

**A removed rule does not come back from the advisors, the planner or an agent's token.** The teachers' next set of directives replaces their earlier set, the planner adds rules when an owner's message asks for one, and an agent token may send a `redirect`. Before the harness records such a set, it leaves out each rule that matches a rule removed from the run with `drop_directive`: the same kind, and the same `family` or `match` words, ignoring case and spaces at the ends. A rule that names neither matches every removed rule of its kind that names neither. The harness records the left-out rules in one event, `directives_left_out`, `{rules, why: "the owner removed these rules"}`, whose actor is `supervisor`, `planner` or `control:agent:mcp`, and records the rest of the set. Only a `redirect` issued by the owner, or by an operator for the owner, sets a removed rule again: its author is `control:owner:…`, such as `control:owner:api` for the owner's REST API or `control:owner:operator`.

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

### `drain_rig`

Only control issues it, before it moves a rig at work onto new images (**Update to these images**, or [`update_rig_images`](mcp-tools.md#update_rig_images)), and to call the update off.

| Field | Type | Meaning |
| --- | --- | --- |
| `drain` | boolean | `true`: the rig drains; `false`: the drain ends |
| `reason` | text, 1 to 500 characters, optional | Why, as the event records it |

While a rig drains, its harness starts no new trial, plan or judge job, and those running end as they would. Its report's `work` says what still runs, `{trials, judge_jobs, draining}`, and control restarts its pods once nothing does. A drain lasts until the harness restarts, which ends it. The event `rig_drain` records each change with the same figures. Result: `{"trials", "judge_jobs", "draining"}`.

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
| `lanes` | 1 to 16 | Trials at the same time. More is refused with `at most 16: a rig has users for lanes 1 to 16 only` |
| `planner` | boolean | The planner's model gives each lane its experiment at the start of each round. Off: lanes take the queued experiments in order, by fixed rules, with no model |
| `auditor` | boolean | The auditor runs in the supervisor, where configured |
| `teachers` | boolean | The teachers, and their merged by model, run in the supervisor, where configured |
| `review` | boolean | The review panel runs in the supervisor, where configured |
| `exports` | boolean | Hourly exports for the supervisor to push |
| `trial_minutes` | 1 to 1440, or `null` | A trial's length when its contract sets none. `null`: none |
| `max_turns` | 1 to 100000, or `null` | A limit on each trial's model turns. `null`: no limit |
| `promotion` | `auto` or `owner_approval` | The rig's promotion rule, for runs that set none |
| `judge_gpus` | 1 to 8, or `null` | On a rig given its set of GPUs, how many are the judge's. `null`: the rig's default. A change restarts the harness to regroup the cards |

The harness keeps the settings, applies them at once and reports them, with a `rig_settings_changed` event that holds the change and the settings after it. Result: `{"settings": <all the rig's settings>}`.

The **History** of the run at work at the time says what changed, such as "You changed the rig's settings: the planner off, 3 lanes, no turn limit." Each field reads as `the judge`, `the workers`, `the planner`, `the auditor`, `the teachers`, `the review panel` or `exports` with `on` or `off`; `<n> lanes` (`1 lane`); `trials of <n> min`; `at most <n> turns a trial` or `no turn limit`; `confirmed wins kept at once` or `confirmed wins wait for you`; and `<n> GPUs for the judge` (`1 GPU for the judge`) or `the judge's usual share of GPUs`.

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
| `{"url": "<URL>"}` | `model` | An `http://` or `https://` address, up to 4000 characters. The supervisor downloads the file and keeps it only with the import's `sha256`, reporting its progress. See [Model files on a rig](model-files.md) |

A source that cannot be fetched makes the command `failed` with `{"error": "staging: <reason>"}`. Without a source, the file must already be in the inbox.

The harness refuses an import with: `path escapes inbox: <path>`, `not found in inbox: <path>`, `symlink escapes inbox: <path>`, `sha256 mismatch for <path>: expected <hash>, got <hash>`, or `bundle does not contain commit <commit>`.

## Older names

Commands signed before runs and rigs were renamed still verify. Their envelope names `unit` instead of `rig`; their payloads may name `instance`, `source_instance` and `source_unit`, read as `run`, `source_run` and `source_rig`; and the kinds `pause_instance` and `resume_instance` are read as `pause_run` and `resume_run`.
