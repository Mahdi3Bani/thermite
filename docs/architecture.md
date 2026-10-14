# Architecture

Thermite has three parts. A **unit** does the research, and a unit is two containers. A **control service** sees and steers every unit. **Target drivers** connect the judge to whatever is being measured.

```mermaid
flowchart TB
  subgraph Control[Control service]
    UI[Dashboard]
    API[API and MCP]
    Store[(Campaigns, reports, commands)]
  end
  subgraph Unit[Unit, repeated across the fleet]
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

## The unit

### Harness container

The harness does the research. It contains:

- **The ledger:** the authoritative record of campaigns, attempts, measurements, verdicts, champions, directives and budgets.
- **The judge:** gates, statistics, verdicts and promotion. Only the judge decides what counts.
- **Executors and target drivers:** they run official measurements on the unit's target, such as a GPU or a CPU set, with the clock owned by the executor.
- **The planner:** a stateless model call each epoch that assigns directions to lanes from a deterministic summary of the ledger.
- **Workers:** one fresh agent session per trial, each in its own workspace, proposing one change per trial.
- **A small privileged broker:** it starts, stops and isolates the other processes. Each lane's tools and shell commands, builds and candidate runs each run as separate users, and none of them can read the judge's files. A worker's agent session runs as its lane's own agent user, which can read none of the harness's state, kits, secrets or lane files. Its file and shell tools reach its workspace only through the harness API, with a token bound to its own trial that stops working when the trial ends; the harness runs them as the lane's user, in that trial's workspace only.

Network: DNS, the internet and its model endpoint. Nothing else in the network can reach the harness except its own supervisor.

### Supervisor container

The supervisor is the unit's link to everything outside:

- **Reporting.** Every 60 seconds it polls the harness and sends new results, champion changes, worker statistics and costs to control.
- **Commands.** It picks up control's signed commands and relays them to the harness.
- **Git and data.** It handles all git work and copies models and repositories into the harness. The harness verifies every hash against a signed command before using anything.
- **Teaching.** Hourly, two frontier models review the unit's progress and research externally. A neutral combiner turns their reviews into structured directives for the planner.
- **Audits.** A fresh-context auditor reviews surprising results. An audit can hold a result back; it can never pass one.

## The control service

- **Dashboard.** Every campaign, unit, worker and supervisor in one view, including hill-climb charts, goal trees and research progress.
- **API and MCP.** Every view is available to scripts and agents, with scoped tokens and an audit log.
  - An agent's token can steer: assign, pause, resume, redirect, reset workers, export, propagate.
  - Only the owner's credential approves a promotion, accepts a subjective goal or a "not possible" ending, or wipes a unit. Control signs who issued each command, and the harness checks it.
- **Commands.** Control signs every command it sends:
  - assign a campaign to a unit, with a starting point;
  - redirect it;
  - reset its workers;
  - pause or resume it;
  - propagate one unit's best result to another unit, where that unit's own judge re-measures it;
  - export the unit's results to git.
- **Lifecycle.** Control can restart or fully reset a unit's containers, and the unit exports its results first.

**Units keep researching when control is down.** Reports and commands catch up when it returns.

## Where it runs

The same images run three ways:

- on **Kubernetes**, where each unit gets its device through the cluster's device allocation;
- under **docker-compose**;
- under **podman-compose**, for a single machine.

Units with GPUs and CPU-only units, for example for research campaigns, use the same two-container contract.

## Targets

The judge measures through **target drivers**. A driver identifies the device, checks that it is idle and healthy before timing, records its state with each result, and runs the work. It also opens and closes agents' development access, sanity-checks numbers against physical limits, and recovers after faults.

v1 ships drivers for CUDA GPUs and for CPUs. Others, such as serial-attached boards, use the same interface.

**Sharing a device is configurable.**

- **Shared mode** (one device per unit). The judge takes the device whenever it has work waiting, and agents use it for their own test runs the rest of the time.
- **Dedicated mode.** Agents and the judge each get their own device.
