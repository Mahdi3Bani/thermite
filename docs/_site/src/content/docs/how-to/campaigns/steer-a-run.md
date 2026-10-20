---
title: "Steer a run"
description: "Pause, resume or restart a run's lanes, and send its agents messages."
type: how-to
sidebar:
  order: 8
---

You can steer a running campaign without touching its judge: pause or resume it, start its lanes afresh, and send its agents a message. To choose what the lanes try next, and to give the planner rules, see [Choose what a run tries next](choose-what-runs-next.md). Nothing you do here changes a verdict.

| Action | Where on the dashboard | What it does |
| --- | --- | --- |
| **Pause** | The run's header, Live's header, or the run's card under **At work now** | The agents' running [trials](../../reference/glossary.md) stop, and no new ones start. A stopped trial's work that it had not submitted is thrown away; changes already submitted stay. Each stopped trial's experiment goes back to the top of the run's [queue](choose-what-runs-next.md). The judge finishes the job it is on; the run's other queued jobs wait until you resume |
| **Resume** | The run's header, Live's header, or the run's row under **Earlier runs** | New trials start again, and the planner plans the next round. Agents resting after six failed trials in a row ([limits and pacing](../../reference/limits-and-pacing.md#trials-and-lanes)) start again at once. Any other running run on that rig is paused: a rig runs one run at a time |
| **Restart the lanes** | **⋯** in the run's header, while the run is running | Ends the running trials and the current round. Their experiments go back to the top of the queue. The planner plans afresh, and every lane starts again from the champion. Nothing the judge decided is lost |
| A message | The message box in **Live**, or **Tell the planner** on the **Planner** tab | Text for everyone working, one lane, the planner or the [advisors](../../reference/glossary.md). A message to everyone or to a lane can stay in force for every new trial |
| The experiment queue and the rules | The run's **Experiments** and **Planner** tabs | See [Choose what a run tries next](choose-what-runs-next.md) |

A trial is one worker's session in a [lane](../../reference/glossary.md): it ends when it submits a change, when its time runs out, or when it stops. [Agents, lanes and the planner](../../explanation/agents-lanes-planner.md) explains lanes, trials and the planner.

## Before you start

