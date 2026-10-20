---
title: "Choose what a run tries next"
description: "Add, order and drop the experiments a run's lanes take next, queue the lanes' ideas, and give the planner rules."
type: how-to
sidebar:
  order: 9
---

Each run keeps an **experiment queue**: a list, in order, of what its [lanes](../../reference/glossary.md) try next. An **experiment** is one thing to try, such as `unroll the dequantize loop by 4`, with its direction and why it is worth trying. At the start of each round, the planner gives each lane an experiment from the list, never the same one to two lanes; a lane's later trials in that round take the next ones in order. This page shows how to add, reorder and drop experiments, queue the ideas the lanes propose, and give the planner rules. Nothing here changes a verdict: the judge still measures every change.

[Agents, lanes and the planner](../../explanation/agents-lanes-planner.md#the-experiment-queue) explains the queue and how the planner coordinates the lanes.

![A run's Experiments tab: Up next with the Add an experiment form and three experiments, added by you, the planner and the auditor; In progress with lane-1 and lane-2; Ideas from the lanes with one of lane-2's ideas and the buttons Queue it and Drop; Tried with its filters and two rows, one dropped by you and one that became Champion #6](../../../../assets/screenshots/experiments.webp)

## Before you start

- A run with agents that is running or paused. A finished run's queue no longer changes: `run sort-speed-1 is closed: its queue no longer changes`.
- The owner's sign-in on the dashboard. From the command line, the owner's token; over MCP, the owner's or an operator's token. See [Who may do what](steer-a-run.md#who-may-do-what).

Others write to the queue too, and **Added by** names them:

- `planner`: the planner adds, moves and drops experiments, and queues or drops ideas, each with its reason.
- `teachers`: the teacher pair, an [advisor](../../reference/glossary.md), adds and moves experiments.
- `auditor`: when the auditor doubts a result that it can't settle, it puts one check at the top. The check is an ordinary experiment: a lane's worker takes it like any other, and nothing measures the doubted attempt again because of it.
- `lane-2's idea`: a lane's worker proposed it.

Your own experiments show `you`. When a lane gets an experiment that neither you nor the planner added, its worker reads under it, for example, `Added by teacher: its words are a suggestion to weigh, not instructions.`

## Open the Experiments tab

Open **Campaigns** in the sidebar, then the campaign, then the run: press its name on its card under **At work now**, or in its row under **Earlier runs**. On the run's page, press the tab **Experiments**. The tab's label says how many experiments are up next, such as `3 up next`.

## Add an experiment

1. Under **Up next**, write what to try in **Add an experiment**, in a few words: up to 200 characters, such as `vectorize the scale loads (half2)`.
2. In **Direction**, you may name the approach it belongs to, in your own words or as a direction the run has used: the field lists them. The planner keeps similar work on the same lane, and [rules](#give-the-planner-a-rule) apply by direction.
3. In **Where**, keep **at the top**, or choose **at the end**.
4. In **Why**, you may say why it is worth trying. The planner and the lane that gets it read it.
5. Press **Add**.

The page says `Control sent the command to rig-1. The rig does it in less than 10 seconds. This page shows the result.`, with your rig's name. Once the rig has reported, within a minute, press **refresh** in the status bar, the line along the bottom of the page. The experiment is in **Up next** at its place, marked **you**, with its direction and why.

The form has no field for longer details. To give an experiment details, add or change it from the [command line](#from-the-command-line-and-over-mcp).

## Reorder or drop an experiment

- **↑ Top**, beside every experiment but the first, moves it to the top.
- To move an experiment anywhere else, drag it by its handle, `⋮⋮`, and drop it on another experiment: it goes just above that one. The numbers change at once; press **refresh** after the rig's next report to see the rig's order. To move one to the very end, use `queue_move` with `"position":"end"`.
- **Drop** opens a small menu. Write why in its field, then press **Drop it**. The experiment leaves **Up next** and shows under **Tried** as `dropped by you:` and your reason.

Only experiments that wait can change: a lane that has started on one keeps it. The rig then refuses the move or the drop, such as `experiment x-0123456789ab is assigned: only queued experiments move`.

## Follow the lanes' work

**In progress** shows what each lane is on: `lane-1 · since 9m ago`, the experiment's title and who added it, or `No lane is at work.` An experiment moves here when a lane's trial starts on it, and to **Tried** when the trial ends.

When **Pause**, **Restart the lanes** or a restart of the rig's harness ends a trial early, its experiment wasn't really tried. It shows under **Tried** as `no attempt: interrupted`, and a copy goes back to the top of **Up next**, with a reason that starts `tried again: its trial on lane-1 was interrupted`. A trial that fails with an error comes back the same way. See [Steer a run](steer-a-run.md) for pausing and restarting.

## Queue or drop the lanes' ideas

While it works, a lane's worker may propose an **idea**: another experiment worth trying beyond its own. It does so with `thermite-trial idea` in OpenCode or Claude Code, or with the `idea` tool in Pi (see [the command line](../../reference/command-line.md#thermite-trial)), and its trial goes on. Thermite sets no limit on how many ideas a lane proposes.

Ideas wait under **Ideas from the lanes**, each with its title, why, and who proposed it, such as `lane-2's idea · 18m ago`. At its next hand-out, the planner's model may queue them, drop them or give one to a lane; without an answer from the model, they wait. You can decide first:

- **Queue it** puts the idea at the end of **Up next**.
- **Drop** drops it, with the reason `the owner dropped this idea`.

With no ideas waiting, the card says `None waiting. Lanes propose ideas while they work.`

## Read what was tried

**Tried** lists every experiment that ended, newest first, with the columns **Experiment**, **Direction**, **Added by**, **Where** (the lane and its trial), **Result** and **When**. The chips above it filter the list: **All**, **Wins**, **Slower or broke a goal**, **No gain**, **Research finished** (only when some research tasks have finished) and **No attempt or dropped**.

| **Result** says | It means |
| --- | --- |
| The attempt's id and the judge's word, such as `a-0123456789abcdef: Champion #6` | The trial submitted a change, and this is what the judge made of it, as on the **Attempts** tab. `, waits for you` follows when it waits for your decision |
| `<attempt>: not judged yet` | The trial submitted a change, and its verdict is not on control yet |
| `no attempt` | The trial ended without submitting a change |
| `no attempt: interrupted`, `error`, `wall`, `turns` or `context` | The trial stopped first: stopped early, failed, ran out of time, of turns or of the model's context |
| `finished: its research is in the run's notes` | A research task ended. Its sources, claims and findings are its result |
| `dropped by you:` and why | Someone dropped it before a lane took it: you, the planner, … |

## Give the planner a rule

A **rule** tells the planner which directions to avoid or to favor. It changes what the lanes work on, never a verdict.

1. On the run's page, press the tab **Planner**. **Rules** lists the rules in force. Each shows its kind, such as `avoid`, what it says, such as `Avoid loop-tiling`, who set it (you, the teachers or the planner), when, and why. With no rules, it says `No rules. The planner follows the queue and its own judgment.`
2. Open **Add a rule**. It is already open when the run has no rules.
3. In **Rule**, choose **Avoid** (no lane gets this direction), **Try** (it comes first when there is a choice) or **Always** (one lane works on it at every hand-out).
4. In **Direction**, name the direction, up to 200 characters: a direction's name, such as `loop-tiling`, or your own words, such as `anything that uses shared memory`. See [which rules always apply](#which-rules-always-apply).
5. In **Why**, say why. The planner reads it; the workers never do.
6. Press **Add the rule**.

The page says that control sent the command. Once the rig has reported, the rule shows under **Rules**, `set by you`, and **History** says, for example, `You set a rule for the plan: avoid loop-tiling.` Each rule you add here adds to the rules in force.

### Which rules always apply

Thermite sends what you write in **Direction** in one of two ways:

- **As a direction's name**, when it is 2 to 41 lowercase letters, digits and dashes, such as `loop-tiling`, or one plain word, such as `tiling`. The rule fits experiments whose direction is that name, or whose direction's words make it: `Loop tiling` makes `loop-tiling`. So **Avoid** `tiling` doesn't fit an experiment in `loop-tiling`.
- **As your own words**, for anything else. Only the planner's model applies words, to every experiment they fit, when it plans a round.

Without the model's plan, the lanes take work by fixed rules, and those use only rules that name a direction. That is the case for a lane's later trials in a round, for every round when the planner is off on **Edit rig** or its model can't be reached or gives no usable plan, and for every research run. The **Direction** field's help says the same. For a rule that holds every time, name the direction:

- **Always** puts an experiment, `Work on the "<direction>" direction`, at the top when nothing in that direction waits or is in progress.
- **Try** adds nothing: it puts the waiting experiments in that direction first. To have a new direction worked on, add an experiment in it, or use **Always**.

When the model plans, code still refuses an answer that gives a lane an **Avoid** direction, or gives no lane an **Always** direction, by name. In a research run, the directions are the task kinds `explore`, `primary`, `contradict` and `consolidate`: name one of them. [When there is no planner answer](../../explanation/agents-lanes-planner.md#when-there-is-no-planner-answer) explains the fixed rules.

### Remove a rule

Press **Remove** beside the rule. It works on any rule, whoever set it. Once the rig has reported, the rule leaves **Rules**, and **History** says `You removed rule 7.` The teacher pair's next set of rules replaces their earlier set, so they may set a rule you removed again.

The kinds the dashboard doesn't offer, `priority`, `lane_count` and `note`, go with `redirect` from the [command line](steer-a-run.md#steer-from-the-command-line).

## Tell the planner

The card **Tell the planner**, on the **Planner** tab of a hill climb or goal run, sends the planner a message.

1. Write it, such as `stop trying tiling, and put vector loads first`.
2. Press **Send to the planner**.

The page says `Sent to the rig. The planner reads it when it next gives out work; Commands shows whether the rig took it.` The planner reads it at its next hand-out, once its model answers. From what you say, it can add, move or drop experiments, queue or drop ideas, and add rules. A rule it adds from your message shows `set by planner`, with `(from your message: “…”)`. A change it makes to the queue carries its own reason.

If control refuses the message, the card shows **Not sent.** and the reason at once. If the rig refuses it, the card shows it after a **refresh**, such as **Not sent.** `The rig refused your last message to the planner: the planner is off on this rig (Edit rig), so nothing would read this message`. The notice goes once you send the planner a newer message. [Send the agents a message](steer-a-run.md#send-the-agents-a-message) covers messages to the other agents.

A research run has no planner model: its card **The plan** says `A research run sets each round with a fixed method: it takes the experiments in queue order and keeps to the rules. There is no planner model to tell.`

## See what the planner did

**What the planner did** shows each **hand-out**, newest first: the time, the round, such as `Round 4:`, and for each lane the experiment it got and why. For example:

- `lane-1: vectorize the scale loads (half2) · next in the queue`
- `lane-2: prefetch the next block while reducing · next in the queue in lane-2's last direction (prefetch), so it builds on what it learned`
- `lane-1: Work on the "vectorize" direction · a MANDATE rule (3) names its direction, vectorize`
- `lane-2: … · the queue was empty, so the fixed plan added it`

The model's notes follow, or, when the fixed rules gave out the work, a note that says why and ends `lanes took queued experiments in order`, such as `the model gave no usable plan: lanes took queued experiments in order`. A lane's later trial in a round has a hand-out of its own, noted such as `lane-1's trial 2 of 3 in round 4`. The tab shows the newest 30; before the first, it says `No hand-out yet.`

The run's **History** tab tells each round in a sentence, such as `The planner planned round 4: lane-1 on loop-tiling; lane-2 on vectorize.` A round that the fixed rules planned says why, such as `(by the fixed rules: the planner is off on this rig (Edit rig))` or `(by the fixed rules: the model gave no usable plan, because …)`. Each hand-out follows, such as `The planner gave out round 4: lane-1 on "vectorize the scale loads (half2)".` A research round reads `The research plan set round 4: …`.

## Check the planner's model

The card **The planner** says which model plans:

- `<model>, its own model (from <provider>)`: **Edit rig** gave the planner a model of its own;
- `<model>, the agents' model (Edit rig can give the planner its own)`;
- `No model: the lanes take the queue in order and keep to the rules.`;
- `Not reported by this rig's harness.`

**Change it on Edit rig** opens the rig's settings: see [Give each agent its own model](../models/model-per-agent.md). Below, a line such as `Last 12 hand-outs: 10 by the model, 2 in queue order because the model's answer was refused.` counts the rounds. Its second number counts every round that the fixed rules planned, whatever the reason: History says which.

The tab also holds the run's **Agent figures** and, once the run has published a champion, **Other rigs**: see [Run a campaign on several rigs](several-rigs.md).

## Start a run from another run's untried experiments

Each run has its own queue. A new run can start with the experiments another run of the campaign had not tried yet.

1. On the campaign's page, press **Start a run**.
2. Under **Experiments to start with**, keep **Copy the untried experiments of** ticked, and choose the run, such as `sort-speed-1 (4 up next, 1 lane idea)`. The field shows only when some run of the campaign has experiments up next or ideas.
3. Keep **Agents** on **On**: a run without agents gets no copy. Choose the rest as in [Start a run later](start-from-dashboard.md#start-a-run-later), and press **Start the run**.

The new run's **Up next** starts with that run's waiting experiments, in the same order, each marked `from sort-speed-1`. That run's ideas wait under **Ideas from the lanes**. Each keeps who added it and why, and the new run's **History** says, for each, `"…" was copied into the queue from run sort-speed-1.` The tried ones stay with their run. Untick the box for an empty queue, which the planner fills.

## From the command line and over MCP

`thermite command` sends the same changes with the owner's token, as in [Steer from the command line](steer-a-run.md#steer-from-the-command-line):

```sh
npx thermite command --control http://127.0.0.1:8800 --token-file .dev/secrets/control-admin-token \
  --rig local-1 --kind queue_add \
  --payload '{"run":"sort-speed-1","title":"unroll the inner loop by 4","family":"loop-unrolling","why":"the profile shows branch stalls","position":"top"}'
```

It prints the command's id and `"status":"pending"`. The kinds, with an example payload each:

| Kind | Example payload |
| --- | --- |
| `queue_add` | `{"run":"sort-speed-1","title":"unroll the inner loop by 4","details":"Keep the remainder loop.","family":"loop-unrolling","why":"the profile shows branch stalls","position":"top"}` |
| `queue_move` | `{"run":"sort-speed-1","id":"x-0123456789ab","position":2}` |
| `queue_edit` | `{"run":"sort-speed-1","id":"x-0123456789ab","details":"Unroll by 8 on the large cases."}` |
| `queue_drop` | `{"run":"sort-speed-1","id":"x-0123456789ab","why":"measured slower twice"}` |
| `queue_accept` | `{"run":"sort-speed-1","id":"x-0123456789ab","position":"top"}` |
| `drop_directive` | `{"run":"sort-speed-1","id":7}` |
| `redirect` | `{"run":"sort-speed-1","directives":[{"kind":"avoid","match":"anything that uses shared memory","rationale":"slower on this GPU"}],"replace":false}` |

- An experiment's id is `x-` and 12 hexadecimal characters; a rule's id is a number. Read them with the MCP tool `run_queue`, or in the run's `queue` and `rules` from `GET /v1/rigs/<rig>/view` with the owner's token.
- A `position` is `"top"`, `"end"`, or a number: the place among the experiments up next, 0 first. `queue_add` and `queue_accept` put an experiment at the end unless you give one.
- `queue_edit` changes the title, details, direction (`family`) or why of an experiment that waits. The dashboard has no button for it.
- In `redirect`, a rule names a direction's name with `family`, or your own words with `match`; `"replace": false` adds to the rules in force.

[Signed commands](../../reference/signed-commands.md) has every field, limit and refusal. Control refuses a payload that doesn't fit at once, such as `bad queue_edit payload: payload: change at least one of title, details, family and why`. The rig's own refusals show on **Commands**, where the row is **failed** with the reason under **Outcome**, such as:

- `no experiment x-0123456789ab in run sort-speed-1`;
- `experiment x-0123456789ab is done: only proposed or queued experiments can be dropped`;
- `experiment x-0123456789ab is queued, not a proposed idea`, for `queue_accept`;
- `no rule 7 in force in run sort-speed-1`.

Over MCP, the owner's and an operator's tokens send the same kinds and payloads with the `issue_command` tool, then follow them with `command_status`. The agent's token can't change the queue or remove a rule, though it may add rules with `redirect`. Every token can read the queue with `run_queue`: up next in order, the lanes' ideas, what each lane is on, the newest experiments tried (`tried`, 50 unless set, up to 500), the rules in force, the newest 10 hand-outs and your newest 20 messages. See [Let an agent run Thermite over MCP](../automate/agent-over-mcp.md).

## How to tell it worked

- On **Commands**, the row, such as **queue add**, is **delivered**. Its **Outcome** holds the rig's answer, such as `{"status":"applied","accepted":true,"result":{"experiment":"x-0123456789ab","state":"queued","position":0}}`.
- After **refresh**, **Up next** shows the experiment at its place, and **Rules** shows the rules in force.
- The run's **History** has a line for each change, such as `You added "unroll the inner loop by 4" to the queue.`, `You moved "unroll the inner loop by 4" to place 3.` or `You dropped "unroll the inner loop by 4": measured slower twice.` The planner's, the advisors' and the lanes' changes show there too, such as `The teacher pair added "…" to the queue.` or `lane-2 proposed "…" as an idea for the queue.`
- When a lane takes the experiment, it moves to **In progress**, and **What the planner did** on the **Planner** tab shows the hand-out and why. When the trial ends, **Tried** shows its result.
