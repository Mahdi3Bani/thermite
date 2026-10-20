---
title: "Limits and pacing"
description: "Every limit Thermite has, its default, what it bounds and whether it ends anything. Nothing ends research unless you set it."
type: reference
sidebar:
  order: 15
---

**Nothing ends research by default.** A hill climb runs until someone pauses it. A goal campaign runs until its goals are met or the owner accepts that they are not possible. A research campaign runs for the time its contract gives it. Every cap that can stop a campaign is off until you set it.

Thermite's limits are of four kinds. Only a cap can stop a run's work, and only one you set:

| Kind | What it does | What it ends |
| --- | --- | --- |
| [Caps](#caps) | Limits you set: budgets, a research window, turns per trial, spending and size limits | Only what that cap names, such as pausing a run when its budget is spent. None is set by default; a research contract must name its own duration |
| [Pacing](#pacing) | Spaces work out: trial lengths, waits after errors, how often things repeat | Nothing. A trial may end; the lane's next one starts afresh |
| [Back-pressure](#back-pressure) | Holds new work until earlier work settles | Nothing. Work waits, then goes on |
| [Per-process and per-trial limits](#per-process-and-per-trial-limits) | Bound one build, run, command, check or trial | That one process or trial. The lane goes on |

[The owner's messages](#the-owners-messages) lists how many messages and answers an agent gets, [The experiment queue](#the-experiment-queue) the sizes of a run's queue, [Field notes and the knowledge base](#field-notes-and-the-knowledge-base) the sizes of notes, briefings and searches, and [Control's own limits](#controls-own-limits) cover commands, requests and lists. [Why Thermite runs until the job is done](../explanation/runs-until-done.md) explains this design, and [Set a budget or a stop time](../how-to/campaigns/budget-and-stop-time.md) shows how to set a cap. The [glossary](glossary.md) explains the terms.

## Caps

| Cap | Set in | Default | When it is reached |
| --- | --- | --- | --- |
| `budget.wall_hours` | The [contract](contract.md) | None | No new trial starts. Once the running trial ends, the run is paused: `the wall-time budget is spent`. Counted from the run's creation, paused time included |
| `budget.device_hours` | The contract | None | The same, when the judge's time on the run reaches it: `the device-hours budget is spent` |
| `budget.llm_usd` | The contract | None | The same, when the agents' token spending reaches it: `the model budget is spent ($<amount>)`. It counts only when the rig sets both `THERMITE_LLM_USD_PER_MTOK_IN` and `THERMITE_LLM_USD_PER_MTOK_OUT` (prices per million tokens) |
| `min_duration`, `max_duration` | A research contract | `min_duration` is required | The research campaign closes after `max_duration` of running time (paused time does not count), or after `min_duration` when `max_duration` is not set: `the research window is over`. Other modes ignore both |
| `max_usd_per_day` | The [advisors file](advisors-file.md) | None | The advisors skip their work until the next day (UTC), and a message to the teacher pair starts no round until then. Research goes on. It counts only advisors with prices set |
| `THERMITE_RESEARCH_MAX_MB` | The harness's settings | None | A run's fetches are refused, in any mode: `the corpus is full (<n> MiB archived)`. Its other tools go on |
| Turns per trial (`max_turns`) | **Edit rig**, or `THERMITE_MAX_TURNS` | None | One trial ends after that many model replies. The lane's next trial starts afresh |
| A RunPod test's stop time (`stop_after_minutes`) | **End it after (minutes)** on the test pod form, REST or MCP | None | The test pod is removed. At least 5 minutes. A test spends money: see [Test a GPU on RunPod](../how-to/install/runpod-test.md) |

- **A paused run waits.** The judge works only on running runs, so a paused run's queued judge jobs stay queued until it is resumed.
- **Contract budgets apply only to runs with agents and a model.** A judge-only run has no trials to stop.
- **A spent budget stays spent.** A resumed run whose budget is spent is paused again.

## Pacing

None of these ends research. A trial that ends at its time is followed by the lane's next trial, with fresh context.

### Trials and lanes

| What | Default | Set by |
| --- | --- | --- |
| A trial's length | 20 minutes | The contract's `lanes.limits.trial_minutes` (1 to 1,440), else **Edit rig** › **One trial lasts (minutes)** or `THERMITE_TRIAL_MINUTES` |
| Trials at the same time on a rig | 1 | **Edit rig** › **Workers at a time** (1 to 16), or `THERMITE_MAX_TRIALS` |
| Lanes planned per epoch | 2 | The contract's `lanes.count`. A redirect's `lane_count` can lower it |
| Trials per lane per epoch | 3 | The contract's `lanes.trials_per_epoch` |
| Reminders to a Pi worker | When 85% of the trial's time is used, 10 turns before a turn cap, and at 80% of the model's context window | Fixed |
| Nudges when a worker stops without submitting | 2. An OpenCode or Claude Code worker is continued again for as long as the owner's messages wait for its trial and its last run made progress | Fixed (Pi, OpenCode and Claude Code). Then the trial ends; the trial's time limit still applies |
| Time to finish after a submission | 5 s after the submission is recorded, the lane's agent is stopped. Its closing reply is not waited for, and a note or idea it has not written by then is not recorded | Fixed (OpenCode and Claude Code; Pi stops at once: no tool call runs after its submission) |
| Model call retries in a Pi trial | Waits of 5 s, doubling to 60 s. The trial ends after 6 failed calls in a row, 5 cut-off replies in a row, or a full context | Fixed |
| A lane's wait after unproductive trials | 15 s, doubling for each one in a row, at most 10 minutes. Unproductive: an error, no submission, or an attempt that is `rejected_v0` or `duplicate` (research: an error) | Fixed |
| A run's cool-down after 6 trials in a row end in errors | 30 minutes, with an `agents_cooldown` event. A new model given to the rig, or the run resumed, after the last of those errors ends it at once | Fixed |
| A full subscription usage window | Claude: no new trial or plan on the rig until the window resets. ChatGPT: 15 minutes, then try again | Fixed. Nothing buys more usage |

### Epochs and planning

The dashboard calls an epoch a **round**.

| What | Default | Notes |
| --- | --- | --- |
| Epoch cap | 3 hours. With `budget.wall_hours`, 6% of it, between 30 minutes and 3 hours | An epoch ends when every lane's trials are done and settled, or at the cap once no trial runs |
| Fork rounds | Every 20 epochs (epochs 21, 41, …). With `budget.wall_hours`, at one third and two thirds of it | Every lane starts again from the champion |
| Planner call | 180 s with Pi; 300 s with OpenCode or Claude Code | A failed or timed-out call, or an answer that code refuses, is tried once more; a refused answer goes back with its problems. After a second failure, with no model, or with the planner turned off, lanes take queued experiments by the fixed rules (the [fallback](glossary.md)). Planner trouble never pauses research. A research run makes no planner call: its research plan fills the queue |
| Goal campaign: wait for the goal report | Up to 2 hours, or until 3 checks of the champion failed | Then the epoch is planned without it |

### The judge

| What | Default | Notes |
| --- | --- | --- |
| Calibration (A/A) | 6 blocks (`THERMITE_CALIBRATION_BLOCKS`), at most once in 24 hours for each hill-climb run, at the lowest priority | Fewer than 2 blocks turns it off |
| Goal checks of the champion | Once for each champion. After a failure, up to 3 times, 10 minutes apart | |
| A job's lease | 15 minutes, renewed every block | A job whose lease ran out 3 times is `blocked` |
| Readiness before each block | Up to 15 retries, 2 s apart | Then an infrastructure failure: `crash_infra`, one retry |
| A CPU ready for timing | 1-minute load at most 75% of the cores | |
| A GPU ready for timing | Use at most 5%, memory in use at most 600 MiB, at most 85 °C, no compute processes and no thermal or power slowdown | |
| A slowed-down block | Thrown away and run again when the harness was CPU-throttled for more than 2% of it or of any one run, or the device reports a problem afterwards. 3 tries | Then an infrastructure failure |

### The rig and control

| What | Default | Setting |
| --- | --- | --- |
| Exports | Every 60 minutes, when anything new was recorded | `THERMITE_EXPORT_MINUTES`; **Edit rig** › **Exports** |
| Reports to control, exports pushed, champion uploads | Every 60 s | `THERMITE_POLL_SECONDS` |
| Commands fetched from control | Every 5 s | `THERMITE_COMMAND_POLL_SECONDS` |
| Live view lines sent to control | Every 3,000 ms | `THERMITE_LIVE_INTERVAL_MS` |
| The model route checked on control | Every 30 s | `THERMITE_MODEL_ROUTE_POLL_SECONDS` |
| A rig shown as not reporting | After 180 s without a report | `THERMITE_CONTROL_STALE_SECONDS` |
| A rig shown as offline in the REST API, MCP and `thermite rig list` | After 900 s without a report, never before it is stale | `THERMITE_CONTROL_OFFLINE_SECONDS` |
| A GPU cloud in **Providers** read again: prices, pods and spend | Every 15 minutes, and on **Read again** | Fixed |
| Advisor rounds | 60 s after the last round ended, never less than 30 s, unless a new owner's message to the teacher pair ends the wait (below) | `THERMITE_POLL_SECONDS` |
| Teacher reviews of a run | Every 60 minutes, and soon after the owner writes to the teacher pair, or to all the advisors, of a running run | `teacher_minutes` in the advisors file |
| A new owner's message to the teacher pair, or to all the advisors, looked for between advisor rounds | Every 5 s, when the rig has teachers and its **Teacher pair** switch is on. Finding one ends the wait, and the next round starts, unless the advisors' spending for the day has reached `max_usd_per_day`; a round under way finishes first | Fixed |
| An audit or review that failed | Tried again every 30 minutes, at most 5 times, then left to the owner | Fixed |
| Past research synced into each running run's `knowledge/` folder | Every 180 s. A run that control says it did not assign, such as a rig check's run, is asked about again 1 hour later, or once it has stopped running and runs again | `THERMITE_KB_SYNC_SECONDS`. `0` turns it off. The hour is fixed |
| Campaign folders copied to outside knowledge bases | Every 300 s for each copy switched on, at once when a copy is switched on, and on **Sync now** | `THERMITE_OUTSIDE_KB_SYNC_SECONDS`. `0` turns the timer off; **Sync now** still works |
| Research digests | Every 60 minutes | The contract's `report_cadence.digest_minutes` |
| Research fetches | 6 a minute for each domain: a fetch waits, it is never refused for this | A research run: the contract's `fetch_policy.per_domain_per_minute`. A hill-climb or goal run: fixed |

## Back-pressure

| What | Limit | Effect |
| --- | --- | --- |
| Open attempts | 4 (`budget.max_open_attempts` in the contract) | No new trial starts while this many of the run's attempts are `queued`, `building`, `screening`, `confirming`, `verifying`, `awaiting_audit` or `awaiting_approval` |
| A lane's next trial | After its last trial ended and that trial's attempt settled | The lane waits for the judge |
| One running run for each rig | Assigning or resuming a run pauses the rig's others: `replaced by <run>` | The other runs wait, paused |
| The judge | One job at a time on each judge device; builds one at a time on the rig | Jobs wait in a queue, by priority |
| Development runs on a shared device | A development run waits while the judge has any job queued or running, then holds the device | Waiting longer than 10 minutes gives up with `the judge kept the device busy; try again later` |
| One development run for each lane | A lane's next development run waits for its last | |

## Per-process and per-trial limits

Each ends one process, command or trial. The lane, the run and the campaign go on.

### Kit processes

The [kit manifest](kit-manifest.md) sets these; the defaults apply when it does not.

| Process | Time | Memory | Disk | Tasks |
| --- | --- | --- | --- | --- |
| Build (`build`) | 600 s | 4,096 MiB | 4,096 MiB | 512 |
| Run (`run`) | 300 s | 1,024 MiB | 256 MiB | 256 |
| Check (`check`) | 120 s | none | none | none |

Memory is the sum over all the processes the build or run started, sampled every 100 ms. Disk is the working directory, sampled every 500 ms; more than 50,000 files and folders, or more than 128 levels, also counts as over the disk limit. Only the last 64 KiB of output is kept.

### Lanes and agents

| Limit | Default | Set in the contract's `lanes.limits` |
| --- | --- | --- |
| One command a lane runs (a build, a test) | None: it runs until it ends or the trial ends | `run_timeout_s` (10 to 7,200) |
| Memory of everything a lane runs at once, OpenCode and Claude Code included | 2,048 MiB | `run_rss_mib` (256 to 16,384) |
| The trial's workspace, build folders included | 2,048 MiB | `workspace_mib` (256 to 65,536) |
| One development run | None on a development device of its own; 300 s on a device the judge shares | `dev_run_timeout_s` (10 to 3,600) |
| Memory of one development run | 4,096 MiB | `dev_run_rss_mib` (256 to 16,384) |
| A lane's build cache | 8 GB (`CCACHE_MAXSIZE`) | Fixed |
| One file-tool call of a Pi worker | 30 s | Fixed |
| Preparing a submission's patch | 60 s | Fixed |
| A Pi worker process | The trial's length plus 2 minutes, and 2 GiB of memory | Fixed |
| A submission, its patch included | 32 MiB | Fixed |
| A submission | One for each trial: `trial <id> has already submitted` | Fixed |

### Checks and research

| Limit | Value |
| --- | --- |
| Model route check | 120 s |
| Isolation check | 30 s for each role |
| Smoke check | 3 hours for the whole check |
| A research fetch | 30 s, at most 5 redirects, at most `fetch_policy.max_bytes` (5,000,000 by default). In a hill-climb or goal run, 5,000,000 bytes, and `robots.txt` is respected |
| A research tool's answer | 14,000 characters when it is JSON, for a Pi worker's file tools too. A folder listing shows at most 500 entries, a folder search at most 200 lines |
| One advisor call (`openai` runtime) | `max_turns` 24 and `timeout_s` 900, unless the advisors file sets them |
| One advisor call (`cli` and `claude-code` runtimes) | `timeout_s` 1,800, unless the advisors file sets it |

### Sizes a rig has

| Limit | Value |
| --- | --- |
| Lanes | 16: the harness image has users for lanes 1 to 16. A contract's `lanes.count` accepts up to 64 |
| Judge and development GPUs | 8 of each |
| GPUs on a rig control sets up on a machine or cluster | 16; 8 on a namespace joined with a join command |

## The owner's messages

None of these ends anything. A message itself is 1 to 4,000 characters (see [Control's own limits](#controls-own-limits)), and [Signed commands](signed-commands.md#message_agent) describes who reads it.

| What | Limit |
| --- | --- |
| Messages kept in force | No limit: each one stays in every new trial's brief until the owner removes it |
| The owner's messages in an advisor's brief or package | Up to 20 that the role has not read. The teachers' brief also shows up to 5 that they read in the last 24 hours. The brief or package in an advisor's prompt is cut to 120,000 characters for the teachers and the combiner, and 200,000 for the auditor and each panelist; the owner's messages come first in it and are never cut |
| An advisor's answers to the owner's messages | The first 50 in one answer, each cut to 1,000 characters. An answer longer than 20,000 characters, empty, or otherwise not fitting is left out; the others still count, and so does the advisor's review, audit or verdict. See [Advisors file](advisors-file.md#answers-to-the-owners-messages) |
| How soon the teacher pair reads a new message | In the next teacher round. While the run is running and no round is under way, that round starts within about 5 s. When the advisors' spending for the day has reached `max_usd_per_day`, it waits for the first round after midnight UTC, and the run's **Live** says so. See [The rig and control](#the-rig-and-control) |

## The experiment queue

None of these ends research. Nothing limits how many experiments a run's [experiment queue](glossary.md) holds, or how many ideas the lanes propose. [Experiment states](verdicts.md#experiment-states) describes the queue itself.

| What | Limit |
| --- | --- |
| An experiment's title | 1 to 200 characters |
| Its details | Up to 4,000 characters |
| Its direction | 1 to 80 characters: a family's name or your own words |
| Its why | Up to 2,000 characters. Dropping an experiment needs a why of 1 to 2,000 characters |
| A place in the queue | `top`, `end`, or an index from 0 to 100,000 among the queued experiments, 0 first. An index past the last puts it last |
| A lane's idea | One request of at most 64 KiB. No limit on how many |
| Experiments copied into a new run by **Start a run** or `thermite assign --queue-from` (`assign_campaign`'s `queue`) | 500. Both copy at most the first 500: the run's experiments up next, in order, then its lanes' ideas. A command with more is refused. With **Agents** off, **Start a run** copies none, and `thermite assign` refuses `--queue-from` |
| The planner's answer | At most 20 experiments added, 40 moves, 40 drops, 40 ideas accepted, 5 rules and 8 new families |
| A teacher's or the combiner's answer | Up to 10 experiments and 10 moves, each with a why. One that doesn't fit is left out; a list of more than 50 is ignored. Its review still counts |
| The auditor's answer | One check |
| The advisors' experiments in one request to the harness | Up to 20 experiments and 20 moves |
| The queue in the planner's and the teachers' brief | The first 40 up next, the newest 20 ideas, every experiment in progress, and the newest 20 tried, with the judge's verdicts. Details are cut to 600 characters and whys to 400 |
| The **Planner** tab's hand-outs | The newest 30. Control keeps the newest 50 for each run |

## Field notes and the knowledge base

None of these ends anything. Nothing limits how many [field notes](knowledge-base.md#field-notes) an agent writes, or how many items a campaign's folder holds. The windows below say how much each agent is shown, not how much is kept.

| What | Limit |
| --- | --- |
| A field note | 1 to 2,000 characters. What it is about: an id of 1 to 200 characters |
| A worker's note (`thermite-trial note`, Pi's `note`) | One request of at most 64 KiB |
| An advisor's notes, posted to the harness | One request of at most 2 MiB for each advisor |
| A research note (`add_note`) | Cut to 4,000 characters, with at most 20 sources |
| Field notes in a worker's brief | Its lane's newest 10, and the run's newest 5 decisions and lessons by other writers |
| Field notes in the planner's and the teacher pair's brief | The run's newest 20 |
| The run page's **Journal** tab | The newest 500 field notes; the rest are in the campaign's folder and the run's export |
| A briefing (`assign_campaign`'s `briefing`) | Up to 200 items, each 1 to 4,000 characters |
| An item of the knowledge base | Title 300 characters, text 20,000 |
| Search words | The first 8 words of 2 or more characters; at most 300 characters in all |
| Search results | The **Knowledge** page 100; **Start a run** › **From past research** 40; `kb_search` 1 to 100, default 20 |
| A run's sync of past research | Pages of up to 500 items from control, posted to the harness in parts of at most 8 MiB. The harness takes at most 32 MiB in one request |
| A copy to an outside knowledge base | 100 items at a time, one page each, until the folder is written. A page the outside server refuses stops the sync, and each later sync tries it once more; after 3 refusals in a row it is skipped, and the copy goes on |

## Control's own limits

| What | Limit |
| --- | --- |
| A command's time to reach its rig | 60 minutes by default, at most 7 days (`--ttl` or `ttl_minutes`). Propagation: 24 hours. A full reset's commands: 30 minutes |
| A signed command's size | 3.5 MiB: `the <kind> command is too large to deliver` |
| Clocks | A rig refuses a command dated more than 5 minutes ahead of its own clock, and control a report dated more than 5 minutes ahead of its own |
| A full reset's steps | Quiescing 1 hour, exporting 30 minutes, verifying 1 hour, waiting for the owner 24 hours, wiping 30 minutes. A step that takes longer fails the reset |
| Dashboard sessions | End after 30 days unused (`THERMITE_CONTROL_SESSION_DAYS`) |
| Failed sign-ins | After 20 in a minute: `too many failed sign-ins; wait a minute` |
| A join command | Works once, within 1 hour |
| Setting a rig up on a machine | 30 minutes for the script, then up to 10 minutes for the first report. A joined rig: up to 60 minutes. A cluster rig: up to 10 minutes |
| An install on a machine | 30 minutes |
| SSH connections | 15 s to connect |
| `kubectl` requests | 30 s |
| The live view | The newest 20,000 lines of each rig |
| A daily report | 200,000 characters |
| A kit uploaded on the **New campaign** page | 64 MB and 2,000 files |
| A message to an agent | 1 to 4,000 characters, after control trims it. One with no words: `Write a message first.` |
| A redirect | 1 to 40 directives, each with a rationale of up to 2,000 characters and up to 20 citations. A rule in your own words (`match`) is 1 to 200 characters |
| REST lists | `?limit=` from 1 to 5,000. Defaults: events and live lines 500, audit 200, commands 100, reports 20 |
| MCP lists | `kb_search`: 1 to 100, default 20; `recent_events`: at most the newest 50 events; `list_commands` (`limit`) and `get_run` (`attempts`): 1 to 500, default 50; `run_queue`: `tried` 0 to 500, default 50, with the newest 10 hand-outs and the newest 20 messages; `control_log`: 1 to 500 a page, default 100, with `before` and `after` for the other pages; `rig_reports` and `runpod_tests`: 1 to 50, default 5 |
| Dashboard lists | A run's newest 300 attempts and 400 history events; 300 audit entries a page, with **Older** and **Newer** for the rest; a campaign's first 8 **Earlier runs**, then **Show N more**. A run's **Live** first loads its newest 600 lines, then asks every 2 s, while the page is in view, for up to 500 new ones |
| Request bodies from rigs | Reports 32 MiB; live lines 4 MiB; champion patches 64 MiB; daily reports 1 MiB; command results and supervisor figures 256 KiB |
