---
title: "Steer a run"
description: "Pause, resume, redirect, message the agents or reset the workers of a running campaign."
type: how-to
sidebar:
  order: 8
---

You can steer a running campaign without touching its judge: pause or resume it, start its workers afresh, tell its planner which directions to try or avoid, and send its agents a message. Nothing you do here changes a verdict.

| Action | What it does |
| --- | --- |
| **Pause** | The agents' running [trials](../../reference/glossary.md) stop, and no new ones start. A stopped trial's work that it had not submitted is thrown away; changes already submitted stay. The judge finishes the job it is on; the run's other queued jobs wait until you resume |
| **Resume** | New trials start again, and the planner plans the next round. Agents resting after six failed trials in a row ([limits and pacing](../../reference/limits-and-pacing.md#trials-and-lanes)) start again at once. Any other running run on that rig is paused: a rig runs one run at a time |
| **Reset workers** | Ends the running trials and the current round. The planner plans afresh, and every lane starts again from the champion. Nothing the judge decided is lost |
| **Steer** | Tells the planner, from its next plan on, to avoid a direction, to try it, or to always assign it |
| A message | Text for one lane, one trial, the planner or the rig's advisors |

A trial is one worker's session in a [lane](../../reference/glossary.md): it ends when it submits a change, when its time runs out, or when it stops. [Agents, lanes and the planner](../../explanation/agents-lanes-planner.md) explains lanes, trials and the planner.

## Before you start

- A run that is running or paused. A closed run can't be resumed: `run <id> is closed`.
- The owner's sign-in on the dashboard, the owner's token for the command line, or an MCP token that may steer: see [Who may do what](#who-may-do-what).

## Steer from the dashboard

1. Open **Campaigns** in the sidebar, the campaign, then the run's **Steering** view. The **Steer this run** card says how many directives are in force and how a confirmed win is promoted in this run.
2. Press one of:
   - **Pause**, with an optional reason in **why (optional)**. The run's header has a quick **Pause** or **Resume** button too.
   - **Resume**, when the run is paused.
   - **Reset workers**.
   - **Steer**: choose **avoid**, **try** or **always assign**, write the **direction** and **why, with a source**, then press **Steer**. A direction is a name of 2 to 41 lowercase letters, digits and dashes, such as `loop-tiling`. To steer a direction the planner already uses, copy its name from the plans in **History** (see below): **avoid** matches that exact name. For a new direction, make up a name, and say in **why, with a source** what you mean: the planner reads it, and the workers never do. Another name gives `refused: bad redirect payload: …`. **Each Steer replaces your earlier directives**, unless you tick **keep my earlier ones**.

   The page says `Control sent the command to rig-1. The rig does it in less than 10 seconds. This page shows the result.`, with your rig's name.
3. Press **refresh** in the status bar, the line along the bottom of the page, a little later. The run's **History** shows what happened once the rig has reported, within a minute: `Run sort-speed-1 paused: checking the kit.`, `Run sort-speed-1 resumed.`, or `A steering directive took effect.` After **Reset workers**, the running trial shows as `ended without a submission (interrupted)`, and a new plan follows.

The **History** view's plans show the direction names the planner uses, such as `The planner planned epoch 4: lane-1 on loop-tiling; lane-2 on vectorize.`

When the planner can't make a plan, it uses its fallback plan, and **History** says `its fallback plan`. The fallback plan follows **avoid** and **always assign**, but a **try** only of a direction already in use. To have a new direction worked on, use **always assign**.

## Send the agents a message

1. Press **Live** in the run's header, beside **Pause** or **Resume**, or **Live sessions** on the **Steering** view. Both open the rig's page of live sessions, which you also reach from **Live** in the sidebar.
2. Choose a session on the left, such as a worker's trial.
3. Write the message in the box at the foot of the page. In the first list, choose who gets it:
   - **this worker (…)**: the trial you are watching;
   - **lane-1: its running or next trial**, and so on;
   - **the planner (next plan)**;
   - **the advisors (next brief)**: the rig's teacher pair, in their next round.
4. The second list names the run the message is for. It already shows the session's run, or the rig's running run: change it only to write to another run on the same rig. Press the send button, or Ctrl+Enter (⌘+Enter on a Mac).

The message shows in the live log within seconds, as `Owner to lane-1: …`, or `Owner to trial:…` for the worker you are watching. Workers read it after their current turn. The judge takes no messages.

## Steer from the command line

`thermite command` sends the same commands, with the owner's token. Run `npx thermite` in your Thermite folder, after `npm ci` and `npm run build` (see [the command line](../../reference/command-line.md)). The examples use the owner's token file of the local stack, `.dev/secrets/control-admin-token`. If you made an owner's token of your own, use its file instead.

```sh
npx thermite command --control http://127.0.0.1:8800 --token-file .dev/secrets/control-admin-token \
  --rig local-1 --kind pause_run --payload '{"run":"sort-speed-1","reason":"checking the kit"}'
```

It prints the command's id and `"status":"pending"`. The payloads:

| Kind | Payload |
| --- | --- |
| `pause_run` | `{"run":"sort-speed-1","reason":"checking the kit"}` |
| `resume_run` | `{"run":"sort-speed-1"}` |
| `reset_workers` | `{"run":"sort-speed-1"}` |
| `redirect` | `{"run":"sort-speed-1","directives":[{"kind":"avoid","family":"loop-tiling","rationale":"three trials regressed"}]}` |
| `message_agent` | `{"run":"sort-speed-1","to":"lane-2","text":"Look at the cache misses first."}` |

A `redirect` takes up to 40 directives, each with a `kind`, a `rationale`, and a `family` or `value` where the kind needs one:

| `kind` | What it does |
| --- | --- |
| `avoid` | No lane is given that direction |
| `try` | The planner should try it |
| `mandate` | Every plan gives that direction a lane (**always assign** on the dashboard) |
| `priority` | Ranks a direction for the planner |
| `lane_count` | `value`: how many lanes to plan, up to the contract's `lanes.count` |
| `note` | Free text for the planner |

- A set replaces your earlier set unless it has `"replace": false`.
- A set that both avoids a direction and asks for it is refused: `the set both avoids and asks for <direction>`.
- Only the planner sees rationales and notes; workers never do.
- Your directives come before any that the rig's advisors send about the same direction.

A `message_agent`'s `to` is `planner`, `advisors`, `lane-1` to `lane-16`, or `trial:` and a trial's id. The text may be up to 4000 characters.

Over MCP, an agent sends the same kinds and payloads with the `issue_command` tool, then follows them with `command_status`. See [Let an agent run Thermite over MCP](../automate/agent-over-mcp.md).

## Who may do what

| | Pause, resume, reset workers, redirect | Message an agent |
| --- | --- | --- |
| The owner: dashboard, REST API, command line, MCP | yes | yes |
| The operator's token over MCP | yes | yes |
| The agent's token over MCP | yes | no |
| The reader's token | no | no |

Approving and rejecting changes is the owner's alone: see [Decide what waits for you](decide-what-waits.md). [Tokens and roles](../../reference/tokens.md#people-and-agents) has every role.
