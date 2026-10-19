# Settled decisions

Decisions that shape the whole product, newest last in each section. A decision about one piece of work is in that work's goal. [How Thermite is planned](README.md) says how a new decision is recorded.

## The product

| Date | Decision |
| --- | --- |
| 2026-10-14 | TypeScript wherever possible, on Node.js LTS. Another language only where a target project's own tooling needs it, such as a measurement script in a kit. |
| 2026-10-14 | MIT license. |
| 2026-10-14 | Three campaign modes: hill climb, goal and research. |
| 2026-10-14 | SQLite stores, one for each harness and one for control, and a single control replica. |
| 2026-10-15 | The names: a **rig** is one judge, its agents and a supervisor on a set of devices, and a machine can host several rigs. A **run** is one campaign on one rig from one starting point. The hierarchy is Campaign ▸ Run ▸ Lane ▸ Trial ▸ Attempt. |
| 2026-10-18 | Thermite is for one researcher or one lab. It is not a multi-tenant service. |

## Research and judging

| Date | Decision |
| --- | --- |
| 2026-10-14 | Agents never judge. Measurement, completion and promotion live in code that the agents cannot write. |
| 2026-10-14 | The harness owns all research state. Every agent call starts fresh from context the harness builds. Parallel workers are isolated, and a central, stateless planner assigns their experiments. |
| 2026-10-14 | The judge measures on a device first, and agents use it the rest of the time. Dedicated devices for each are configuration. |
| 2026-10-15 | A confirmed win promotes on its own when no audit holds it. A gain above the contract's absolute audit trigger (15% by default) waits for the owner after its audit. |
| 2026-10-15 | No default caps. Nothing ends or cuts research short by default: no turn, submission, failure or wall-time limit. A campaign runs until its goals are met. A cap exists only when someone configures it. |
| 2026-10-15 | Files that a kit lists in `run.copy` are copied fresh into every run, owned by the judge and read-only to the run. |
| 2026-10-16 | No default time limit for a single command. A lane's processes live for the whole trial. |
| 2026-10-16 | Kits order their verifiers and gate expensive ones on cheap prerequisites (`priority` and `requires`). |
| 2026-10-17 | Test cases fit any kind of project. A case is a name and what makes it different. The score is a run's time, a rate, or a number that the check reports. |
| 2026-10-17 | A "hidden test" is a case the judge uses only to confirm a change that already looks better, never while it screens. |
| 2026-10-18 | A rig is a set of GPUs. Judge GPUs and agent GPUs are pools, and the split is set where a campaign is deployed. |
| 2026-10-20 | Each run has one experiment queue: the experiments still to try, in order, and a log of those tried, with their results. The planner coordinates it: it gives lanes work that does not overlap. The planner, the advisors and the owner add and reorder experiments; workers propose ideas for the planner to queue. Rules for the plan are set on the run's Planner tab. |
| 2026-10-20 | Every agent writes a journal and research notes. Thermite keeps its own knowledge base: each campaign has a folder with everything its runs produce, and reads other campaigns' folders only when the owner grants it. An outside knowledge base (such as GBrain) is optional: a sync target and a source of outside context. |
| 2026-10-19 | Research workers search all of a run's research and write files. The harness builds a research folder from its records (read-only to workers), and each lane keeps a working area across its trials; the other lanes see a lane's files when its trial ends. A research run's output is its report plus the whole folder. Findings carry a summary and why they matter, and code checks them against verified claims. ([062](goals/062-research-folder.goal)) |

## Rigs and deployment

| Date | Decision |
| --- | --- |
| 2026-10-14 | A rig is a harness container and a supervisor container. Everything runs on Kubernetes or under docker-compose or podman-compose. |
| 2026-10-14 | The harness reaches only DNS, the internet and its model endpoint. The supervisor reaches the internet, its harness, control and, optionally, a knowledge base. The supervisor does all git operations. |
| 2026-10-14 | One central control service, with a dashboard, an API and MCP. Supervisors report to it, and it can pause, reset and assign rigs. |
| 2026-10-14 | Each project has its own results repository. The project's key is read-only. |
| 2026-10-16 | Thermite is self-contained. Campaigns, kits and rigs are managed through control. Infrastructure belongs to whoever runs it. |
| 2026-10-17 | Control sets rigs up itself. Given an SSH key or a kubeconfig, it checks the place, installs what is missing (only when the owner says yes), deploys the rig and manages it. Rigs still report by dialing out. |
| 2026-10-18 | Control refuses a pre-made Kubernetes slot whose network rules do not keep the harness off the cluster. "Join a rig yourself" is an optional third way to add a rig. |

## Providers and models

| Date | Decision |
| --- | --- |
| 2026-10-17 | A model provider is entered once: name, type, base URL and key. Its models are listed from the provider. Keys are sealed and sent only to the rigs that use them. |
| 2026-10-17 | Each rig picks its worker harness and its model as two separate choices. |
| 2026-10-18 | Each agent role (the planner, the workers and each advisor) can have its own model and effort. |
| 2026-10-18 | A Claude subscription runs only inside Claude Code, never in another program. Its token goes in Claude Code's environment. Claude Code is in an image only when the image is built with that option. |
| 2026-10-18 | ChatGPT works through Sign in with ChatGPT. Control keeps the refresh token sealed and is the only one that renews it. Rigs get one-hour access tokens. |
| 2026-10-18 | At a subscription's usage limit, agents wait for the reset. They never use paid credits. |
| 2026-10-18 | A subscription serves only its owner's own Thermite. A Thermite that several people use takes API keys. |

## Control and operation

| Date | Decision |
| --- | --- |
| 2026-10-16 | The dashboard is for a human operator. Every decision it asks for shows what is decided and what each choice does. |
| 2026-10-16 | Screens are chosen from mockups. Every form label has a description. |
| 2026-10-16 | Campaigns are operated only through control: the dashboard, REST, MCP or the CLI. |
| 2026-10-16 | The owner mints the admin token, and control keeps only its hash. An operator token lets agents assign, pause, resume, redirect, reset, export and message agents. Approvals, audits and reviews stay the owner's. |
| 2026-10-18 | Cards, call-outs and reports are written in Simplified Technical English. |

## Releases and planning

| Date | Decision |
| --- | --- |
| 2026-10-14 | Agents commit on branches. The maintainers push. |
| 2026-10-18 | The history was rewritten once, before the first public push. |
| 2026-10-19 | The first public release is v0.1.0. It holds the tester basics, published images and rigs on RunPod. The code moves to `main` only as the last step before it. |
| 2026-10-19 | Advisors have no default spend limit. |
| 2026-10-19 | The plans are public, in `docs/plan/`. Each roadmap item has a goal. A new idea becomes a new goal and goes into the roadmap by priority. |
| 2026-10-19 | The documentation is a site built with Astro Starlight from `docs/_site/` and arranged by Diátaxis: tutorials, how-to guides, reference and explanation. It is written for an average person, and agents read it through `llms.txt` and `llms-full.txt`. Repository docs stay in `docs/`. |
