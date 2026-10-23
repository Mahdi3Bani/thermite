---
title: "Roadmap"
description: "What Thermite does next, by version, and where the plans live."
type: project
sidebar:
  order: 1
---

Thermite's plans are public. This page sums them up; the plan files in the repository hold every detail.

## Now: v0.1.0, the first public release

Thermite has not had a release yet. The work now is toward **v0.1.0**, its first public release. With it, a tester can:

- install Thermite from published images;
- run agents on a sample project, with a free model or their own key;
- add rigs on their own machines over SSH and on their Kubernetes clusters;
- launch GPU rigs on RunPod.

Thermite's core is built: the judge, control and its dashboard, the agents, and the advisors that supervise them. This site describes what is built today, including these goals of this release:

- a research folder for each research run, which its workers search with ordinary tools and add to, and which a finished campaign exports with its report. It is done ([goal 062](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/062-research-folder.goal); [Research](../explanation/campaign-modes.md#research));
- the dashboard's new campaign, run and live views, with steering as one message box. It is done ([goal 063](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/063-scan-and-steer.goal));
- dashboard buttons that say at once that a click took, and show its outcome without a refresh, such as a rig check that goes from sent to running to its result. It is done ([goal 080](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/080-buttons-show-progress.goal); [On the dashboard](../reference/signed-commands.md#on-the-dashboard));
- one experiment queue for each run, which the planner coordinates. It is done ([goal 064](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/064-experiment-queue.goal));
- journals and a research corpus from every campaign: the agents' field notes, research in every mode, and Thermite's own knowledge base, with a folder for each campaign that holds everything its runs produce and that later runs' workers, planner and advisors search. It is done ([goal 065](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/065-journals-and-corpus.goal));
- rules for the planner that name the run's directions, in plain words or picked as `:name:` on the run's **Planner** tab. It is done ([goal 066](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/066-direction-rules.goal); [Make a rule: tell the planner](../how-to/campaigns/choose-what-runs-next.md#make-a-rule-tell-the-planner));
- MCP servers for a campaign's agents, named by its kit. It is done ([goal 068](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/068-mcp-servers-for-agents.goal); [Give agents MCP tools](../how-to/campaigns/give-agents-mcp-tools.md));
- copying a campaign under a new name, with its own empty folder in the knowledge base, to give a second model the same campaign from zero: **Copy** on the campaign's page, and its twins over REST, MCP and the command line. It is done ([goal 069](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/069-copy-a-campaign.goal); [Compare two models from zero](../how-to/campaigns/start-from-dashboard.md#compare-two-models-from-zero));
- a claim's source named by the address its page was archived from or its file name in the research folder, as well as by its id, still checked word for word, and each draft's reasons in the run's **History**. It is done ([goal 076](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/076-claim-sources-and-reasons.goal); [Research](../explanation/campaign-modes.md#research));
- archiving a campaign, which keeps its folder, and folders for campaigns in the dashboard's left navigation, which no longer lists the rigs. It is done ([goal 077](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/077-archive-and-folders.goal); [Archive campaigns and sort them into folders](../how-to/campaigns/archive-and-folders.md));
- the judge's findings in view: a held-out failure named by its case and kind for the owner and by its kind alone for the agents, a refused change's violations wherever the change is looked at, a time limit for each kit cell, and each goal's real check on the campaign's and the run's pages. It is done ([goal 082](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/082-judge-findings-in-view.goal); [Held-out failures](../reference/verdicts.md#held-out-failures));
- a cap on the context window of each agent's model, and compaction near it: an agent's conversation is kept, summarized and goes on, in every harness, the advisors' included. A campaign can set its own window and compaction point for its runs. The rig's are set on **Edit rig** and over REST and MCP; a campaign's on **New campaign**, **Copy** and its page, and over REST, MCP and the command line. It is done ([goal 070](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/070-model-context-cap.goal); [Set an agent's context window and compaction](../how-to/models/model-per-agent.md#set-an-agents-context-window-and-compaction));
- a harness of the owner's choice for every kind of agent, not only the workers: Pi, OpenCode v2, Claude Code or the Codex CLI for the planner and each advisor too, in **Runs in** on **Edit rig**. It is done ([goal 073](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/073-harness-for-each-agent.goal); [Where each agent runs](../how-to/models/model-per-agent.md#where-each-agent-runs));
- one name for each agent, the same on every screen, page, field and tool, in two groups: the work (the workers and the planner) and the advisors (the teachers, one or two, with a merged by model for two, the auditor and the review panel). It is done ([goal 074](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/074-one-name-for-each-agent.goal); [Give each agent its own model](../how-to/models/model-per-agent.md));
- model use and cost: every model call the agents make is counted by code, and summed for a run, a campaign and the whole system, on a run's page, a campaign's page and **Metrics**, and over REST and MCP. The cost uses **Model prices** in **Settings › Providers**. It is done ([goal 075](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/075-model-usage.goal); [Model use and cost](../reference/model-use.md));
- less overhead and fewer stops: a provider's error is sorted by its kind, so a rate limit waits and a refused key or no credits stops the run's agents and asks you; no hidden default caps; a rig can finish its running trials before an image update; a restart keeps a trial's counters and the lanes' caches; and a win is promoted once the auditor clears it, unless you ask to decide first. It is done ([goal 079](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/079-thermite-overhead.goal); [Promotions](../how-to/campaigns/decide-what-waits.md#promotions));
- a campaign's brief for every mode, on its own step of **New campaign**: additional information in Markdown, starting links, ideas to try and hypotheses, which the planner, the workers and the advisors get. It is done ([goal 078](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/078-campaign-brief.goal); [The brief](../how-to/campaigns/start-from-dashboard.md#2-the-brief));
- a queue that stays full of ideas: the teachers' main product is a portfolio of new opportunities, written to the queue, and they read the champion's code, the attempts' diffs and the judge's reasons; a campaign keeps a target of experiments ready, **Ideas kept ready**, and a queue below it asks the planner and then the teachers for more; lanes propose their follow-ups. It is done ([goal 081](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/081-ideas-first.goal); [Supervision](../explanation/supervision.md#the-teachers));
- a goal report that keeps what it measured: a goal checked by the kit's verifier gives each measured case's values, met or not, as a threshold goal does, on the run's **Goals** block and to the agents, never a held-out case's; and no new trial while the judge checks a second time a champion that met every required goal, a check that also runs the held-out cases of the goals met. It is done ([goal 086](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/086-goal-report-values-and-confirmation-wait.goal); [The goal report](../reference/verdicts.md#the-goal-report));
- closing a run by hand: **Close run** on a run's page, and `close_run` with the owner's token, end a run you no longer want for good, with your reason, as a run that met its goals ends. It is done ([goal 087](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/087-close-a-run.goal); [Close a run](../how-to/campaigns/steer-a-run.md#close-a-run));
- a kit written elsewhere, given to control as a git bundle of its repository: control keeps it with its commits, and rigs fetch it from control by commit. It is built; its compose checks are next ([goal 096](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/096-kits-from-elsewhere.goal); [Give control a kit you wrote elsewhere](../how-to/campaigns/write-a-kit.md#give-control-a-kit-you-wrote-elsewhere)).
- exports from the dashboard: **Export** on a rig's or a run's page, of what changed or a full one that holds every run's research folder, finished or not, and an **Exports** page that downloads each export as one archive. It is built; its check on a deployment is next ([goal 103](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/103-export-and-download.goal); [Get a rig's results from control](../how-to/operate/exports-on-control.md)).

Also built:

- a release workflow and bundle, and `thermite doctor`;
- version checks between control and rigs, with each rig's version and reporting state on the dashboard;
- a sample project;
- the Codex CLI as a worker harness for a ChatGPT subscription ([Run the agents in Codex](../how-to/models/chatgpt-subscription.md#run-the-agents-in-codex));
- Start a run over REST, MCP and the command line, as well as from the campaign's page;
- rigs on RunPod ([Run a rig on RunPod](../how-to/install/runpod-rig.md)). The owner launches them from the dashboard or over REST, MCP and the command line, and stops, starts and terminates them. A RunPod rig can stop by itself when no run is at work on it. It works on the pod's own disk and keeps a snapshot of its state on the pod's volume, so a stop and a start keep its work. Its page shows the pod's log, before the rig enrolls too ([A pod that runs but never enrolls](../how-to/install/runpod-rig.md#a-pod-that-runs-but-never-enrolls-read-its-log));
- sign-in with a real Claude or ChatGPT subscription, each tested from start to end: sign in, give a rig the model, pass its model check, and run a trial whose change the judge confirmed ([goal 009](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/009-subscription-sign-in-tests.goal); [Use a Claude subscription](../how-to/models/claude-subscription.md), [Use a ChatGPT subscription](../how-to/models/chatgpt-subscription.md)).

Still to come in v0.1.0:

- the first published images, which the release's tag publishes;
- the RunPod steps run on a real pod, from launch to terminate, with the judge's check of how noisy the pod's timing is.

The [roadmap file](https://github.com/iammrduncan/thermite/blob/main/docs/plan/roadmap.md) lists every v0.1.0 goal with its status, and the [release plan](https://github.com/iammrduncan/thermite/blob/main/docs/plan/release-v0.1.0.md) gives the release's scope and the steps to ship it.

## Later versions

Later versions are proposed: their order and contents can change. Each one ships when its goals are verified, not on a date.

| Version | Focus |
| --- | --- |
| **v0.1.1** | Quick follow-ups to the first release: **New campaign**'s buttons show they were pressed; an **Info** tab with everything a campaign and a run were started with; a stuck rig in **Needs you**; the model's reasoning and words on **Live**, not only its tool calls; a **Copy** button by each ID; in **Settings › Providers**, all that Thermite spent on a GPU cloud, not only its test pods; a kit bundle given to control from the dashboard; GPUs rented only while they work, for the judge and for the workers' checks; and a secondary judge that asks an outside service, such as a contest's own judge, on a schedule and only when the champion gained. |
| **v0.2.0** | Run Thermite without the dashboard: every dashboard action has an API and MCP twin, all logs are in one place you can search, and you sign in with your identity provider. Also planned: a deep-research teacher that runs when the queue needs ideas, research tasks with web search inside goal and hill-climb runs, a run that starts from a champion on another rig, faster dashboard pages, a **Knowledge** page to explore the knowledge base, with copies of it in outside stores, and kits that define how a campaign runs, with their own images, on rigs that are only the slots it runs in. |
| **v0.3.0** | Rigs you can trust: checks before a rig is deployed, setup and removal that are safe to repeat, upgrades from control, GPU rigs under compose, and a cloud rig that can move to another GPU, keeping its state. |
| **v0.4.0** | Kits and evidence: kits are easier to write and to test before agents start, and each result shows clearer evidence. |
| **v0.5.0** | Unattended for days: campaigns in all three modes run for days with no one watching, and research mode can search the web. |
| **Later** | Ideas with no version yet, such as more kinds of target and planning across rigs. |

After v0.1.0, version numbers count up by the middle number: 0.2.0, 0.3.0 and so on. Fixes and quick follow-ups ship as 0.1.1, 0.1.2. A 0.x version makes no promise about upgrades.

## The plan files

| File | What it holds |
| --- | --- |
| [Roadmap](https://github.com/iammrduncan/thermite/blob/main/docs/plan/roadmap.md) | Every goal, by version, in priority order, one line each |
| [Release plan for v0.1.0](https://github.com/iammrduncan/thermite/blob/main/docs/plan/release-v0.1.0.md) | The next release: its scope, its goals and the steps to ship it |
| [Settled decisions](https://github.com/iammrduncan/thermite/blob/main/docs/plan/decisions.md) | Decisions that shape the whole product, with their dates |
| [How Thermite is planned](https://github.com/iammrduncan/thermite/blob/main/docs/plan/README.md) | What a goal is, what each status means, and how an idea becomes a goal |

Each roadmap item is a **goal**: one file that says what it delivers, why, when it is done, and how it is going. Pages on this site link to a goal when they mention something that is not built yet.

To suggest an idea or ask about the plans, see [Getting help](getting-help.md).
