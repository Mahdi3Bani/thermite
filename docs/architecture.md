# Architecture

Thermite has three parts. A **rig** does the research, and a rig is two containers. A **control service** sees and steers every rig. **Target drivers** connect the judge to whatever is being measured.

```mermaid
flowchart TB
  subgraph Control[Control service]
    UI[Dashboard]
    API[API and MCP]
    Store[(Campaigns, reports, commands)]
  end
  subgraph Rig[Rig, repeated across the fleet]
    S[Supervisor container]
    H[Harness container]
  end
  People[People and agents] --> UI
  People --> API
  S -- reports every 60 s, polls commands --> API
  S -- harness API --> H
  H --> M[Model endpoint for workers and planner]
  S --> Net[Internet, git, frontier models, knowledge base]
```

## The rig

### Harness container

The harness does the research. It contains:

- **The ledger:** the authoritative record of campaigns, attempts, measurements, verdicts, champions, directives and budgets.
- **The judge:** gates, statistics, verdicts and promotion. Only the judge decides what counts.
- **Executors and target drivers:** they run official measurements on the rig's target, such as a GPU or a CPU set, with the clock owned by the executor.
- **The planner:** a stateless model call each epoch that assigns directions to lanes from a deterministic summary of the ledger.
- **Workers:** one fresh agent session per trial, each in its own workspace, proposing one change per trial.
- **A small privileged broker:** it starts, stops and isolates the other processes. Each lane's tools and shell commands, builds and candidate runs each run as separate users, and none of them can read the judge's files. A worker's agent session runs as its lane's own agent user, which can read none of the harness's state, kits, secrets or lane files. Its file and shell tools reach its workspace only through the harness API, with a token bound to its own trial that stops working when the trial ends; the harness runs them as the lane's user, in that trial's workspace only.

Network: DNS, the internet and its model endpoint. Nothing else in the network can reach the harness except its own supervisor.

### Supervisor container

The supervisor is the rig's link to everything outside:

- **Reporting.** Every 60 seconds it polls the harness and sends new results, champion changes, worker statistics and costs to control.
- **Commands.** It picks up control's signed commands and relays them to the harness.
- **Git and data.** It handles all git work and copies models and repositories into the harness. The harness verifies every hash against a signed command before using anything.
- **Teaching.** Hourly, two frontier models review the rig's progress and research externally. A neutral combiner turns their reviews into structured directives for the planner.
- **Audits.** A fresh-context auditor reviews surprising results. An audit can hold a result back; it can never pass one.

## The control service

- **Dashboard.** It is organized campaigns first, following Campaign ▸ Run ▸ Lane ▸ Trial ▸ Attempt:
  - **Overview:** what needs the owner (promotions to approve, audits, reviews, "not possible" proposals, keys to accept, resets to confirm), then campaigns, rigs and recent activity.
  - **Campaigns:** each campaign with its runs on every rig. A campaign's page starts with a summary across its runs: state, gain or goals met, attempts, wins and cross-verification, plus a goals-by-run grid for goal campaigns. Below it, one tab per run shows that run alone, in three views: an overview (KPIs, the champion chart, goals, verdicts, lanes and the latest attempts), all its attempts, and its steering.
  - **Rigs:** each rig's judge queue, results export, advisors and signing key, and the runs it holds.
  - **Live:** each rig's agent sessions and judge as they work. The harness signs the lines its workers, planner and judge write, and the supervisor relays them every few seconds with its own lines, which are unsigned. The owner can message a worker's trial, a lane, the planner or the advisors from here, as a signed command. The judge is code and takes no messages.
- **API and MCP.** Every view is available to scripts and agents, with scoped tokens and an audit log.
  - An agent's token can steer: assign, pause, resume, redirect, reset workers, export, propagate.
  - Only the owner's credential approves a promotion, accepts a subjective goal or a "not possible" ending, or wipes a rig. Control signs who issued each command, and the harness checks it.
- **Commands.** Control signs every command it sends:
  - assign a campaign to a rig, with a starting point;
  - redirect it;
  - reset its workers;
  - pause or resume it;
  - propagate one rig's best result to another rig, where that rig's own judge re-measures it;
  - export the rig's results to git.
- **Lifecycle.** Control can restart or fully reset a rig's containers, and the rig exports its results first.
- **Reports are signed by the harness.** The supervisor relays them but cannot forge, replay or thin them out:
  - each report carries the harness's time and its latest event;
  - control takes a report only if it continues the stream it has, is newer than the last one, and comes from the rig's current ledger;
  - a rig's signing key is pinned at first contact, or held for the owner to accept by its fingerprint when control is configured to require that.
- **The command queue.** Commands expire, the owner can cancel one that is still pending, and one command that cannot be delivered never holds up the others.

**Rigs keep researching when control is down.** Reports and commands catch up when it returns.

## Where it runs

The same images run three ways:

- on **Kubernetes**, where each rig gets its device through the cluster's device allocation;
- under **docker-compose**;
- under **podman-compose**, for a single machine.

Rigs with GPUs and CPU-only rigs, for example for research campaigns, use the same two-container contract.

## Targets

The judge measures through **target drivers**. A driver identifies the device, checks that it is idle and healthy before timing, records its state with each result, and runs the work. It also opens and closes agents' development access, sanity-checks numbers against physical limits, and recovers after faults.

v1 ships drivers for CUDA GPUs and for CPUs. Others, such as serial-attached boards, use the same interface.

**Sharing a device is configurable.**

- **Shared mode** (one device per rig). The judge takes the device whenever it has work waiting, and agents use it for their own test runs the rest of the time.
- **Dedicated mode.** Agents and the judge each get their own device.
