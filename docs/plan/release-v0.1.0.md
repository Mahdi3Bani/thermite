# Release plan: v0.1.0

v0.1.0 is Thermite's first public release. A tester installs it from published images, runs agents on a sample project, adds rigs on their own machines or clusters, and launches GPU rigs on RunPod.

It has four parts, then the release itself. The parts can run at the same time. The [roadmap](roadmap.md) shows what comes after it.

## Decided

- **2026-10-19:** v0.1.0 is the first public release. It holds the tester basics, install from published images, and rigs on RunPod.
- **2026-10-19:** The code moves to `main` only as the last step before the release. Until then, work stays on the development branch.
- **2026-10-19:** Advisors get no default spend limit. A limit applies only when someone sets one.
- **2026-10-19:** SECURITY.md, CONTRIBUTING.md and the other community files ship with v0.1.0.
- **2026-10-19:** The sample project lives in this repository, under `examples/`.
- **2026-10-19:** The release also includes a troubleshooting page, an own-registry how-to, the harness image's toolchains, a split of the local development guide, lane limits that agree, a README screenshot and the repository settings.
- **2026-10-19:** The docs become a documentation site, built with Astro Starlight from `docs/_site/` and arranged by Diátaxis, with `llms.txt` and `llms-full.txt` for agents (goal 060).
- **2026-10-20:** The owner took the recommended answer to each open decision, except the docs site's address: the site will be served from Cloudflare, under a domain the owner chooses, and the owner deploys it later. The answers are in the table below and in each goal.
- **2026-10-20:** The owner merges the code into `main` and makes the tag, when the project is ready for one.
- **2026-10-20:** The docs site is served at usethermite.com by Cloudflare Pages, built from `main`. So the code moved to `main` early, at the development branch's state that day. Work stays on the development branch, and `main` follows it.

## What a tester gets

**In v0.1.0:**

- Control and a CPU rig on one machine, started from published images with one compose file. Building from source stays for contributors.
- The rig checks from the dashboard, and `thermite doctor` for the machine.
- A first agent campaign on the sample project, with a free model or the tester's own key.
- The New campaign page, the Providers page, kits and all three campaign modes.
- Rigs on the tester's own machines over SSH, and on their Kubernetes clusters.
- Rigs on RunPod GPUs, launched, stopped and paid for from control.
- A documentation site with tutorials, how-to guides, reference and explanation. Agents can read all of it through `llms.txt`.
- A changelog, a known-limits page, a security policy and a contributor guide.

**Later:** one Logs page and full API and MCP coverage (v0.2.0); safer managed rigs and lane network rules (v0.3.0); kit tools and clearer evidence (v0.4.0); web search and multi-day runs (v0.5.0). 0.x versions make no upgrade promise.

## Goals

### Tester basics

A tester can run Thermite, knows the risks, and knows where to report a problem.

| Goal | Status | Depends on |
| --- | --- | --- |
| [001 · Plans in public docs](goals/001-plans-in-public.goal) | `VERIFIED` | — |
| [002 · CI on every push, and repository settings](goals/002-ci-and-repository-settings.goal) | `IN_PROGRESS` | — |
| [003 · No default spend limit for advisors](goals/003-advisors-no-default-cap.goal) | `VERIFIED` | — |
| [004 · Scan the history for secrets](goals/004-secret-scan.goal) | `VERIFIED` | — |
| [005 · A sample project in `examples/`](goals/005-sample-project.goal) | `IN_PROGRESS` | — |
| [060 · The documentation site](goals/060-docs-site.goal) | `VERIFIED` | — |
| [006 · Docs for testers](goals/006-docs-for-testers.goal) | `DROPPED`, merged into 060 | — |
| [007 · Known limits and the security model](goals/007-known-limits.goal) | `VERIFIED` | — |
| [008 · Community files and contributor docs](goals/008-community-files.goal) | `IN_PROGRESS` | — |
| [009 · Real subscription sign-in tests](goals/009-subscription-sign-in-tests.goal) | `IN_PROGRESS` | — |
| [063 · Campaigns, runs and live views you can scan; steering as one message box](goals/063-scan-and-steer.goal) | `VERIFIED` | — |

### Running campaigns

A tester sees what each run is doing, gives it work through one queue of experiments, and every campaign keeps what its agents learn.

