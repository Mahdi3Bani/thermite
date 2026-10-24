# Roadmap

Every goal, by version, in priority order. Each line links to its goal. [How Thermite is planned](README.md) explains goals, their statuses and how to add an idea.

- **v0.1.0 is decided.** Its plan is [release-v0.1.0.md](release-v0.1.0.md).
- **Later versions are proposed.** Their order and their contents can change.
- **Versions count up by the middle number:** 0.2.0, 0.3.0 and so on. Fixes and quick follow-ups ship as 0.1.1, 0.1.2.
- **Each version ships when its goals are verified,** not on a date. Each one also takes the fixes from tester reports on the version before it.

## Built so far

Before v0.1.0, the v1 design was built in milestones. Each milestone ended with checks that had to pass before the next one started.

| Milestone | Delivers | Status |
| --- | --- | --- |
| **M1: core** | Contracts for all three modes, the ledger, the harness API, signed commands and verified imports, container images and a local compose stack | Built |
| **M2: judge** | Process isolation, target drivers (CUDA GPU and CPU), the build and run pipeline, gates, timing owned by the executor, statistics, verdicts. Acceptance tests with known good, broken, no-op and tampering candidates | Built; accepted on the CPU and CUDA GPU targets |
| **M3: control** | Supervisor reporting and command relay, git export, the central control service with dashboard, API and MCP | Built; accepted with two local rigs |
| **M4: agents** | Stateless workers with submit, status and development-run tools; the planner; goal and research modes | Built; accepted with a scripted model; the first real-model trials have run |
| **M5: supervision** | Teacher review with cited directives, audits, the review panel for subjective goals, "not possible" endings, propagation and cross-verification across rigs, daily reports, lifecycle control and full reset | Built; accepted locally |
| **M6: test fire** | Several campaigns in all three modes running unattended for days, with failures injected along the way | Goal [049](goals/049-multi-day-test-fire.goal) |

Since M5, control also sets rigs up by itself, on machines over SSH and on Kubernetes clusters, or gives you one command to join a rig where it cannot connect. Rigs may have many GPUs, split between the judge and the agents by what is deployed on them. The dashboard has a New campaign page and one Providers page: model providers (API keys and subscriptions), Git access, machines, clusters and RunPod. Each agent role can have its own model.

## v0.1.0

**First public release.** A tester installs Thermite from published images, runs agents on a sample project, adds rigs on their own machines or clusters, and launches GPU rigs on RunPod. Decided.

The plan: [release-v0.1.0.md](release-v0.1.0.md).

### Tester basics

- [001](goals/_completed/001-plans-in-public.goal) Plans in public docs · `VERIFIED`
- [002](goals/_completed/002-ci-and-repository-settings.goal) CI on every push, and repository settings · `VERIFIED`
- [003](goals/_completed/003-advisors-no-default-cap.goal) No default spend limit for advisors · `VERIFIED`
- [004](goals/_completed/004-secret-scan.goal) Scan the history for secrets · `VERIFIED`
- [005](goals/_completed/005-sample-project.goal) A sample project in `examples/` · `VERIFIED`
- [060](goals/_completed/060-docs-site.goal) The documentation site · `VERIFIED`
- [006](goals/006-docs-for-testers.goal) Docs for testers · `DROPPED`, merged into 060
- [007](goals/_completed/007-known-limits.goal) Known limits and the security model · `VERIFIED`
- [008](goals/_completed/008-community-files.goal) Community files and contributor docs · `VERIFIED`
- [009](goals/_completed/009-subscription-sign-in-tests.goal) Real subscription sign-in tests · `VERIFIED`
- [063](goals/_completed/063-scan-and-steer.goal) Campaigns, runs and live views you can scan; steering as one message box · `VERIFIED`
- [080](goals/_completed/080-buttons-show-progress.goal) A button says at once that it took, and shows its outcome without a refresh · `VERIFIED`

### Install from images

