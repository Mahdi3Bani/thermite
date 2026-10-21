# Changelog

Each release of Thermite, newest first. Versions 0.x make no upgrade promise: read [Known limits](docs/_site/src/content/docs/reference/known-limits.md) before you upgrade.

## [Unreleased]: v0.1.0, the first public release

- A decision you make leaves **Needs you** at once, with its count; the change's own page still says what you chose and what the rig did. It comes back only if the rig refuses it or the item needs you again.
### Install and run

- Install from published images, with no build. Each release attaches a compose file that pins the images by digest, and `thermite local init` makes the stack's secret files. Building from source stays for contributors.
- The images:
  - control, the CPU harness and the supervisor, for amd64 and arm64;
  - the CUDA harness, and the one-container rig image for RunPod built on it, for amd64. The release's compose file gives control the rig image, so a launch on RunPod needs no image.
- Control's image carries kubectl, for rigs on Kubernetes clusters, with its license (Apache-2.0) as a file. The image's license label stays `MIT`.
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
- Copy a campaign under a new name, with the same contract and kit and its own empty folder, to compare two models from zero: **Copy** on the campaign's page, `POST /v1/campaigns/<campaign>/copy`, the MCP tool `copy_campaign` and `thermite campaign copy`. The page's panel checks the copy's name as you type and opens the copy's page, which says where it came from. A research campaign's copy can name other MCP servers for its agents, such as a web search service.
- One experiment queue for each run. The planner coordinates it. The owner, the advisors and the lanes add to it, and `thermite assign --queue-from` copies another run's untried experiments.
- `thermite assign --note` and `thermite assign-payload --note` keep a text with the run, shown as `Note: …` on the run's page in the knowledge base. `--direction`, the flag's old name, still works in v0.1.0 and says on standard error that it is now `--note`: a direction is now a named line of experiments. The signed command keeps the field's name, `direction`.
- Rules for the planner name the run's directions. The owner writes them in plain words on the run's **Planner** tab, under **Tell the planner**, where `:` picks one of the run's directions, and the planner makes the rules at its next round. An old rule in words, from before rules named directions, is converted to a rule on a named direction at the planner's next round: it keeps its kind, author and why, shows `converted from:` and the old words, and is never dropped without a rule in its place.
- Agents run in Pi, OpenCode v2, Claude Code or the Codex CLI, chosen for each rig. The harness images carry OpenCode and the Codex CLI, each with its license. Claude Code runs under the rig's own isolation, as the other harnesses do, with its own sandbox off, and gets its sign-in on a file descriptor, never in an environment or a file. An advisor on a Claude subscription runs Claude Code the same way, with none of Claude Code's own tools, so the images carry no bubblewrap.
- Each kind of agent can have its own model and effort: the workers, the planner, the teacher pair, the combiner, the auditor and the review panel, on Edit rig and over REST and MCP (`set_rig_model` with `agent`, and `rig_models` to read them). Each agent's model can take a cap on its context window, to compare two models at the same window, and its own compaction point.
- Each kind of agent also runs in the program of the owner's choice over REST and MCP (`set_rig_model`'s `harness`, for any `agent`): Pi, OpenCode v2, Claude Code or the Codex CLI. A model that a program can't run is refused in words. A planner with its own model plans in its own program, and reaches its own provider through the harness's proxy. An advisor in OpenCode or Codex runs in the supervisor in a folder of its own, with none of the program's own tools: only the search of the run's past research and the kit's MCP tools, and the model through a proxy for the call that adds the key. The supervisor image now carries OpenCode and the Codex CLI with their licenses, and its license label is `MIT AND Apache-2.0`.
- A conversation that grows never ends a trial, and no agent is told to submit early because of it. Near the model's context window (by default 80% of it; `compact_at`, from 50 to 95, sets the share with each agent's model over REST and MCP) the conversation is compacted and the agent goes on. In Pi, the harness first keeps the whole conversation in the run's research folder (`compactions/`), where the agent can read it and the run keeps it, then asks the same model for a summary that names it. OpenCode v2, Codex and Claude Code compact on their own, with the window and the point Thermite sets in their settings. Each compaction is a `context_compacted` event, in History and Live, with the summary.
- The advisors compact too. An advisor's call in Pi compacts as the planner's does, and the supervisor keeps the conversation with its records of the round, never where the run's workers read; an advisor in Claude Code, OpenCode or Codex gets the window and the point in that program's settings. An advisor's package (a brief, an audit's or a review's) is cut to fit its window, and its input says so.
- A campaign can set its own context window and compaction point for all its runs' agents: the contract's optional `agents_context`, set with `POST /v1/campaigns/<campaign>/context`, the MCP tool `set_campaign_context`, `thermite campaign context`, a copy's `agents_context` (`copy_campaign`, `thermite campaign copy --context-window --compact-at`) or `thermite assign --context-window --compact-at`. Each agent's window is the lower of the campaign's and its own. Start a run says what applies to each agent, and refuses a window above what a provider lists for one of the rig's agents' models.
- On a CUDA rig, the agents find CUDA's tools by name in every harness.
- Field notes from the workers, the planner and the advisors. Thermite keeps its own knowledge base, with a folder for each campaign, and the owner grants which campaigns may read which folders. Workers, the planner and the advisors can search what they may read.
- MCP servers for the agents. The owner adds a server once in Settings, with an OAuth sign-in, a key, a client ID and secret, or none; control seals the secret and reads the server's tools. A campaign's kit names its servers, the agents that get each, and, when narrowed, their tools. Workers and the planner call them through the rig's harness, the advisors through its supervisor; no agent sees a secret, and a server that fails does not stop a run. Rigs on RunPod get their servers through control's connection to the pod.

### Operate

- Control's log pages through every entry, in the dashboard, over REST and in the `control_log` MCP tool.
- The judge's smoke check passes on a machine with noisy timing when the only wrong result is the no-op's `inconclusive` in place of `neutral`. It then says so in a note: the timing on this machine is noisy, and results there need more repeats. Any other wrong result still fails it.
- The documentation site has tutorials, how-to guides, reference and explanation. Agents read it through `llms.txt`. It includes the known limits and the security model.
- `SECURITY.md`, `CONTRIBUTING.md` and a code of conduct (the Contributor Covenant 2.1). CI runs on every push to the development branch: the checks, the docs site, a secret scan, the compose smoke test, the rig image, RunPod against a fake API, and the quick start from the release bundle.

### Removed

- The outside knowledge base: its copies of campaign folders, the advisors' search grant and `THERMITE_OUTSIDE_KB_SYNC_SECONDS`. At the update, each one becomes an MCP server with its token, and a kit names it.
- The old `QWEN_*` names of the model settings, the `thermite-qwen` provider ID and the `qwen-api-key` file migration. Use the `THERMITE_MODEL_*` settings.
- The Kubernetes namespace default `ar-{rig}`. It is now `thermite-{rig}`; a rig with a namespace set keeps it.
