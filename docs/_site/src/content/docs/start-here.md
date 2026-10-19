---
title: "Start here"
description: "Pick the path that fits you: try Thermite on one computer, run it on your GPUs, give it your own project, or let an agent run it."
type: hub
sidebar:
  order: 1
---

Thermite lets AI agents work on a project for as long as it takes, while a judge they cannot touch decides which of their changes really count. This page helps you find where to begin.

## What you need

- A computer running Linux or macOS, with a few CPU cores and a few gigabytes of free memory.
- Docker or Podman, which run Thermite's containers.
- Node.js 22.19 or later, and git.

A GPU is optional, and so is a paid AI model: you can start with a free one.

## Pick your path

### Try it on one computer

You want to see what Thermite does before you commit to anything.

1. [Your first run](tutorials/first-run.md): start Thermite and watch its judge check a rig.
2. [Hand the work to agents](tutorials/agents-with-a-free-model.md): connect a free model and watch agents propose changes.
3. [What Thermite is](explanation/what-thermite-is.md): the ideas behind it, in one minute.

### Run it on your GPUs

You have machines with GPUs and want Thermite to use them.

1. [Install Thermite on one machine](how-to/install/one-machine.md), so it keeps running.
2. [Add a rig on a machine over SSH](how-to/install/rig-on-a-machine.md) or [on a Kubernetes cluster](how-to/install/rig-on-a-cluster.md).
3. [Give a rig several GPUs](how-to/install/several-gpus.md), and read [Sharing a device](explanation/sharing-a-device.md) to choose how.

### Give it your own project

You have a project with a number you want to improve, or goals you want met.

1. [Your own project](tutorials/your-own-project.md): a first campaign from the New campaign page.
2. [Write a kit for your project](how-to/campaigns/write-a-kit.md): how Thermite builds, runs and checks it.
3. [Write a contract](how-to/campaigns/write-a-contract.md): what the campaign must achieve.
4. [Why agents never judge](explanation/why-agents-never-judge.md): what makes a result count.

### Let an agent run Thermite

You want your own AI assistant to watch and steer campaigns for you.

1. [Let an agent run Thermite over MCP](how-to/automate/agent-over-mcp.md).
2. [Tokens and roles](reference/tokens.md): what an agent may and may not do. Only you approve what matters.
3. Point your agent at [`llms.txt`](https://iammrduncan.github.io/thermite/llms.txt), which lists every page of this site.

## Words you will meet

| Word | Meaning |
| --- | --- |
| **Rig** | Where the research happens: two containers on a machine, with the device the work is measured on. |
| **Control** | The one service that shows and steers every rig: a dashboard, a REST API and MCP. |
| **Campaign** | One piece of research: what to improve or achieve, and how to judge it. |
| **Run** | A campaign running on one rig. |
| **Kit** | The judge's recipe for a project: how to build it, run it, time it and check it. Agents never see it. |
| **Judge** | The code that measures each change and gives it a **verdict**. Agents cannot change it. |
| **Champion** | The best confirmed result of a run so far. |

The [glossary](reference/glossary.md) has every term.