- [010](goals/010-published-images.goal) Published images and a release workflow · `IN_PROGRESS`
- [011](goals/011-release-bundle.goal) A release bundle · `IN_PROGRESS`
- [012](goals/_completed/012-version-checks.goal) Version checks between control and rigs · `VERIFIED`
- [013](goals/_completed/013-thermite-doctor.goal) `thermite doctor` · `VERIFIED`
- [037](goals/_completed/037-gpu-compose.goal) The local rig uses what its machine has: CPUs, memory and NVIDIA GPUs · `VERIFIED`
- [014](goals/_completed/014-quick-start-in-ci.goal) The quick start, tested in CI · `VERIFIED`
- [015](goals/_completed/015-log-paging.goal) Log paging · `VERIFIED`
- [016](goals/_completed/016-small-fixes.goal) Small fixes before the release · `VERIFIED`
- [017](goals/_completed/017-legacy-names.goal) Remove the legacy model names · `VERIFIED`
- [118](goals/118-cluster-rig-resources.goal) Change a cluster rig's GPUs, CPUs and memory from control · `IN_PROGRESS`

### Running campaigns

- [064](goals/_completed/064-experiment-queue.goal) One experiment queue for each run; the planner coordinates it · `VERIFIED`
- [065](goals/_completed/065-journals-and-corpus.goal) Journals and a research corpus from every campaign · `VERIFIED`
- [066](goals/_completed/066-direction-rules.goal) Rules name directions, picked with `:direction:` · `VERIFIED`
- [067](goals/_completed/067-assign-queue-from.goal) `thermite assign` can copy a past run's untried experiments · `VERIFIED`
- [068](goals/_completed/068-mcp-servers-for-agents.goal) MCP servers for a campaign's agents, named by its kit · `VERIFIED`
- [069](goals/_completed/069-copy-a-campaign.goal) Copy a campaign · `VERIFIED`
- [056](goals/_completed/056-codex-harness.goal) A Codex CLI harness · `VERIFIED`
- [070](goals/_completed/070-model-context-cap.goal) Cap the context window of a rig's model · `VERIFIED`
- [073](goals/_completed/073-harness-for-each-agent.goal) A harness for each agent · `VERIFIED`
- [074](goals/_completed/074-one-name-for-each-agent.goal) One name for each agent · `VERIFIED`
- [075](goals/_completed/075-model-usage.goal) Model usage for each run, campaign and the whole system · `VERIFIED`
- [079](goals/_completed/079-thermite-overhead.goal) Provider errors by kind, no hidden caps, restarts that keep work, and hands-off promotion · `VERIFIED`
- [077](goals/_completed/077-archive-and-folders.goal) Archive a campaign; folders in the left navigation; no rigs there · `VERIFIED`
- [078](goals/_completed/078-campaign-brief.goal) A campaign's brief: additional information, ideas and hypotheses for every mode · `VERIFIED`
- [082](goals/_completed/082-judge-findings-in-view.goal) The judge's findings in view: held-out failures by kind, refusals everywhere, a time limit per cell, each goal's real check · `VERIFIED`
- [081](goals/_completed/081-ideas-first.goal) Teachers put ideas first; a target queue depth; lanes propose follow-ups · `VERIFIED`
- [086](goals/_completed/086-goal-report-values-and-confirmation-wait.goal) A goal report keeps what it measured; lanes wait while a met champion is confirmed · `VERIFIED`
- [087](goals/_completed/087-close-a-run.goal) The owner closes a run by hand · `VERIFIED`
- [096](goals/_completed/096-kits-from-elsewhere.goal) Give control a kit written elsewhere, as a git bundle · `VERIFIED`
- [103](goals/103-export-and-download.goal) Export, full or not, from the dashboard; an Exports page that downloads each export · `IN_PROGRESS`
- [098](goals/_completed/098-research-teachers-read-the-research.goal) A run's teachers read what the run found: its sources, claims, findings and files · `VERIFIED`
- [099](goals/_completed/099-campaign-status-words.goal) Status words say how a run ended; a judge-only run says so · `VERIFIED`
- [115](goals/_completed/115-hill-climb-baseline.goal) A hill climb's first job measures its starting point, and its guards hold against it · `VERIFIED`

### Research mode

- [062](goals/_completed/062-research-folder.goal) A research folder agents can search and write · `VERIFIED`
- [076](goals/_completed/076-claim-sources-and-reasons.goal) A claim's source by its address, and a draft's reasons for the owner · `VERIFIED`
- [112](goals/112-research-ends-when-answered.goal) A research run ends when the review panel finds its questions answered · `IN_PROGRESS`
- [117](goals/117-research-that-answers.goal) Research that answers its questions: one living answer per question, work driven by its gaps, and an end it can reach · `PROPOSED`