| Goal | Status | Depends on |
| --- | --- | --- |
| [064 · One experiment queue for each run; the planner coordinates it](goals/064-experiment-queue.goal) | `VERIFIED` | 063 |
| [065 · Journals and a research corpus from every campaign](goals/065-journals-and-corpus.goal) | `VERIFIED` | 062, 064 |
| [066 · Rules name directions, picked with `:direction:`](goals/066-direction-rules.goal) | `VERIFIED` | 064 |
| [067 · `thermite assign` can copy a past run's untried experiments](goals/067-assign-queue-from.goal) | `VERIFIED` | 064 |
| [068 · MCP servers for a campaign's agents, named by its kit](goals/068-mcp-servers-for-agents.goal) | `VERIFIED` | 065 |
| [069 · Copy a campaign](goals/069-copy-a-campaign.goal) | `IN_PROGRESS` | 065 |
| [056 · A Codex CLI harness](goals/056-codex-harness.goal) | `VERIFIED` | — |
| [070 · Cap the context window of a rig's model](goals/070-model-context-cap.goal) | `IN_PROGRESS` | — |

### Install from images

A tester pulls images in place of building them, and every remote rig has images to pull.

| Goal | Status | Depends on |
| --- | --- | --- |
| [010 · Published images and a release workflow](goals/010-published-images.goal) | `IN_PROGRESS` | — |
| [011 · A release bundle](goals/011-release-bundle.goal) | `IN_PROGRESS` | [010](goals/010-published-images.goal) |
| [012 · Version checks between control and rigs](goals/012-version-checks.goal) | `VERIFIED` | [010](goals/010-published-images.goal) |
| [013 · `thermite doctor`](goals/013-thermite-doctor.goal) | `VERIFIED` | — |
| [014 · The quick start, tested in CI](goals/014-quick-start-in-ci.goal) | `VERIFIED` | [005](goals/005-sample-project.goal), [011](goals/011-release-bundle.goal) |
| [015 · Log paging](goals/015-log-paging.goal) | `VERIFIED` | — |
| [016 · Small fixes before the release](goals/016-small-fixes.goal) | `VERIFIED` | — |
| [017 · Remove the legacy model names](goals/017-legacy-names.goal) | `VERIFIED` | — |

### Research mode

Research workers build on what earlier trials learned, and a research campaign gives its corpus, claims and findings, not only a report.

| Goal | Status | Depends on |
| --- | --- | --- |
| [062 · A research folder agents can search and write](goals/062-research-folder.goal) | `IN_PROGRESS` | — |

### Rigs on RunPod

The owner launches a GPU rig on RunPod from control, runs campaigns on it, and stops paying when it is idle.

| Goal | Status | Depends on |
| --- | --- | --- |
| [018 · RunPod spike](goals/018-runpod-spike.goal) | `IN_PROGRESS` | — |
| [019 · Control reaches RunPod rigs through RunPod's proxy](goals/019-rig-only-entry.goal) | `IN_PROGRESS` | — |
| [020 · A one-container rig image](goals/020-runpod-rig-image.goal) | `VERIFIED` | [018](goals/018-runpod-spike.goal) |
| [021 · Enrollment codes](goals/021-enrollment-codes.goal) | `VERIFIED` | — |
| [022 · Launch a rig on RunPod](goals/022-runpod-launch.goal) | `IN_PROGRESS` | [010](goals/010-published-images.goal), [019](goals/019-rig-only-entry.goal), [020](goals/020-runpod-rig-image.goal), [021](goals/021-enrollment-codes.goal) |
| [023 · Stop, start and terminate RunPod rigs](goals/023-runpod-lifecycle.goal) | `IN_PROGRESS` | [022](goals/022-runpod-launch.goal) |
| [024 · Models into the pod, results out](goals/024-runpod-models-and-results.goal) | `IN_PROGRESS` | — |
| [025 · RunPod tests and how-to](goals/025-runpod-tests-and-docs.goal) | `IN_PROGRESS` | [022](goals/022-runpod-launch.goal), [023](goals/023-runpod-lifecycle.goal), [024](goals/024-runpod-models-and-results.goal) |

### The release

| Goal | Status | Depends on |
| --- | --- | --- |
| [026 · Ship v0.1.0](goals/026-ship-v0.1.0.goal) | `READY` | every other goal |

## Order of work

1. Goal 002 first, so CI runs on every push from now on.
2. The parts go on at the same time; in Running campaigns, 064 follows 063 and 065 follows 064. In RunPod, the launcher (022) waits for the images (010), the rig-only entry (019), the rig image (020) and the enrollment codes (021).
3. When every other goal is verified, goal 026 ships the release: the clean-machine tests, the full checks, the pull request into `main`, the changelog, the tag and the GitHub Release.
4. Fixes from tester reports ship as 0.1.1, 0.1.2 and so on. New features go into v0.2.0.

## Decisions made from the open questions

| Decision | Answer | Goal |
| --- | --- | --- |
| RunPod packaging | One combined image per pod (2026-10-20) | [020](goals/020-runpod-rig-image.goal) |
| How rigs on other networks reach control | Control connects to RunPod rigs through RunPod's proxy (2026-10-19) | [019](goals/019-rig-only-entry.goal) |
| Who may launch on RunPod | The owner only (2026-10-20) | [022](goals/022-runpod-launch.goal) |
| RunPod cloud | Secure cloud on demand first; Community and spot later (2026-10-20) | [022](goals/022-runpod-launch.goal) |
| Where a pod's results go | The project's results repository when it has one, otherwise an upload to control (2026-10-20) | [024](goals/024-runpod-models-and-results.goal) |
| Terms in the community files | No contributor agreement, no sign-off rule, the Contributor Covenant (2026-10-20) | [008](goals/008-community-files.goal) |
| Subscription sign-in tests | Before the tag (2026-10-20) | [009](goals/009-subscription-sign-in-tests.goal) |
| How the code reaches `main` | A pull request merged as a fast-forward (2026-10-20) | [026](goals/026-ship-v0.1.0.goal) |
| The docs site's address | usethermite.com, on Cloudflare Pages, built from `main` (2026-10-20) | [060](goals/060-docs-site.goal) |

One step needs the owner's GitHub account: the repository settings ([002](goals/002-ci-and-repository-settings.goal)). The image packages are public ([010](goals/010-published-images.goal)).