- A run that is running or paused. A finished run can't be resumed: `run <id> is closed`.
- The owner's sign-in on the dashboard, the owner's token for the command line, or an MCP token that may steer: see [Who may do what](#who-may-do-what).

## Pause, resume or restart the lanes

1. Open **Campaigns** in the sidebar, then the campaign. Press the run's name: on its card under **At work now**, shown as `<campaign> › <run>`, or, for a paused run, in its row under **Earlier runs**. The run's page opens.
2. In the run's header:
   - To pause, press **Pause**. A small menu opens. It says `The lanes' running trials stop and no new ones start. Its jobs waiting for the judge wait until you resume, so the judge's time goes to running runs. Resume picks up from the same champion.` You may say why in **why (optional)**, up to 500 characters. Press **Pause the run**.
   - To resume a paused run, press **Resume**.
   - To restart the lanes, press **⋯**, then **Restart the lanes**. **⋯** shows only while the run is running.

   The page says `Control sent the command to rig-1. The rig does it in less than 10 seconds. This page shows the result.`, with your rig's name.
3. A little later, press **refresh** in the status bar, the line along the bottom of the page. Once the rig has reported, within a minute, the run's **History** tab shows `Run sort-speed-1 paused: checking the kit.`, with the reason you gave, or `Run sort-speed-1 resumed.` After **Restart the lanes**, the running trial shows as `ended without a submission (interrupted)`, and a new plan follows.

With **why (optional)** left empty, the reason is `paused from the dashboard`. The reason also shows in the run's **Now** block, and under **Why it stopped** in the campaign's **Earlier runs**.

## Send the agents a message

![Live for one run: the runs at work on the left; the run's header, its filters (Everyone, lane-1, lane-2, Planner, Judge, Advisors, You) and lane-1's stream of thinking, tool calls and text; the message box at the foot, set to To lane-1, with 📌 and Send beside it](../../../../assets/screenshots/live.webp)

1. Press **Message** in the run's header, or on the run's card under **At work now**. **Live** opens on that run, with the cursor in the message box at the foot of the page. (**Live** in the sidebar opens the first run at work; the list on its left holds the others.)
2. In the **To** list, choose who gets it:
   - **To everyone working**, the default: every lane at work, and the planner of a hill climb or goal run. The lanes at work are the contract's lanes, or fewer when a `lane_count` rule says so;
   - **To lane-1**, **To lane-2** and so on: that lane's running trial, or its next one;
   - **To the planner**: at its next plan;
   - under **Advisors**: **To all advisors**, **To the teachers**, **To the auditor** or **To the review panel**.

   A recipient that would never read it is greyed out. Hover over it to read why:
   - the planner, the auditor and the review panel of a research run;
   - the review panel of a run with no goal it reviews: `This run has no goal the review panel reviews.`;
   - any role that is switched off on the rig's **Edit rig** page, such as `The auditor is off on this rig (Edit rig).`;
   - an advisor that the rig's supervisor has not set up, such as `This rig's supervisor has no teacher pair set up, so nothing would read it.`, and **To all advisors** when it has none.

   Choosing a lane's chip above the stream, or **Planner** or **Advisors**, also chooses that recipient. A lane that starts after the page has loaded gets its own chip when its first line arrives; its **To** entry comes with the next **refresh**.
3. Write the message, up to 4,000 characters. The box's placeholder says when they will read it, such as `lane-1 (on loop-tiling) reads it at its next step`, or `lane-1 reads it when it can (this rig hasn't said which program runs its agents)`. To keep a message to everyone working or to a lane in force for every new trial, tick 📌, which shows only for those two (see [Keep a message in force](#keep-a-message-in-force)).
4. Press **Send**, or Ctrl+Enter (⌘+Enter on a Mac).

Within seconds, once the rig has taken it, the stream shows your message, such as **To lane-1:** `Look at the cache misses first.` When an agent reads it, a receipt follows: `✓ lane-1 read your message: “Look at the cache misses first.”` A lane's receipt shows first as a plain line, `read the owner's message #3: …`, and becomes the receipt once the rig's next report reaches control, within a minute; a message to one trial does the same. An advisor also answers, such as **the teacher pair (teacher-a) answered you:** and its answer. Live shows a line as your message, a receipt or an answer only when the rig's harness signed it. The filter **You**, above the stream, shows only your messages, their receipts and the answers. The judge takes no messages: it is code, and nothing anyone writes may change a measurement.

You can also write to the planner of a hill climb or goal run from its run's **Planner** tab: write in **Tell the planner** and press **Send to the planner**. The tab says `Sent to the rig. The planner reads it when it next gives out work; Commands shows whether the rig took it.` From what you say, the planner can change the run's experiment queue and add rules: see [Tell the planner](choose-what-runs-next.md#tell-the-planner).

### When each agent reads it

A receipt means the agent has the text. For a message in a new trial's brief, that is once the trial's agent is at work: its first line, or its first turn or tokens. A trial that fails before then leaves the message for the lane's next trial. Each reader reads a message once, except a message kept in force, which each new trial reads again.

| Reader | When it reads your message |
| --- | --- |
| A worker in Pi | At its next step, before its next model call |
| A worker in OpenCode or Claude Code | When its current run ends without a submission: the rig then continues the session with your message. A run ends when the model stops by itself, which can take many minutes. If the trial ends first, the lane's next trial reads it |
| A worker that has submitted, or a lane with no trial running | In the brief of the lane's next trial, once its agent is at work |
| The planner | At its next plan, once its model answers. If its model can't be reached, the message waits for the next plan |
| The teacher pair | While the run is running, in a round that starts at once, after any round already under way. For a paused run, the message waits until it runs again. If someone set the advisors a daily spending limit and it is reached, the message waits for the first round after midnight UTC, and **Live** says so once |
| The auditor, the review panel | With their next audit or review, once it is posted: if it fails, the next try reads the message again. An audit or review comes only when the judge holds a change for audit, or a goal waits for review |

[Supervision](../../explanation/supervision.md#the-owners-messages) says how the advisors read and answer your messages.

### Keep a message in force

A message kept in force goes into the brief of every new trial until you remove it: every lane's new trials, for a message to everyone working, or one lane's, for a message to that lane. Only those two can be kept, so 📌 shows only for them.

- In the stream, a kept message shows `📌 kept in force`, and each trial that reads it shows `✓ lane-1 read your message (in force): …`.
- **📌 2 kept**, above the stream, lists your kept messages: `Every new trial gets these, until you remove them.` To end one, press **Remove** beside it. Once the rig has done it, the stream says `the owner's message #3 is no longer in force`.

### Write to one trial

Live writes to a lane, not to one trial. To write to one trial, send `message_agent` with `"to": "trial:<id>"` from the [command line](#steer-from-the-command-line), the REST API or MCP. Live shows the start of a trial's id beside its lines, such as `t-4f1c9a2e`. The whole id is in the run's `at_work` from the MCP tool `run_queue`. If the trial ends before it reads the message, the lane's next trial reads it, and is told so.

The rig's own live view, **Live** on the rig's page, has no message box: it says `To message an agent, open its run's Live:` and links each run.

### If a message doesn't arrive

The rig refuses a message that nothing would read, and says why. Press **refresh** in **Live**: above the message box, a strip reads **Not sent.** `The rig refused your last message:` and the reason. It stays until you send that run a newer message. A refused message to the planner shows on the **Planner** tab too, above **Tell the planner**. When control itself refuses the message, before signing it, the strip shows at once, with control's reason. **Commands** in the sidebar also has the rig's refusal: the newest **message agent** row is **failed**, with the reason under **Outcome**. The reasons include:

- `run sort-speed-1 has 2 lanes`: the lane is not one of the run's;
- `run sort-speed-1 is closed: nothing will read this message`;
- `run sort-speed-try-1 has no agents (the judge alone tries the kit): nothing would read this message`: a [try](../../reference/glossary.md) has no lanes or planner, so it refuses messages to everyone working, a lane, the planner or one trial. Write to its advisors, or start a run with agents;
- `the planner is off on this rig (Edit rig), so nothing would read this message`, and the same for the teacher pair, the auditor and the review panel;
- `this run has no goal the review panel reviews, so the panel would never read this message`.

From the command line, the REST API or MCP, the rig still takes a message to an advisor that is switched on but has no model. Nothing reads it until the advisor has one. See [Configure advisors](../operate/advisors.md).

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
| `reset_workers` (**Restart the lanes**) | `{"run":"sort-speed-1"}` |
| `redirect` | `{"run":"sort-speed-1","directives":[{"kind":"avoid","family":"loop-tiling","rationale":"three trials regressed"}]}` |
| `redirect`, in your own words, added to the rules in force | `{"run":"sort-speed-1","directives":[{"kind":"try","match":"anything with vector loads","rationale":"twice the bandwidth"}],"replace":false}` |
| `drop_directive` (**Remove** on a rule) | `{"run":"sort-speed-1","id":7}` |
| `message_agent` | `{"run":"sort-speed-1","to":"lane-2","text":"Look at the cache misses first."}` |
| `message_agent`, kept in force | `{"run":"sort-speed-1","to":"all","text":"Keep the public API unchanged.","keep":true}` |
| `unkeep_message` | `{"run":"sort-speed-1","message":3}` |

The changes to the experiment queue, `queue_add`, `queue_move`, `queue_edit`, `queue_drop` and `queue_accept`, are in [Choose what a run tries next](choose-what-runs-next.md#from-the-command-line-and-over-mcp).

A `redirect` takes up to 40 directives, each with a `kind`, a `rationale`, and, where the kind needs one, a `family` (a direction's name), `match` (your own words, up to 200 characters, for `avoid`, `try` and `mandate` only) or a `value`:

| `kind` | What it does |
| --- | --- |
| `avoid` | No lane is given that direction |
| `try` | The planner should try it |
| `mandate` | Every plan gives that direction a lane (**Always** on the dashboard) |
| `priority` | Ranks a direction for the planner |
| `lane_count` | `value`: how many lanes to plan, up to the contract's `lanes.count` |
| `note` | Free text for the planner |

- A set replaces the rules you sent earlier from the command line or the REST API, unless it has `"replace": false`. Rules added on the dashboard or over MCP stay: remove them with `drop_directive`.
- A set that both avoids a direction and asks for it, by name or in the same words, is refused: `the set both avoids and asks for <direction>`.
- A directive with both `family` and `match` is refused: `bad redirect payload: directives.0.match: name either a family or match words, not both`. So is `match` on another kind: `… match words are for avoid, try and mandate rules`.
- Rules in your own words apply only to the planner's model's hand-outs: see [Which rules always apply](choose-what-runs-next.md#which-rules-always-apply).
- Only the planner sees rationales, notes and match words; workers never do.
- Your directives come before any that the rig's advisors or the planner set on the same `family`.
- `drop_directive` removes one rule in force, whoever set it. Its `id` is the rule's number, from `run_queue`'s `rules`. A rule that is not in force is refused: `no rule 7 in force in run sort-speed-1`.

A `message_agent`'s `to` is `all` (everyone working), `planner`, `advisors` (all of them), `teachers`, `auditor`, `panel`, `lane-1` to `lane-16`, or `trial:` and a trial's id. The text may be up to 4000 characters. `"keep": true` works only with `all` or a lane; with another `to`, control refuses it: `bad message_agent payload: keep: only a message to everyone working (all) or to a lane can be kept in force`.

The rig numbers each message, and `unkeep_message` takes that number as `message`. Find it in the rig's answer to the `message_agent` command, such as `{"status":"applied","accepted":true,"result":{"message":3,…}}`: in the **Outcome** column on **Commands**, or in `outcome` from `GET /v1/commands/<id>`.

Over MCP, an agent sends the same kinds and payloads with the `issue_command` tool, then follows them with `command_status`; which kinds each token may send is in [Who may do what](#who-may-do-what). The tool `run_queue` reads a run's experiment queue, its rules, the planner's hand-outs, and your messages with who read each one and the advisors' answers. See [Let an agent run Thermite over MCP](../automate/agent-over-mcp.md).

## Who may do what

| | Pause, resume, restart the lanes, add rules | Message the agents, remove a kept message | Change the experiment queue, remove a rule |
| --- | --- | --- | --- |
| The owner: dashboard, REST API, command line, MCP | yes | yes | yes |
| The operator's token over MCP | yes | yes | yes |
| The agent's token over MCP | yes | no | no |
| The reader's token | no | no | no |

Approving and rejecting changes is the owner's alone: see [Decide what waits for you](decide-what-waits.md). [Tokens and roles](../../reference/tokens.md#people-and-agents) has every role.