### Rigs on RunPod

- [018](goals/_completed/018-runpod-spike.goal) RunPod spike · `VERIFIED`
- [019](goals/_completed/019-rig-only-entry.goal) Control reaches RunPod rigs through RunPod's proxy · `VERIFIED`
- [020](goals/_completed/020-runpod-rig-image.goal) A one-container rig image · `VERIFIED`
- [021](goals/_completed/021-enrollment-codes.goal) Enrollment codes · `VERIFIED`
- [022](goals/_completed/022-runpod-launch.goal) Launch a rig on RunPod · `VERIFIED`
- [023](goals/_completed/023-runpod-lifecycle.goal) Stop, start and terminate RunPod rigs · `VERIFIED`
- [024](goals/_completed/024-runpod-models-and-results.goal) Models into the pod, results out · `VERIFIED`
- [025](goals/_completed/025-runpod-tests-and-docs.goal) RunPod tests and how-to · `VERIFIED`

### The release

- [026](goals/026-ship-v0.1.0.goal) Ship v0.1.0 · `READY`

## v0.1.1

**Quick follow-ups to the first release.** Proposed.

- [088](goals/088-new-campaign-button-progress.goal) New campaign's buttons show they were pressed · `PROPOSED`
- [090](goals/090-info-tab.goal) An Info tab for campaigns and runs: everything they were started with · `PROPOSED`
- [091](goals/091-needs-you-stuck-rigs.goal) Needs you shows a rig that is stuck · `PROPOSED`
- [093](goals/093-live-shows-reasoning.goal) Live shows what the model thinks and says, not only its tool calls · `PROPOSED`
- [094](goals/094-copy-id.goal) Copy an ID from any page · `PROPOSED`
- [095](goals/095-runpod-spend-on-providers.goal) Providers shows what Thermite spent on a GPU cloud, not only its test pods · `PROPOSED`
- [097](goals/097-add-a-kit-bundle-from-the-dashboard.goal) Give control a kit bundle from the dashboard · `PROPOSED`
- [100](goals/100-on-demand-gpus.goal) GPUs on demand for the judge and the workers · `PROPOSED`
- [101](goals/101-secondary-judge.goal) A secondary judge: an outside service's checks on a schedule, and its submissions · `PROPOSED`
- [108](goals/108-gated-models-on-cloud-rigs.goal) Gated models on cloud rigs · `PROPOSED`
- [109](goals/109-exports-page-shows-what-matters.goal) The Exports page shows what matters, not every slice · `PROPOSED`
- [110](goals/110-judge-only-runs-show-progress.goal) A judge-only run shows its progress · `PROPOSED`
- [114](goals/114-hill-climb-contract-gaps.goal) Hill-climb contracts: a check once per candidate, cheaper held-out cells, and goal mode's fields · `PROPOSED`
- [116](goals/116-reviews-tab.goal) A Reviews tab for research runs: every review, each reviewer's answers and comments, and the outcome · `PROPOSED`

## v0.2.0

**Run Thermite without the dashboard.** Every dashboard action has an API and MCP twin, all logs are in one place you can search, and sign-in uses your identity provider. Proposed.

- [027](goals/027-logs-page.goal) One Logs page · `PROPOSED`
- [028](goals/028-log-store.goal) Search every log and session · `PROPOSED`
- [029](goals/029-api-mcp-coverage.goal) Full API and MCP coverage · `IN_PROGRESS`
- [071](goals/071-bounded-mcp-answers.goal) MCP answers that fit an agent's context · `PROPOSED`
- [072](goals/072-why-nothing-at-work.goal) Say why a running run has nothing at work · `PROPOSED`
- [083](goals/083-deep-research-teacher.goal) A deep-research teacher that runs on a trigger · `PROPOSED`
- [084](goals/084-research-tasks-in-code-runs.goal) Research tasks inside goal and hill-climb runs, with web search · `PROPOSED`
- [085](goals/085-move-a-campaign-to-another-rig.goal) Move a campaign's work to another rig · `PROPOSED`
- [089](goals/089-dashboard-performance.goal) Faster dashboard pages · `PROPOSED`
- [092](goals/092-knowledge-explore-and-dumps.goal) Explore the knowledge base, and dump it to outside stores · `PROPOSED`
- [102](goals/102-kits-define-campaigns.goal) Kits define how a campaign runs; rigs are the slots it runs in · `PROPOSED`
- [105](goals/105-amd-gpus.goal) AMD GPUs in rigs · `PROPOSED`
- [106](goals/106-apple-silicon-rig.goal) A rig on Apple silicon that uses its GPU · `PROPOSED`
- [107](goals/107-runs-side-by-side.goal) Several runs at once on one rig, within its resources · `PROPOSED`
- [030](goals/030-oauth-sign-in.goal) Sign in with OAuth or OIDC · `PROPOSED`
- [031](goals/031-design-docs.goal) The design reasons, in public docs · `PROPOSED`
- [061](goals/061-gaps-found-by-the-docs.goal) Gaps found by the docs work · `PROPOSED`

