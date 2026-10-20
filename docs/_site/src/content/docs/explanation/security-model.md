---
title: "The security model"
description: "What each part of Thermite can reach and what it trusts: control, the supervisor, the harness, the lanes and the judge, and a rig under compose, on a machine, on Kubernetes and on RunPod."
type: explanation
sidebar:
  order: 10
---

Thermite runs code that AI models write. Its security model starts from that fact: the agents' code may try anything that its operating-system user is allowed to do, so each part of Thermite gets only the reach and the trust that its job needs. This page shows, in one place, what each part can reach and what it trusts. The pages it links to give the details, and [Known limits](../reference/known-limits.md) lists what the design does not cover yet.

The words here are in the [glossary](../reference/glossary.md).

```mermaid
flowchart LR
  O((Owner)) -- "owner's token" --> C[Control]
  C -. "SSH, kubectl, RunPod's API" .-> P[Your machines, clusters, RunPod]
  S[Supervisor] -- "dials out with its rig token" --> C
  S -- "its own token" --> H
  S --> G[Git hosts, advisors' models, an outside knowledge base]
  subgraph H[Harness container]
    J["Judge and ledger<br/>(user thermite)"]
    L["Lanes<br/>(lane-N, agent-N)"]
    B["Builds and timed runs<br/>(builder, run)"]
  end
  L -- "a token for one trial" --> J
  J --> B
  H --> M[Its model endpoint, DNS, the internet]
```

## Three rules

1. **Agents propose; code judges.** Nothing that an agent writes reaches a measurement, a verdict or a promotion. The agents' code runs as users that can't read or change the judge's files ([Why agents never judge](why-agents-never-judge.md), [Isolation inside a rig](isolation.md)).
2. **Signatures decide, not the path between.** Control signs every command, and the harness signs every report. The supervisor carries both, but it can make neither ([Trust between control and rigs](trust.md)).
3. **A key goes only where it is used.** Control seals every secret you give it, and hands a rig only what that rig uses ([Who holds your keys](who-holds-your-keys.md)).

## Control

