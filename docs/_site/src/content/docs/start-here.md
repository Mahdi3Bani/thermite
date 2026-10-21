---
title: "Start here"
description: "Pick the path that fits you: try Thermite on one computer, run it on your GPUs, give it your own project, or let an agent run it."
type: hub
sidebar:
  order: 1
---

Thermite lets AI agents work on a project for as long as it takes, while a judge they cannot touch decides which of their changes really count. This page helps you find where to begin.

## What you need

- A computer running Linux or macOS, with a few CPU cores, a few gigabytes of free memory, and several gigabytes of free disk. Thermite's three images take about 2 GB.
- Docker or Podman, which run Thermite's containers. You download Thermite's images ready-made, and build nothing.
- For the command line, from the second tutorial on: Node.js 22.19 or later, and git.
- About twenty minutes for the first run.

A GPU is optional, and so is a paid AI model: you can start with a free one.

Before you give Thermite a model, read [Known limits](reference/known-limits.md). Agents run the code that a model writes on your computer, and under compose that code can reach your local network. [The security model](explanation/security-model.md) says what each part of Thermite can reach and what it trusts.

## Pick your path

### Try it on one computer

You want to see what Thermite does before you commit to anything. The four tutorials build on each other, in this order:

1. [Your first run](tutorials/first-run.md): start Thermite and watch its judge check a rig. Needs only the computer above.
2. [Hand the work to agents](tutorials/agents-with-a-free-model.md): connect a free model, start a campaign on the sample project in Thermite's repository, and watch agents propose changes. Needs tutorial 1 and an internet connection; no account or key.
3. [Your first goal campaign](tutorials/first-goal-campaign.md): set a goal, submit a change yourself, and watch the campaign end when the goal is met. Needs tutorial 1; no model.
4. [Your own project](tutorials/your-own-project.md): a campaign on a small project of yours, started from the **New campaign** page. Needs tutorials 1 and 2, and a public repository that your computer can push to and Thermite can fetch over `https`.

[What Thermite is](explanation/what-thermite-is.md) gives the ideas behind it, in one minute.

### Run it on your GPUs

You have machines with GPUs and want Thermite to use them.

1. [Install Thermite on one machine](how-to/install/one-machine.md), so it keeps running.
2. [Let rigs on other machines reach control](how-to/install/one-machine.md#let-rigs-on-other-machines-reach-control). This needs an HTTPS address for control, behind a reverse proxy you provide, and Thermite's images in a registry that the rigs can pull from without a login. A release's published images are such images, and its compose file gives them to control.
3. [Add a rig on a machine over SSH](how-to/install/rig-on-a-machine.md) or [on a Kubernetes cluster](how-to/install/rig-on-a-cluster.md), or [run one on a RunPod GPU](how-to/install/runpod-rig.md), paid by the hour.
4. [Give a rig several GPUs](how-to/install/several-gpus.md), and read [Sharing a device](explanation/sharing-a-device.md) to choose how.

:::note
Rigs that control sets up on machines and clusters, and rigs you join yourself, have no [results repository](how-to/operate/results-repository.md) yet. Their exports go to control instead ([Get a rig's results from control](how-to/operate/exports-on-control.md)), but they can't send each other champions. The rigs of the local compose stack have one. See [goal 061](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/061-gaps-found-by-the-docs.goal).
:::

### Give it your own project

You have a project with a number you want to improve, or goals you want met.

1. First do tutorials 1 and 2 under [Try it on one computer](#try-it-on-one-computer). Then [Your own project](tutorials/your-own-project.md): a first campaign from the **New campaign** page.
2. [Write a kit for your project](how-to/campaigns/write-a-kit.md): how Thermite builds, runs and checks it.
3. [Write a contract](how-to/campaigns/write-a-contract.md): what the campaign must achieve.
4. [Why agents never judge](explanation/why-agents-never-judge.md): what makes a result count.

### Let an agent run Thermite

You want your own AI assistant to watch and steer campaigns for you.

1. [Let an agent run Thermite over MCP](how-to/automate/agent-over-mcp.md).
2. [Tokens and roles](reference/tokens.md): what an agent may and may not do. Only you approve what matters.
3. Point your agent at [`llms.txt`](https://usethermite.com/llms.txt), which lists every page of this site.

## Words you will meet

| Word | Meaning |
| --- | --- |
| **Rig** | Where the research happens: two containers on a machine, with the device the work is measured on. |
| **Harness** | The rig's container where the judge and the agents work. |
| **Supervisor** | The rig's other container: its link to control, which also does all its git work. |
| **Control** | The one service that shows and steers every rig: a dashboard, a REST API and MCP. |
| **Owner's token** | The secret you sign in to the dashboard with. Only the owner approves what matters. |
| **Campaign** | One piece of research: what to improve or achieve, and how to judge it. |
| **Contract** | The file that sets out a campaign: what to improve or which goals to meet, which files agents may change, and its limits. |
| **Run** | A campaign running on one rig. |
| **Kit** | The judge's recipe for a project: how to build it, run it, time it and check it. Agents never see it. |
| **Lane** | One line of search inside a run. Each lane's agent works one **trial** after another. |
| **Attempt** | One change an agent submits. |
| **Judge** | The code that measures each change and gives it a **verdict**. Agents cannot change it. |
| **Champion** | The best confirmed result of a run so far. The starting point is champion #1. |

The [glossary](reference/glossary.md) has every term.
