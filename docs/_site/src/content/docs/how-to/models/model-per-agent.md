---
title: "Give each agent its own model"
description: "Choose a different model and effort for the workers, the planner and each advisor."
type: how-to
sidebar:
  order: 5
---

A rig runs several kinds of agent, and they need different things. The workers make many calls, so a cheap or local model may suit them. The planner and the advisors make a few calls each, where a stronger model can pay off. On a rig's **Edit rig** page you give each of them its own model, and an effort: how long the model thinks before it answers.

The planner coordinates each run's experiment queue, the run's ordered list of things to try. At the start of each round it gives each [lane](../../reference/glossary.md) (one line of search in the run) an experiment from the queue, and it may add, move or drop experiments. See [Choose what a run tries next](../campaigns/choose-what-runs-next.md).

## Before you start

- At least one provider is added on **Settings › Providers**, with models listed. See [Connect a model provider](connect-a-provider.md).
- If a model uses a paid key, give each campaign a stop time and set a spending limit at the provider first. Nothing stops research by default, and Thermite's money limits don't count the planner, or any advisor given its model on this page. See [Spending](#spending).

## Set the models

1. Open **Rigs**, choose the rig, and press **Edit rig**.
2. Go to section **2 · The agents**. It is a table with the columns **Agent**, **Model**, **Effort** and **Runs in**, and one row for each agent:

   | Agent | Its ⓘ says | With no model chosen |
   | --- | --- | --- |
   | **Workers** | "The agents that change the code, one per lane. They run for many turns, so they use the most of a subscription." | **its own settings**: the rig's `THERMITE_MODEL_*` settings. Without those, the agents have no model and wait |
   | **Planner** | "Gives each worker its direction at the start of each round. A few calls per round." | **same as the workers** |
   | **Teacher pair** | "Two advisors that read the recent work every hour and suggest directions, each with a source. Both use this model." | **the rig's advisors file** |
   | **Combiner** | "Joins the two teachers' advice into one set of directions." | **the rig's advisors file** |
   | **Auditor** | "Looks for a hidden flaw in a change before it can become the champion." | **the rig's advisors file** |
   | **Review panel** | "Three reviewers that grade goals that need judgement. The judge's numbers never come from them. All three use this model." Set here, the panel is three reviewers on one model; the advisors file can set two to five. | **the rig's advisors file** |

3. For each agent you want to change, choose a model in its **Model** list, and an **Effort** (see below).
4. For the workers, also choose where they run, in the **Runs in** column: **Pi**, **OpenCode v2** or **Claude Code**. When you choose a Claude subscription's model, the page sets **Claude Code** for you.

   For the other agents, **Runs in** shows where each one will run, for example "the supervisor, read-only tools" or "Claude Code, no tools".

5. Read the list under **What changes when you save**, at the foot of the page. It says each change in a sentence, such as "You change the auditor's model to my-model."
6. Press **Save changes**.

You return to the rig's page, which says, for example, "Control sent a new model and a model for the auditor to rig-1. The rig takes the change in less than one minute."

The workers and the planner take a new model within a minute. The advisors read their models from control each time they run, so an advisor uses its new model from its next round.

When the workers' or the planner's model changes, the rig runs its model check at once. The check tests only the workers' model. For the other agents, watch a run on the rig in **Live** (in the sidebar), the dashboard's view of one run's agents at work. Choose a filter above the stream:

- **Planner**: the planner's lines. Each round's line says whether the model planned it ("planned by the model") or the lanes took their experiments without it ("taken from the queue by the fixed rules"), and a "refused:" line says why a model's plan was refused. A research run plans its rounds with a fixed method and no planner model, so it has no such filter.
- **Advisors**: the advisors' lines. Each error is a line of its own with its text, and an "advisor round done" line counts what a round did, errors included.

A run's **Planner** tab also shows the planner's model, in the card **The planner**: for example "my-model, its own model (from my-litellm)", or "my-model, the agents' model (Edit rig can give the planner its own)". Under **What the planner did**, it shows each hand-out: which experiment went to which lane, and why. See [Check the planner's model](../campaigns/choose-what-runs-next.md#check-the-planners-model).

## An agent with no model

- **Workers** with no model use the rig's own settings. See [Use the rig's own settings instead](connect-a-provider.md#use-the-rigs-own-settings-instead).
- **The planner** with no model of its own uses the workers' model. Its **Runs in** cell says where it then runs. When the **Planner** switch in section **1 · Parts of the rig** is off, or the model gives no valid plan in two tries, the lanes take queued experiments in order, by fixed rules. That order skips the directions an **Avoid** rule names and puts **Always** and **Try** directions first, but it ignores rules written in your own words: only the planner's model applies those.
- **An advisor** with no model uses the role from the rig's advisors file. If the file has none, or the rig has no file, that advisor does not run. See [Configure advisors](../operate/advisors.md).

An advisor also runs only while its switch is on in section **1 · Parts of the rig**: **Auditor**, **Teacher pair** or **Review panel**. The combiner follows the **Teacher pair** switch. The switches are on by default, but a switch that is on runs nothing until its advisor also has a model, here or in the advisors file. Why each advisor exists is in [Supervision](../../explanation/supervision.md).

The switches also decide who can get your messages. In **Live**'s message box, the **To** list greys out the planner and each advisor whose switch is off, and says why; the rig refuses a message to them. Once the rig's supervisor has reported, the list also greys out an advisor it hasn't set up, such as one whose switch is on but which has no model: "This rig's supervisor has no auditor set up, so nothing would read it." Over MCP, the REST API or the command line, the rig still takes a message to such an advisor, and nothing reads it until the advisor has a model. See [Send the agents a message](../campaigns/steer-a-run.md#send-the-agents-a-message).

## Where each agent runs

| Model from | Workers | Planner, with a model of its own | Advisors |
| --- | --- | --- | --- |
| An API key (OpenAI-compatible, Anthropic) or a ChatGPT subscription | Pi or OpenCode v2, as you choose | Pi | The supervisor, with read-only tools |
| OpenCode's own provider | OpenCode v2 only | OpenCode | Not allowed |
| A Claude subscription | Claude Code | Claude Code, with no tools | Claude Code, with no tools |

A Claude subscription needs Claude Code in the images: in the harness image for the workers and the planner, and in the supervisor image for the advisors. See [Use a Claude subscription](claude-subscription.md).

Where the workers run also sets when they read a message you send them from **Live**. A worker in Pi reads it at its next step. OpenCode v2 and Claude Code take no message while they work: when the program stops before the worker has submitted a change and the trial has time left, the rig starts it again with your message; otherwise the lane's next trial reads it. The planner reads its messages when it plans the next round. See [When each agent reads it](../campaigns/steer-a-run.md#when-each-agent-reads-it).

The advisors' read-only tools are the campaign's brief, plus a guarded web fetch and a knowledge base only where the rig's advisors file sets them up. A knowledge base is a search service of your own, reached over MCP, that the teachers may search but not change: see the `kb` field in the [advisors file reference](../../reference/advisors-file.md#top-level).

## Effort

**Effort** sets how long the model thinks before it answers. Its ⓘ says: "More effort: better answers, slower, and more of a subscription's window. Providers other than a Claude subscription take up to high."

The list offers **default**, **low**, **medium**, **high**, **xhigh** and **max**. What reaches the model depends on the provider:

| Provider | default | low, medium, high | xhigh, max |
| --- | --- | --- | --- |
| Claude subscription | Claude Code's own default | Passed to Claude Code as its effort | Passed to Claude Code as its effort |
| Every other provider | Nothing is sent: the model's own default | Sent as the model's reasoning effort | Sent as **high** |

Two cases take no effort from this page:

- Agents that run in **OpenCode v2**: Thermite does not pass the effort to OpenCode.
- Workers on **its own settings**: they use the rig's `THERMITE_MODEL_REASONING_EFFORT` setting instead.

## Share a subscription

When any agent uses a subscription, a note under the table counts the sessions: "One subscription, many agents: on this rig, of the agent sessions that run at once, up to N can use a Claude subscription…". Each worker is one session, the teacher pair two and the review panel three. The same plan may serve other rigs too. When the plan is full, these agents wait; nothing pays for more.

## Spending

Thermite has two money limits, and neither covers every agent on this page:

| Agent | What counts its spend |
| --- | --- |
| Workers | The contract's `budget.llm_usd`, but only on a rig that has token prices (`THERMITE_LLM_USD_PER_MTOK_IN` and `THERMITE_LLM_USD_PER_MTOK_OUT`). The local stack can set them; rigs that control sets up on machines and clusters, or by a join command, can't have them yet |
| Planner | Nothing |
| An advisor given its model on this page | Nothing: it counts as $0 |
| An advisor in the advisors file | The file's `max_usd_per_day`, but only for `openai` runtimes with prices. Rigs that control sets up have no advisors file yet |

For the rest, give each campaign a stop time (**Stop after (hours)** on the **New campaign** page, or `budget.wall_hours`), set a spending limit at the provider if it has one, and watch the provider's own usage page. **Pause**, at the top of a run's page or in **Live**, then **Pause the run**, stops a run's workers and planner at once ([Steer a run](../campaigns/steer-a-run.md)). See [Set a budget or a stop time](../campaigns/budget-and-stop-time.md), [Configure advisors](../operate/advisors.md#spending), and the gaps listed in [goal 061](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/061-gaps-found-by-the-docs.goal).

## If something goes wrong

A refused change shows on the rig's page, in a card that starts with **Not done.** Saving stops at the agent it refused: agents above it in the table may already have their new model, and nothing below it is saved, nor anything else on the page. Open **Edit rig** again to see what the rig has now.

| You see | What to do |
| --- | --- |
| "That provider does not list that model." (or with a role in brackets) | Refresh the provider's models on **Providers**, or add the model by name there. |
| "Claude Code runs only with a Claude subscription here: choose Pi or OpenCode v2 for this provider." | Set the workers' **Runs in** to **Pi** or **OpenCode v2**. |
| "OpenCode's free models run only in the OpenCode harness: choose OpenCode v2 for this rig." | Set the workers' **Runs in** to **OpenCode v2**. |
| "The auditor cannot use OpenCode's own models: they run only in OpenCode. Choose another model." (or another role) | Choose a model from another provider for that advisor. |
| "This rig's harness is older: it does not report its settings and cannot take them." | The rig's images are older than control. The workers' model still works. On the local stack, build the images again ([Stop, start and update](../install/one-machine.md#stop-start-and-update)). A rig that control set up on a cluster moves onto newer images from its page: see [Move a rig onto new images](../operate/rig-lifecycle.md#a-rig-on-a-cluster). A rig on a machine, or one you joined, can't move yet ([goal 035](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/035-rig-upgrades.goal)): add a new rig from newer images ([Push the images to your own registry](../install/own-registry.md)). |