- **Runs as** a user other than root. The compose file drops every Linux capability.
- **Listens on** one port, 8800: the dashboard, the REST API, MCP and `/metrics`. Compose publishes it on `127.0.0.1` only. Rigs on other machines reach it through a reverse proxy with HTTPS that you provide ([Let rigs on other machines reach control](../how-to/install/one-machine.md#let-rigs-on-other-machines-reach-control)).
- **Reaches** model providers, to list their models; OpenAI, for a ChatGPT sign-in; git hosts, to read a project's commit and file list for the **New campaign** page; your machines over SSH and your clusters' API, to set rigs up and manage them; RunPod's API and its test pods; and outside knowledge bases. It never connects to a running rig: every rig dials out to control. With `compose.lifecycle.yaml`, which is for development only, control also gets the container engine's socket, to restart the compose rigs.
- **Trusts** a request only with a token, and only for what that token's role may do ([Tokens and roles](../reference/tokens.md)). It takes a rig's report only when the report is signed with the key that control pinned for that rig, and a champion's patch only when its hash matches the rig's signed record.
- **Holds** every key and sign-in that you add, sealed; its own signing key; and tokens as hashes, where it can.

## The supervisor

- **Runs as** a user other than root, in a container of its own, with every Linux capability dropped. No agent's, build's or candidate's code runs in it, and it listens on no port.
- **Reaches** control, by dialing out; its harness's API; git hosts, to fetch projects and kits and to push results; the advisors' model providers; public web pages, for advisors that the advisors file lets fetch them; and an outside knowledge base, when the owner lets a campaign's teachers search it.
- **Trusts** control, at the address that it was given. It doesn't need to trust anything else, because the harness checks each command, and each project, kit, model or champion that the supervisor fetched, against what control signed.
- **Holds** the rig's outside credentials: its rig token for control, its token for the harness, the results repository's deploy key, a private repository's Git access for one fetch at a time, the advisors' keys, and an outside knowledge base's token, in memory. It holds no signing key, so it can't make a command or a report, submit a change or set a verdict.

## The harness

- **Runs as** a small broker, as root, with six capabilities (`CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `KILL`, `SETGID` and `SETUID`) and no way to gain more. The broker starts everything else as a role user of its own.
- **Listens on** port 8700, the harness API, which is never published. Over the network, only its supervisor calls it; inside the container, the workers' tools call it on `127.0.0.1`. Every route but a health check needs a token.
- **Reaches** DNS, the internet and its model endpoint. Where the rig runs decides what else it can reach ([below](#where-a-rig-runs)).
- **Trusts** a command only when control signed it, for this rig, before it expired, from an issuer allowed for its kind. It takes a project, kit, model or champion only when it matches the commit or hash in that command. What the supervisor hands over, such as the advisors' experiments and past research, reaches the agents as data, never as a verdict.
- **Holds** the rig's report signing key, the ledger and the agents' model route, where no lane, build or timed run can read them.

## The lanes

A lane is one line of search, worked by one agent session after another ([Agents, lanes and the planner](agents-lanes-planner.md)).

- **Run as** a user of their own, `lane-1` to `lane-16`. In Pi, the built-in worker harness, the worker agent runs as `agent-N`. Each trial works in a fresh copy of the project that the lane owns.
- **Reach** the harness API with a token for one trial, which stops working when the trial ends; the run's research folder, where they read what the harness wrote and, in a research run, write only their own working area; and the harness container's network. A worker's research fetches go through the harness, which refuses private and local addresses. The commands that a lane runs use the container's network directly.
- **Are trusted with** nothing that decides. A lane proposes a change, and the judge measures it. A lane can't read the ledger, the kits or the secret files, list or change the stored builds, or open another lane's workspace or a GPU that it wasn't given. The isolation self-test checks this every time the harness starts.
- **Hold** what their worker harness needs. In Pi, the model key is in the environment of the agent's process (`agent-N`), which the lane's commands can't read. OpenCode never gets the key: it calls the model through the harness's proxy with the trial's token. Claude Code runs as the lane's own user, with the subscription token in its environment. The commands that it starts get no credentials in theirs, but they run as the same user, so they can read that token.

## The judge

- **Runs** inside the harness's controller, as `thermite`. It builds each change as `builder` and times it as `run`, with a timing user of its own for each further judge GPU, each under limits on time, memory, disk and processes ([Per-process and per-trial limits](../reference/limits-and-pacing.md#per-process-and-per-trial-limits)).
- **Reaches** the network through the harness container, as the lanes do: builds and timed runs have no network of their own.
- **Trusts** the kit and its own clock. The broker times every measured run from outside, so a number that a change prints about itself is only a cross-check. Build outputs are hashed, made read-only, and checked again before each timed run.
- **Runs the kit as trusted code.** A kit's check runs as the judge itself, in the kit's own folder. A kit reaches a rig only by its commit, in a command that control signed, and no agent ever sees it. So use kits that you wrote or read ([Why the benchmark lives in a kit](kits.md)).
- **Takes no messages.** No message, rule or advisor can change a measurement.

## Where a rig runs

The harness's network depends on where the rig runs. Its supervisor needs the internet and control everywhere, and takes no connections.

| Where | What the harness can reach | What can reach the harness |
| --- | --- | --- |
| **Compose**, on one computer | DNS, the internet, your computer (as `host.docker.internal`) and your local network, through the normal `egress` network. It is not on control's network | Its port is not published on your computer. It shares an internal network with its supervisor alone |
| **A machine**, set up by control over SSH or joined by you | The same as compose: the rig's `egress` Podman network leads to the internet and to the machine's local network | Its port is not published on the machine |
| **Kubernetes**, in a namespace that control creates or that you join | DNS, and addresses outside the private ranges of RFC 1918, by the network rules that control adds. The cluster's network plugin must enforce them | Only its supervisor, on port 8700 |
| **Kubernetes**, in a slot that the cluster's operators made | What the operators' network rules allow. Control refuses a slot unless those rules keep the harness off the private ranges | What the operators' rules allow |
| **RunPod** | Rigs on RunPod are not built yet ([goals 019 to 025](https://github.com/iammrduncan/thermite/blob/main/docs/plan/roadmap.md#rigs-on-runpod)). Today control starts only short test pods there (below) | |

[Ports, volumes and secret files](../reference/ports-volumes-secrets.md#networks) lists each network and rule.

A **RunPod test pod** runs Thermite's CUDA harness image with a probe in place of the broker, and no agents. The probe checks the platform, starts the broker as a rig would, runs the isolation self-test, and serves what it found on port 8000. Control reads that report through RunPod's public HTTP proxy, at an address with a random token in its path. The report holds names and results only, never the value of a variable. Control removes the pod when the test ends ([Test a GPU on RunPod](../how-to/install/runpod-test.md)).

## Where to read more

- [Isolation inside a rig](isolation.md): the role users, the broker, the GPU fence and the isolation self-test.
- [Trust between control and rigs](trust.md): signed commands, signed reports and pinned keys.
- [Who holds your keys](who-holds-your-keys.md): where each secret is kept and where it travels.
- [Known limits](../reference/known-limits.md): what this design does not cover yet.
- To report a security problem, follow the [security policy](https://github.com/iammrduncan/thermite/blob/main/SECURITY.md).
