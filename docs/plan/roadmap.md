# Roadmap

Every goal, by version, in priority order. Each line links to its goal. [How Thermite is planned](README.md) explains goals, their statuses and how to add an idea.

- **v0.1.0 is decided.** Its plan is [release-v0.1.0.md](release-v0.1.0.md).
- **Later versions are proposed.** Their order and their contents can change.
- **Versions count up by the middle number:** 0.2.0, 0.3.0 and so on. Fixes ship as 0.1.1, 0.1.2.
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

- [001](goals/001-plans-in-public.goal) Plans in public docs · `VERIFIED`
- [002](goals/002-ci-and-repository-settings.goal) CI on every push, and repository settings · `READY`
- [003](goals/003-advisors-no-default-cap.goal) No default spend limit for advisors · `VERIFIED`
- [004](goals/004-secret-scan.goal) Scan the history for secrets · `READY`
- [005](goals/005-sample-project.goal) A sample project in `examples/` · `READY`
- [060](goals/060-docs-site.goal) The documentation site · `VERIFIED`
- [006](goals/006-docs-for-testers.goal) Docs for testers · `DROPPED`, merged into 060
- [007](goals/007-known-limits.goal) Known limits and the security model · `READY`
- [008](goals/008-community-files.goal) Community files and contributor docs · `READY`
- [009](goals/009-subscription-sign-in-tests.goal) Real subscription sign-in tests · `READY`
- [063](goals/063-scan-and-steer.goal) Campaigns, runs and live views you can scan; steering as one message box · `IN_PROGRESS`

### Install from images

- [010](goals/010-published-images.goal) Published images and a release workflow · `IN_PROGRESS`
- [011](goals/011-release-bundle.goal) A release bundle · `READY`
- [012](goals/012-version-checks.goal) Version checks between control and rigs · `READY`
- [013](goals/013-thermite-doctor.goal) `thermite doctor` · `READY`
- [014](goals/014-quick-start-in-ci.goal) The quick start, tested in CI · `READY`
- [015](goals/015-log-paging.goal) Log paging · `READY`
- [016](goals/016-small-fixes.goal) Small fixes before the release · `READY`
- [017](goals/017-legacy-names.goal) Remove the legacy model names · `READY`

### Running campaigns

- [064](goals/064-experiment-queue.goal) One experiment queue for each run; the planner coordinates it · `IN_PROGRESS`
- [065](goals/065-journals-and-corpus.goal) Journals and a research corpus from every campaign · `IN_PROGRESS`
- [066](goals/066-direction-rules.goal) Rules name directions, picked with `:direction:` · `READY`
- [067](goals/067-assign-queue-from.goal) `thermite assign` can copy a past run's untried experiments · `READY`
- [068](goals/068-mcp-servers-for-agents.goal) MCP servers for a campaign's agents, named by its kit · `READY`

### Research mode

- [062](goals/062-research-folder.goal) A research folder agents can search and write · `IN_PROGRESS`

### Rigs on RunPod

- [018](goals/018-runpod-spike.goal) RunPod spike · `IN_PROGRESS`
- [019](goals/019-rig-only-entry.goal) Control reaches RunPod rigs through RunPod's proxy · `IN_PROGRESS`
- [020](goals/020-runpod-rig-image.goal) A one-container rig image · `READY`
- [021](goals/021-enrollment-codes.goal) Enrollment codes · `READY`
- [022](goals/022-runpod-launch.goal) Launch a rig on RunPod · `READY`
- [023](goals/023-runpod-lifecycle.goal) Stop, start and terminate RunPod rigs · `READY`
- [024](goals/024-runpod-models-and-results.goal) Models into the pod, results out · `READY`
- [025](goals/025-runpod-tests-and-docs.goal) RunPod tests and how-to · `READY`

### The release

- [026](goals/026-ship-v0.1.0.goal) Ship v0.1.0 · `READY`

## v0.2.0

**Run Thermite without the dashboard.** Every dashboard action has an API and MCP twin, all logs are in one place you can search, and sign-in uses your identity provider. Proposed.

- [027](goals/027-logs-page.goal) One Logs page · `PROPOSED`
- [028](goals/028-log-store.goal) Search every log and session · `PROPOSED`
- [029](goals/029-api-mcp-coverage.goal) Full API and MCP coverage · `PROPOSED`
- [030](goals/030-oauth-sign-in.goal) Sign in with OAuth or OIDC · `PROPOSED`
- [031](goals/031-design-docs.goal) The design reasons, in public docs · `PROPOSED`
- [061](goals/061-gaps-found-by-the-docs.goal) Gaps found by the docs work · `PROPOSED`

## v0.3.0

**Rigs you can trust.** Setting up and removing rigs on machines and clusters is safe to repeat, GPU rigs work under compose, and lanes are kept off the local network. Proposed.

- [032](goals/032-deploy-checks.goal) Checks before a rig is deployed · `PROPOSED`
- [033](goals/033-slot-helper.goal) Slots made easy · `PROPOSED`
- [034](goals/034-trustworthy-removal.goal) Removal you can trust · `PROPOSED`
- [035](goals/035-rig-upgrades.goal) Upgrades from control · `IN_PROGRESS`
- [036](goals/036-install-it-yourself.goal) "I will install it myself" · `PROPOSED`
- [037](goals/037-gpu-compose.goal) GPU rigs under compose · `PROPOSED`
- [038](goals/038-lane-network-rules.goal) Keep lanes off the local network · `PROPOSED`
- [039](goals/039-cluster-ranges-and-key-rotation.goal) Cluster ranges and key rotation · `PROPOSED`

## v0.4.0

**Kits and evidence.** Kits are easier to write and to test before agents start, and each result shows clearer evidence. Proposed.

- [040](goals/040-kit-tools.goal) Kit tools · `PROPOSED`
- [041](goals/041-kits-and-rigs-explained.goal) Kits and rigs, explained · `DROPPED`, merged into 060
- [042](goals/042-kit-self-test.goal) A kit self-test · `PROPOSED`
- [043](goals/043-progress-charts.goal) Progress charts · `PROPOSED`
- [044](goals/044-comparable-results.goal) Comparable results · `PROPOSED`
- [045](goals/045-richer-receipts.goal) Richer receipts · `PROPOSED`

## v0.5.0

**Unattended for days.** Campaigns in all three modes run for days with no person watching, and research mode can search the web. Proposed.

- [046](goals/046-web-search.goal) Web search for research mode · `PROPOSED`
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
- [056](goals/056-codex-harness.goal) A Codex CLI harness · `PROPOSED`
- [057](goals/057-finalize-champions.goal) Finalize a champion into reviewable branches · `PROPOSED`
- [058](goals/058-helm-and-npm.goal) Helm charts and an npm package · `PROPOSED`
- [059](goals/059-knowledge-base-export.goal) Research results into a knowledge base · `DROPPED` (now part of 065)