## v0.3.0

**Rigs you can trust.** Setting up and removing rigs on machines and clusters is safe to repeat, and lanes are kept off the local network. Proposed.

- [032](goals/032-deploy-checks.goal) Checks before a rig is deployed · `PROPOSED`
- [033](goals/033-slot-helper.goal) Slots made easy · `PROPOSED`
- [034](goals/034-trustworthy-removal.goal) Removal you can trust · `PROPOSED`
- [035](goals/035-rig-upgrades.goal) Upgrades from control · `IN_PROGRESS`
- [036](goals/036-install-it-yourself.goal) "I will install it myself" · `PROPOSED`
- [038](goals/038-lane-network-rules.goal) Keep lanes off the local network · `PROPOSED`
- [039](goals/039-cluster-ranges-and-key-rotation.goal) Cluster ranges and key rotation · `PROPOSED`
- [104](goals/104-change-a-cloud-rigs-gpu.goal) Change a cloud rig's GPU and settings, keeping its state · `PROPOSED`

## v0.4.0

**Kits and evidence.** Kits are easier to write and to test before agents start, and each result shows clearer evidence. Proposed.

- [040](goals/040-kit-tools.goal) Kit tools · `PROPOSED`
- [041](goals/041-kits-and-rigs-explained.goal) Kits and rigs, explained · `DROPPED`, merged into 060
- [042](goals/042-kit-self-test.goal) A kit self-test · `PROPOSED`
- [043](goals/043-progress-charts.goal) Progress charts · `PROPOSED`
- [044](goals/044-comparable-results.goal) Comparable results · `PROPOSED`
- [045](goals/045-richer-receipts.goal) Richer receipts · `PROPOSED`
- [113](goals/113-research-lab-campaign.goal) A research lab: one campaign that researches, builds, improves and researches again · `PROPOSED`

## v0.5.0

**Unattended for days.** Campaigns in all three modes run for days with no person watching. Research mode already searches the web, through an MCP server the campaign names (046, done ahead of this version). Proposed.

- [046](goals/_completed/046-web-search.goal) Web search for research mode · `VERIFIED` (through MCP servers, 068)
- [047](goals/047-research-planner.goal) A model planner for research mode · `PROPOSED`
- [048](goals/048-validation-scenarios.goal) Six validation scenarios · `PROPOSED`
- [049](goals/049-multi-day-test-fire.goal) The multi-day test fire · `PROPOSED`
- [050](goals/050-docs-site-and-init.goal) A two-command start, and a generated settings reference · `PROPOSED`

## Later

**Not scheduled.** Ideas with a clear source and no version yet. Proposed.

- [051](goals/051-pareto-and-population.goal) Pareto champions and population search · `PROPOSED`
- [052](goals/052-more-target-drivers.goal) More target drivers · `PROPOSED`
- [053](goals/053-cross-rig-planning.goal) Planning across rigs · `PROPOSED`
- [054](goals/054-signed-artifacts.goal) Signed receipts and images · `PROPOSED`
- [055](goals/055-runpod-inference.goal) RunPod for inference · `PROPOSED`
- [057](goals/057-finalize-champions.goal) Finalize a champion into reviewable branches · `PROPOSED`
- [058](goals/058-helm-and-npm.goal) Helm charts and an npm package · `PROPOSED`
- [059](goals/059-knowledge-base-export.goal) Research results into a knowledge base · `DROPPED` (now part of 065)
- [111](goals/111-reuse-a-goal-report.goal) A new run reuses the judge's goal report on the same starting point · `PROPOSED`
