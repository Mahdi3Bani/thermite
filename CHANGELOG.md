# Changelog

Each release of Thermite, newest first. Versions 0.x make no upgrade promise: read [Known limits](docs/_site/src/content/docs/reference/known-limits.md) before you upgrade.

## [Unreleased]: v0.1.0, the first public release

### Install and run

- Install from published images, with no build. Each release attaches a compose file that pins the images by digest, and `thermite local init` makes the stack's secret files. Building from source stays for contributors.
- The images:
  - control, the CPU harness and the supervisor, for amd64 and arm64;
  - the CUDA harness, and the one-container rig image for RunPod built on it, for amd64. The release's compose file gives control the rig image, so a launch on RunPod needs no image.
- `thermite doctor` checks the machine. It covers the container engine, the compose tool, ports, disk, the clock, the GPU toolkit, and whether control and the model can be reached, and it says how to fix each problem.
- Control and every rig report their versions. Control marks a rig that is behind it, refuses a rig it cannot work with, and shows a rig that stopped reporting as stale or offline.

### Rigs

- Rigs on your own machines over SSH, and on Kubernetes clusters, in a namespace that control creates or in a slot that your operators made.
- Rigs on RunPod GPUs, on Secure cloud, launched by the owner from the dashboard's **Launch on RunPod** or over REST, MCP or the command line:
  - control connects to the pod through RunPod's proxy, and enrolls it with a one-time code;
  - the pod runs one container that holds the harness and the supervisor;
  - control tracks each rig's hourly price and spend, and applies a spend limit or an idle stop only when you set one. The dashboard's launch form fills in an idle stop of 30 minutes, which you can change or clear, and a new run wakes a pod its idle stop stopped;
  - stop, start, restart, full reset and terminate, where terminate waits until every result has left the pod.
- The Rigs list is a table: each rig's state, where it runs, its version, the run at work and, on RunPod, its price.
- A rig takes model files by URL and checksum, with progress. It sends its exports to control when the project has no results repository.

### Campaigns

- Three campaign modes: hill climb, goal and research.
- The New campaign page and Start a run. Start a run also works without the browser: `POST /v1/campaigns/<campaign>/runs`, the MCP tool `start_run` and `thermite run start` take the same fields and give the same refusals. A campaign's project can be a folder inside a repository. A sample project and its kit are in `examples/matmul-cpu`.
- Campaigns, runs and Live per run, built for scanning. The owner messages the agents and the advisors from one message box, and sees who read each message.
- Copy a campaign under a new name, with the same contract and kit and its own empty folder, to compare two models from zero: `POST /v1/campaigns/<campaign>/copy`, the MCP tool `copy_campaign` and `thermite campaign copy`. A research campaign's copy can name other MCP servers for its agents, such as a web search service.
- One experiment queue for each run. The planner coordinates it. The owner, the advisors and the lanes add to it, and `thermite assign --queue-from` copies another run's untried experiments.
- Rules for the planner name the run's directions. The owner writes them in plain words on the run's **Planner** tab, under **Tell the planner**, where `:` picks one of the run's directions, and the planner makes the rules at its next round.
- Agents run in Pi, OpenCode v2, Claude Code or the Codex CLI, chosen for each rig. The harness images carry OpenCode and the Codex CLI, each with its license. Claude Code runs under the rig's own isolation, as the other harnesses do, with its own sandbox off, and gets its sign-in on a file descriptor, never in an environment or a file. An advisor on a Claude subscription runs Claude Code the same way, with none of Claude Code's own tools, so the images carry no bubblewrap.
- Each kind of agent can have its own model and effort: the workers, the planner, the teacher pair, the combiner, the auditor and the review panel, on Edit rig and over REST and MCP (`set_rig_model` with `agent`, and `rig_models` to read them). The workers' model can take a cap on its context window, to compare two models at the same window.
- On a CUDA rig, the agents find CUDA's tools by name in every harness.
- Field notes from the workers, the planner and the advisors. Thermite keeps its own knowledge base, with a folder for each campaign, and the owner grants which campaigns may read which folders. Workers, the planner and the advisors can search what they may read.
- MCP servers for the agents. The owner adds a server once in Settings, with an OAuth sign-in, a key, a client ID and secret, or none; control seals the secret and reads the server's tools. A campaign's kit names its servers, the agents that get each, and, when narrowed, their tools. Workers and the planner call them through the rig's harness, the advisors through its supervisor; no agent sees a secret, and a server that fails does not stop a run. Rigs on RunPod get their servers through control's connection to the pod.

### Operate

- Control's log pages through every entry, in the dashboard, over REST and in the `control_log` MCP tool.
- The documentation site has tutorials, how-to guides, reference and explanation. Agents read it through `llms.txt`. It includes the known limits and the security model.
- `SECURITY.md`, `CONTRIBUTING.md` and a code of conduct (the Contributor Covenant 2.1). CI runs on every push to the development branch: the checks, the docs site, a secret scan, the compose smoke test, the rig image, RunPod against a fake API, and the quick start from the release bundle.

### Removed

- The outside knowledge base: its copies of campaign folders, the advisors' search grant and `THERMITE_OUTSIDE_KB_SYNC_SECONDS`. At the update, each one becomes an MCP server with its token, and a kit names it.
- The old `QWEN_*` names of the model settings, the `thermite-qwen` provider ID and the `qwen-api-key` file migration. Use the `THERMITE_MODEL_*` settings.
- The Kubernetes namespace default `ar-{rig}`. It is now `thermite-{rig}`; a rig with a namespace set keeps it.
