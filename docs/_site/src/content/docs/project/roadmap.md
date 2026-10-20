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

- the dashboard's new campaign, run and live views, with steering as one message box. It is done ([goal 063](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/063-scan-and-steer.goal));
- one experiment queue for each run, which the planner coordinates. It is done ([goal 064](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/064-experiment-queue.goal));
- journals and a research corpus from every campaign: the agents' field notes, research in every mode, and Thermite's own knowledge base, with a folder for each campaign that holds everything its runs produce and that later runs' workers, planner and advisors search. It is done ([goal 065](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/065-journals-and-corpus.goal)).

Still to come in v0.1.0: published images, the sample project, a command that checks your machine, and rigs on RunPod. Two planned changes to running campaigns are not built yet: rules that name only directions, picked from a list ([goal 066](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/066-direction-rules.goal)); and MCP servers for a campaign's agents, named by its kit ([goal 068](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/068-mcp-servers-for-agents.goal)).

The [roadmap file](https://github.com/iammrduncan/thermite/blob/main/docs/plan/roadmap.md) lists every v0.1.0 goal with its status, and the [release plan](https://github.com/iammrduncan/thermite/blob/main/docs/plan/release-v0.1.0.md) gives the release's scope and the steps to ship it.

## Later versions

Later versions are proposed: their order and contents can change. Each one ships when its goals are verified, not on a date.

| Version | Focus |
| --- | --- |
| **v0.2.0** | Run Thermite without the dashboard: every dashboard action has an API and MCP twin, all logs are in one place you can search, and you sign in with your identity provider. |
| **v0.3.0** | Rigs you can trust: checks before a rig is deployed, setup and removal that are safe to repeat, upgrades from control, and GPU rigs under compose. |
| **v0.4.0** | Kits and evidence: kits are easier to write and to test before agents start, and each result shows clearer evidence. |
| **v0.5.0** | Unattended for days: campaigns in all three modes run for days with no one watching, and research mode can search the web. |
| **Later** | Ideas with no version yet, such as more kinds of target, planning across rigs, and a worker harness for Codex CLI. |

After v0.1.0, version numbers count up by the middle number: 0.2.0, 0.3.0 and so on. Fixes ship as 0.1.1, 0.1.2. A 0.x version makes no promise about upgrades.

## The plan files

| File | What it holds |
| --- | --- |
| [Roadmap](https://github.com/iammrduncan/thermite/blob/main/docs/plan/roadmap.md) | Every goal, by version, in priority order, one line each |
| [Release plan for v0.1.0](https://github.com/iammrduncan/thermite/blob/main/docs/plan/release-v0.1.0.md) | The next release: its scope, its goals and the steps to ship it |
| [Settled decisions](https://github.com/iammrduncan/thermite/blob/main/docs/plan/decisions.md) | Decisions that shape the whole product, with their dates |
| [How Thermite is planned](https://github.com/iammrduncan/thermite/blob/main/docs/plan/README.md) | What a goal is, what each status means, and how an idea becomes a goal |

Each roadmap item is a **goal**: one file that says what it delivers, why, when it is done, and how it is going. Pages on this site link to a goal when they mention something that is not built yet.

To suggest an idea or ask about the plans, see [Getting help](getting-help.md).
