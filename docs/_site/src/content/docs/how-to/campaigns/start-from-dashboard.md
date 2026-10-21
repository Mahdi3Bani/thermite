---
title: "Start a campaign from the dashboard"
description: "Use the New campaign page to say what to improve, where the project is, how to measure it and which rig runs it."
type: how-to
sidebar:
  order: 1
---

The **New campaign** page starts a [campaign](../../reference/glossary.md) in five steps. Control checks your answers, saves the campaign, and starts its first run on the [rig](../../reference/glossary.md) you choose. For a guided first time, follow [Your own project, from the New campaign page](../../tutorials/your-own-project.md).

## Before you start

- You are signed in to the dashboard with the owner's token.
- A rig reports to control: on **Rigs**, in the sidebar on the left, it shows the green **Live** chip and a hardware line. The campaign measures on this rig's target, CPU or GPU.
- Your project is in a git repository at an `https://` address, or in a private repository with Git access set up: see [Use a private repository](private-repository.md).
- For agents to work, the rig needs a model from a provider in **Settings › Providers**: see [Connect a model provider](../models/connect-a-provider.md). The page won't start agents on a rig without a model; **Try the kit first** and **Save without starting** work without one. You can give the rig a model in step 4, but then **Start the campaign** only saves the campaign: see [When the rig doesn't have the model yet](#when-the-rig-doesnt-have-the-model-yet).
- If the model uses a paid API key, set **Stop after (hours)** in step 4 under **Advanced**. See [Set a budget or a stop time](budget-and-stop-time.md).

## 1. Aim

Open **Campaigns** in the sidebar and press **New campaign**, at the top right of the page. The page shows the steps **1 Aim**, **2 Project**, **3 How to measure** (**3 The question** for research), **4 Where it runs** and **5 Review and start**. Move with **Next** and **Back**. Hover over the "i" beside a field to read what it means.

Choose a card. [Campaign modes](../../explanation/campaign-modes.md) explains each.

| Card | Use it to |
| --- | --- |
| **Hill climb** | Improve one measured number, such as speed, size or accuracy |
| **Reach a list of goals** | Work until checks you write all pass |
| **Research a question** | Collect sourced findings. No code changes |

Fill in **Campaign name** (lowercase letters, digits, dots and dashes, such as `sort-speed`) and **Title** (one sentence; agents read it too). Runs are named after the campaign: `sort-speed-1`, `sort-speed-2`. Using a name again saves a new version of that campaign, and the page doesn't warn you that the name is in use. Nothing that ran changes: runs that exist keep their version, and later runs use the new one. This is how you change a campaign made here, such as its stop time: fill in the page again with the same name. The page starts empty each time.

## 2. Project

Research campaigns skip this step.

| Field | What to enter |
| --- | --- |
| **Repository** | The project's address, such as `https://git.example.com/you/project.git`. Rigs fetch it themselves. Thermite never pushes to it |
| **Start from** | A branch, a tag or a full commit. Empty: the default branch. Control pins it to one commit, so every run starts from the same code |
| **Folder in the repository** | Empty when the project is the whole repository. For a project in one folder of a repository, the folder's path from the top, such as `examples/matmul-cpu/project`. The rig fetches the whole repository, and the run starts from the folder: the agents see only its files. **Files the agents may change**, the kit's commands and the champion's patch are then paths inside the folder |
| **Repository access** | **Public: no key**, or a Git access from **Settings** |
| **Files the agents may change** | Patterns, one per line, such as `src/**`. A change to any other file is refused before it is built |
| **Lines never allowed** (under **Advanced**) | Regular expressions, one per line, such as `clock_gettime`. A change that adds a matching line is refused |

Press **Look it up**. Control reads the repository's file names, not their contents, and shows a line such as `Found: main is at 1a2b3c4 · 214 files. Rigs fetch it from there.` with a few folders as buttons. With a folder, it counts and suggests only the folder's files, from the folder's top: `Found: main is at 1a2b3c4 · 4 files in examples/matmul-cpu/project. Rigs fetch it from there.` Press a folder to add it to **Files the agents may change**. If you skip **Look it up**, control looks the commit up when you start.

:::caution
- Without Git access, control reads only `https://` addresses. Others give `the repository must be an https:// URL, or choose Git access for a private one`.
- A private repository without access gives `control cannot read it without a key: is the repository private?`
- A folder the commit doesn't have gives `main has no folder examples/none, or the folder has no files`, and a path that leaves the repository, such as `../src`, gives `The folder is a path in the repository, such as examples/matmul-cpu/project: no / at either end, and no part that starts with a dot.`
- If you change **Repository**, **Start from** or **Folder in the repository** after **Look it up**, press it again: the page keeps the commit it found first.
:::

## 3. How to measure

The judge needs a [kit](../../explanation/kits.md): how to build your project, run it on test cases and check the output. This page calls a test case a **case**; a `kit.json` and a contract call it a **cell**. Agents never see the kit. Choose a card:

- **Describe it here**: a few commands and test cases. Control writes the kit and keeps it.
- **A kit in a repository**: a kit you keep in git. See [Write a kit for your project](write-a-kit.md).
- **Upload a kit**: a `.zip`, `.tar.gz`, `.tgz` or `.tar` file holding a kit.

### Describe it here

| Field | What to enter |
| --- | --- |
| **Run** | The command that runs your program for one case, such as `{build}/build/app {args} --out {out}/result.txt`. The buttons below it insert placeholders |
| **Test cases** | One row per case: **Name**, **Arguments**, **Input file**, **Work done** and **Hidden test**. **Work done** is only for a score as a rate: how much one run of the case does, such as the number of items sorted. **Add a case** adds a row. **Paste a list…** takes one case per line: its name, then its arguments |
| **Input files** | Files the cases run on, such as datasets |
| **The score** | **How long a run takes** (shorter is better), or **A number your check works out**, with **The number's name**, **Better is** and **Unit** |
| **Smallest gain that counts (%)** | 5 unless changed. A change must beat the best so far by this much, on repeated runs |
| **Runs per case** | 1, 3 or 5 (3 unless changed). The middle value counts |
| **Is it right?** | The check: a command, such as `python3 {kit}/check.py {out}/result.txt`. It runs after each case. Exit 0 means the result is right, and any other exit means it is wrong. To report a score, it also prints, as its last line, a JSON object with `pass` and the number, such as `{"pass": true, "accuracy": 0.93}` |
| **Files for the check** | Scripts and expected answers the check uses. The run can read them only if you tick **the run reads these too** before you choose them. Never let the run read the answers |
| **Build** | The command that builds the project in a fresh copy of the code, such as `make`. Empty: `true`, for a project with nothing to build |
| **What the build makes** | The files or folders the run needs, separated by spaces, such as `build/app` |

The placeholders, in **Run** and in **Is it right?**, are `{args}` (the case's **Arguments**), `{input}` (its **Input file**), `{build}` (what the build made: `{build}/build/app`), `{out}` (a folder for the run's results, which the check reads) and `{kit}` (the **Files for the check**). Any other gives `{x} is not a placeholder here: use {args}, {input}, {build}, {out} or {kit}`. This short set is the page's own: a `kit.json` you write yourself has other placeholders, and there the check's exit code doesn't count, only its JSON line. See [Write a kit for your project](write-a-kit.md).

- A **Hidden test** case is used only to double-check a change that already looks better, so a change can't win by helping only the cases agents see. At least one case must not be hidden.
- With **How long a run takes**, the score is a time, better lower. When every case that is not hidden has a **Work done** value, the score is a rate instead: **Work done** divided by the time, such as items per second, better higher.
- A kit described here takes up to 64 cases, 32 check files and 32 input files, each up to about 10 MB.

### A kit in a repository

This card has no **Better is** or **Smallest gain that counts (%)** of its own: the page takes them from the **Describe it here** card, as higher and 5% unless you change them there ([goal 061](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/061-gaps-found-by-the-docs.goal)). So, for a hill climb:

1. Choose **Describe it here**. Under **The score**, choose **A number your check works out**, so that **Better is** shows. Set it to the way your kit's metric improves: **lower** for a time.
2. Set **Smallest gain that counts (%)**.
3. Choose **A kit in a repository**. Fill in **Kit repository**, **Kit repository access**, **Kit commit** (the full commit), **Cases to measure** and **Hidden tests** (case names separated by spaces), and **The kit's metric** (a metric name from its `kit.json`).

For a goal campaign, do only step 3, without **The kit's metric**. Control reads only the MCP servers that this kit's `kit.json` names ([below](#mcp-servers-for-the-agents)); the rig checks the kit when the run starts.

### Upload a kit

Choose the file under **Kit archive**. It holds `kit.json` at its top or inside one folder, and has at most 2000 files, 64 MB in all, and no links. From a kit kept in git, `git archive --format=tar.gz -o kit.tar.gz HEAD` makes one. Control leaves out what a Mac adds to an archive: the hidden `._` files that `tar` puts beside each file, the `__MACOSX` folder of a zip made in the Finder, and `.DS_Store` files. Control checks `kit.json` and shows a line such as `smoke-cpu: measures on cpu, 3 cases, scores flops_per_s.` Nothing in the kit runs until a run starts.

Under **The kit's cases**, mark each case **Measured**, **Hidden test** or **Not used**. For a hill climb, also choose **The score**, **Better is** and **Smallest gain that counts (%)**. A time is always better lower.

### Goals

A goal campaign has a **Goals** table. Each row has **The goal**, **Checked by** and **Detail**. **Add a goal** adds a row. Every goal made here is required.

| Checked by | Detail | Works with |
| --- | --- | --- |
| **the check passes on cases** | Case names, such as `small large` | A kit described here |
| **the score reaches** | A bound and cases, such as `>= 4e13 on large` | A kit described here, or uploaded (its first metric) |
| **the kit's own check** | The name of a verifier in the kit's `kit.json` | A kit in a repository, or uploaded |
| **people review it** | Criteria separated by `;` | Any kit, on a rig with a review panel: see [Decide what waits for you](decide-what-waits.md#reviews) |

A goal campaign made here can't end as "not possible": it runs until every goal is met, or until you stop it. See [Decide what waits for you](decide-what-waits.md#not-possible-endings).

### MCP servers for the agents

The last part of **How to measure** gives the campaign's agents tools from outside Thermite: the MCP servers in **Settings › Providers**, such as a knowledge base or a code host. Skip it and the agents have only Thermite's own tools.

1. Tick a server. The workers get it at once; choose the agents that get it: **Workers**, **Planner**, **Advisors**.
2. Optional: open **Advanced: its tools for each kind of agent** under the server, and untick a tool for the agents that should not call it. Tools that change something on the server are marked **writes**.

The line under the list says what each kind of agent gets, such as `The workers get 31 tools from gbrain; the planner gets none; the advisors get 31 tools from gbrain.`, and warns of a server that is not in **Settings**, of one that doesn't work now, of one with no agents, and of a kind of agent left with no tool. **What goes into kit.json** shows the list. A kit described here gets it in its `kit.json`. An uploaded kit's list starts as its `kit.json` has it, and a change is written into the kit control keeps. A server it names that **Settings** lacks stays in the list, with `paper-search is not in Settings: this campaign can't start until it is. The uploaded kit names it: add it in Settings, or upload the kit without it.` A tool limit in its `kit.json` stays for a server whose tools **Settings** has not read. For **A kit in a repository**, the list is read from the kit's `kit.json` once you fill in **Kit repository** and **Kit commit**, each server marked `✓ found` or `✕ missing`, with **Add it in Settings** for a missing one; change it in the kit's repository. [Give agents MCP tools](give-agents-mcp-tools.md) says more.

### The question

For research, step 3 asks for **Topic** (a sentence), **Questions** (one per line, up to 50; the report counts the verified claims for each), **Starting links** (pages agents start from, one per line) and **Run for at least**, such as `8h` or `2d`. A run made here ends after that much running time; time while it is paused doesn't count. **MCP servers for the agents** is on this step too, as [above](#mcp-servers-for-the-agents); control writes the servers into the campaign's contract.

## 4. Where it runs

Choose the rig. Each card shows its hardware, whether it is idle, and its agents' model after `agents:`, followed by ` (OpenCode v2)` or ` (Codex)` when they run there, or `no model for its agents yet` in red. A rig that is not reporting can't be chosen. A [rig on RunPod](../install/runpod-rig.md) whose pod is stopped can: its card says `its pod is stopped: the first run starts it`, and control starts the pod before the first run. The campaign's page then says `rp-1a2b3c4d's pod was stopped: control started it. The run starts once the pod runs.`

| Field | What it does |
| --- | --- |
| **Agents working at once** | 1 to 4 (2 unless changed). Despite its name, it sets how many [lanes](../../reference/glossary.md) the planner plans, not how many agents work at once. See the caution below |
| **The agents' model** | **the rig's model** (the default) keeps the model the rig has. Or choose one of the models in **Providers**, listed by provider. It becomes the rig's model for every run on that rig, as on its **Edit rig** page. See the caution below |
| **The agents run in** | The [worker harness](../../reference/glossary.md), the program that runs the agents, for the model you chose: **what the model needs** (the default: the rig's own harness when control gave the rig this model already, else OpenCode v2 for OpenCode's free models, Claude Code for a Claude subscription, and Pi for the rest), **OpenCode v2**, **Pi** or **Codex**. Codex, the Codex CLI, takes a ChatGPT subscription's model or one from an OpenAI-compatible provider. Claude Code is not in the list: for a Claude subscription, keep **what the model needs** |
| **When a change is confirmed better** | **the rig's default**: the choice on the rig's **Edit rig** page, **Automatically** unless changed. Or **always keep it**, or **ask me every time**. See [Decide what waits for you](decide-what-waits.md#promotions) |

:::caution[A model the rig doesn't run yet: Start only saves]
**Start the campaign** starts the run only when the rig already runs the model. When you choose a model here that the rig doesn't run yet, control gives the rig that model and **saves the campaign without starting it**. The rig takes the model within a minute. The same happens with **the rig's model** when control gave the rig a model a moment ago, on **Edit rig**, **Settings › Providers** or over MCP. Then start the run as [When the rig doesn't have the model yet](#when-the-rig-doesnt-have-the-model-yet) says.
:::

:::caution[How many agents work at once]
The rig's **Workers at a time** decides it: on **Rigs**, open the rig, press **Edit rig**, and find it in the **Workers (agents)** row. It is 1 unless changed, so with the defaults the two lanes take turns, one trial at a time: the run's card shows one lane at work and the other with `next:` and its experiment. Raise it for agents to work side by side ([goal 061](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/061-gaps-found-by-the-docs.goal)). The summary at **5 Review and start** counts lanes as agents too, such as `2 agents work on rig-1.`
:::

Under **Advanced**:

| Field | What it does |
| --- | --- |
| **One try lasts (minutes)** | How long an agent works on one idea, in one [trial](../../reference/glossary.md) (not a try of the kit), 1 to 1440. Empty: the rig's default, 20 unless changed |
| **Memory per agent (MiB)** | 256 to 16384. Empty: 2048 |
| **Disk per agent (MiB)** | For one trial's copy of the code and its builds, 256 to 65536. Empty: 2048 |
| **Stop after (hours)** | Empty: no limit. When the time is up, no new trial starts and the run is paused. See [Set a budget or a stop time](budget-and-stop-time.md) |
| **GPUs for the judge** | For a rig with several GPUs: how many the judge measures on. The rig's harness, its container that holds the judge and the agents, restarts to apply it. Empty: the rig's current split |
| **Notes for the agents** | Anything the agents should know |

## 5. Review and start

Read the summary sentence. **What control will check (the draft)** shows your answers as JSON, as the page sends them; control builds the contract from them. Then press one of:

- **Start the campaign**: starts the first run, with agents.
- **Try the kit first** (hill climb and goal): starts a run with no agents, so you see the kit work before an agent spends anything. See [Test a kit with known candidates](test-a-kit.md).
- **Save without starting**: saves the campaign and starts nothing.

Below the buttons, **Past research** says that the campaign's agents read its own folder in Thermite's knowledge base (the link opens **Knowledge**), and that reading other campaigns' folders and starting a run from past research are set on the campaign's page once it is saved. To use them for the first run, press **Save without starting**, then follow [Use past research in a new run](use-past-research.md#past-research-for-a-new-campaign).

:::caution[Keep the address of a campaign you save without starting]
The **Campaigns** list shows a campaign only once a rig reports a run of it. A campaign saved without starting, or whose first run failed to start, is not on the list. Its page is at `/ui/campaigns/<name>`, such as `http://127.0.0.1:8800/ui/campaigns/sort-speed`: keep that address. The page has a **Start a run** button ([goal 061](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/061-gaps-found-by-the-docs.goal)).
:::

## Check that it started

- After **Start the campaign** or **Try the kit first**, the campaign's page opens. Until the rig reports the run, it says, for example, `Starting rig-1/sort-speed-1.`, also for a campaign that has runs already. Wait a minute and press **refresh** in the status bar, the line along the bottom of the page: pages don't reload by themselves. Once the rig reports the run, the page shows the run's own page instead, with the tabs **Overview**, **Experiments**, **Journal**, **Attempts**, **History** and **Planner**. On **Campaigns** in the sidebar, the run also shows under **At work now**, and the campaign in the list below it.
- A try's run is named like `sort-speed-try-1`, and its page says **A try of the kit.** Its results look right when the starting point builds and runs every case, and **History** has no `The judge's job (…) failed` line: see [Read the dry run](test-a-kit.md#3-read-the-dry-run). Then press **start the campaign** in that note: the **Start a run** panel opens. Keep **Agents** on **On**, and press **Start the run**. A rig runs one run at a time, so the new run pauses the try.
- After **Save without starting**, the page says `Saved on control, with no run yet.` and offers **Start a run of** and the campaign's name, such as **Start a run of sort-speed**.
- If the page says `Saved.` and that the rig takes a model, nothing started yet: see the next section.
- If the page comes back at **Review and start** with **Not started: fix these first.**, fix each item in the list. Everything you typed is kept. A kit described here or uploaded is checked against the campaign here, before anything is saved. The items about the agents' model are:
  - `rig-1 has no model for its agents, so they could not work: choose one under "The agents' model".`
  - `OpenCode's free models run only in the OpenCode harness: choose OpenCode v2 for this rig.` Choose **OpenCode v2** or **what the model needs** under **The agents run in**.
  - `Codex runs only with a ChatGPT subscription or an OpenAI-compatible provider: choose Pi or OpenCode v2 for this provider.` Choose another harness under **The agents run in**, or a model from a ChatGPT subscription or an OpenAI-compatible provider.
  - For research, with one of OpenCode's free models and the agents in Pi: `… is one of OpenCode's free models, which work only inside OpenCode, and rig-1's agents would run in Pi: a research run there could not work. Set the agents' harness to OpenCode, or give the rig a model Pi can use.` Choose **OpenCode v2** under **The agents run in**, or another model.
- If the run never shows, open **Commands** in the sidebar. The newest **assign campaign** row is **failed**, with the reason.

| The reason starts with | What to do |
| --- | --- |
| `staging:` | The rig could not fetch the project or the kit: the reason names the address, such as `staging: https://git.example.com/you/project.git has no commit …`, or gives git's own error. Check that the address works from the rig and that the commit is pushed there. For a private repository, use **Try it** on its Git access: see [Use a private repository](private-repository.md#5-check-that-the-rig-fetched-it). |
| `the kit does not fit the contract:` | A kit in a repository lacks a case, metric or verifier that the page named, or measures on another target. Each problem is named, such as `cells names cell large, which the kit does not have`. Correct the names, or commit the kit again and use its new **Kit commit**. |

When nothing in the campaign must change, such as after you fixed the repository's access, **Start a run** on the campaign's page starts the same version again. Otherwise fill in the **New campaign** page again with the same **Campaign name** and press **Start the campaign**: this saves a new version and starts it.

## When the rig doesn't have the model yet

When control has just given the rig a model, from step 4, the **Start a run** panel, **Edit rig**, **Settings › Providers** or MCP, the rig takes it within a minute. Until then, **Start the campaign** saves the campaign instead of starting it, and **Start the run** doesn't start a run. Start it once the rig has the model:

1. Note the campaign's page and its address. It says, for example, `Saved. rig-1 takes my-model within a minute. Settings › Providers shows the rig taking it until then; then start the run here.`, or `rig-1 takes my-model within a minute; Settings › Providers shows it taking the model until then. Then start the run again.` after **Start the run**. When control gave the rig the model elsewhere a moment ago, **Start the campaign** says `Saved. rig-1 has not taken my-model yet (it does within a minute of being given it; Settings › Providers shows it taking the model until then). Then start the run here.` The address is `/ui/campaigns/<name>`, such as `http://127.0.0.1:8800/ui/campaigns/sort-speed`. A campaign with no run yet is not in the **Campaigns** list, only at this address.
2. Open **Settings › Providers**, the cog at the foot of the sidebar, and find the rig's row under **Harness and model for each rig**. While the rig hasn't taken the model, the row shows `taking my-model under Pi` (or the harness you chose). Press **refresh** until that chip is gone and the row says `Its agents run under Pi with my-model from <provider>.`
3. Go back to the campaign's address, press **Start a run**, choose the rig under **Where it runs**, and press **Start the run**. The run starts as [Start a run later](#start-a-run-later) says.

Pressed too soon, **Start the run** answers **Not started.** and `rig-1 has not taken my-model yet (it does within a minute of being given it; Settings › Providers shows it taking the model until then): start the run after that.` Check the rig's row on **Settings › Providers** again, then press it again.

## Start a run later

Press **Start a run** at the top of the campaign's page. A panel opens, headed **Start a run of sort-speed**:

| Field | What it does |
| --- | --- |
| **Where it runs** | One card per rig, with its hardware, `free` or `busy`, and its agents' model, or `No model for its agents yet.` A rig with other hardware than the campaign's kit is greyed out. A busy rig's card says `Busy: sort-speed-1 is at work there, and pauses when this run starts (a rig runs one run at a time).` A [rig on RunPod](../install/runpod-rig.md) whose pod is stopped says `stopped` and `Its pod is stopped: this run starts it first.` You can choose it: control starts the pod, then the run. The panel chooses a free rig for you first, and a stopped pod only when no other rig fits |
| **Agents** | **On**: the agents propose changes, and the judge measures each one. **Off: a try**: no agents, only the judge, which measures the starting point. A try needs no model |
| **The agents' model** | Shows with **Agents** **On**, for a rig with no model: the model to give it, as on its **Edit rig** page. Control then gives the rig the model and starts nothing yet: see [When the rig doesn't have the model yet](#when-the-rig-doesnt-have-the-model-yet) |
| **Experiments to start with** | **Copy the untried experiments of** and a run of this campaign, such as `sort-speed-1 (4 up next, 1 lane idea)`: the new run's [experiment queue](choose-what-runs-next.md) starts with that run's waiting experiments, in the same order, and its lanes' ideas, each with who added it and why, up to 500. Ticked by default. It shows only with **Agents** **On**, and only when a run of the campaign has experiments up next or ideas. Untick it for an empty queue, which the planner fills |
| **From past research** | A search of the folders this campaign may read: its own and those you let it read. It lists the newest 40 experiments, findings, claims, notes and reports, and the box **Search past experiments, findings and notes** searches those folders. Ticked experiments join the new run's queue, after the copied ones; a ticked finding, claim, note or report becomes background in every agent's brief. It shows only with **Agents** **On**: with **Off: a try**, it hides, and nothing ticked in it is sent. See [Start a run from past research](use-past-research.md#start-a-run-from-past-research) |
| **When a change is confirmed better** | Under **More options**: **the rig's default**, **always keep it** or **ask me every time** |
| **GPUs for the judge** | Under **More options**: as in step 4. Empty: the rig's current split |

The line at the foot sums it up, such as `Starts a new run on rig-1, with agents on <model>.` or `Starts a new run on rig-1, as a try: the judge only.` With **Agents** on **On** and items ticked under **From past research**, it ends with a sentence such as `It starts from 3 items of past research.` Press **Start the run**. The run uses the latest saved version. It is named `<campaign>-<n>`, or `<campaign>-try-<n>` without agents, with the first number not yet used on that rig, such as `sort-speed-2`.

The campaign's page comes back, with a card at the top such as `Starting rig-1/sort-speed-2. The rig fetches the project and the kit and checks both; the run shows here once the rig reports it, usually within a minute.` Wait a minute and press **refresh**: once the rig reports the new run, the page shows the run's own page. The run also shows under **At work now** on the campaign's page. If control can't start it, the campaign's page says **Not started.** and the reason, with the panel open again, such as:

- `rig-1 has no model for its agents, so they could not work: choose one under "The agents' model", or give it one on its Edit rig page.`
- `rig-1 has not taken my-model yet (it does within a minute of being given it; Settings › Providers shows it taking the model until then): start the run after that.`: see [When the rig doesn't have the model yet](#when-the-rig-doesnt-have-the-model-yet).
- `An item from past research is not one this campaign may read and start from: search again.`: an item ticked under **From past research** is no longer in a folder the campaign may read, for example because its folder was removed after the panel opened. Search again, and tick the items again.
- `rig-1 has no run sort-speed-1 of sort-speed: copy from a run of this campaign.`: the run chosen under **Copy the untried experiments of** is gone, for example after a full reset of its rig. Open the panel again and choose another run.

For a research campaign with agents, it refuses a rig whose agents would run OpenCode's free models in Pi, with the message above. If the run you chose to copy from has tried every experiment since the panel opened, the run starts with an empty queue, and the page says `sort-speed-1 on rig-1 has no untried experiments: the new run's queue starts empty.`

**Start a run** also works for a campaign started from the command line, the REST API or MCP, even before a rig reports a run of it: see [Start a campaign from the command line](start-from-command-line.md#start-further-runs). For runs on other rigs, see [Run a campaign on several rigs](several-rigs.md).

### Start a run from a script or an agent

**Start a run** has a twin on the REST API, on MCP and on the command line. Each one runs the dashboard's own code, so it takes the same fields, checks the same things and refuses with the same words. With the owner's token file of the local stack:

```sh
npx thermite run start sort-speed --rig rig-1 --queue-from sort-speed-1 \
  --control http://127.0.0.1:8800 --token-file .dev/secrets/control-admin-token
```

It prints the new run and its command:

```json
{"started":true,"campaign":"sort-speed","rig":"rig-1","run":"sort-speed-2","command":"<command id>","status":"pending"}
```

| Panel field | Command line | REST and MCP |
| --- | --- | --- |
| **Where it runs** | `--rig rig-1` | `"rig": "rig-1"` |
| **Agents** **Off: a try** | `--agents off` | `"agents": false` |
| **The agents' model** | `--provider zen --model my-model` | `"agents_model": {"provider": "zen", "model": "my-model"}` |
| **Copy the untried experiments of** | `--queue-from sort-speed-1` for a run on the `--rig`, or `--queue-from rig-2/sort-speed-1` for a run on another rig | `"queue_from": {"rig": "rig-1", "run": "sort-speed-1"}` |
| **From past research** | `--past 12 --past 40` | `"past": [12, 40]` |
| **When a change is confirmed better** | `--promotion auto` or `--promotion owner` | `"promotion": "auto"` or `"owner_approval"` |
| **GPUs for the judge** | `--judge-gpus 2` | `"judge_gpus": 2` |

- **The command line** and **the REST API** (`POST /v1/campaigns/sort-speed/runs`) take the owner's token: see [the route](../../reference/rest-api.md#campaigns) and [`thermite run start`](../../reference/command-line.md#run-start).
- **MCP's** [`start_run`](../../reference/mcp-tools.md#start_run) takes the owner's token or an operator's. An operator's call can't change the GPU split, and can't start a stopped pod on RunPod.
- **Past research** is named by each item's id, which MCP's [`kb_search`](../../reference/mcp-tools.md#kb_search) gives.
- **A model given first.** With `--provider` and `--model` (or `agents_model`), control gives the rig the model and starts nothing yet, as the panel does. The answer is `{"started":false,"said":"rig-1 takes my-model within a minute; …"}`, and the command line exits with 1. Run it again without the model once the rig has taken it.
- **Notes.** The answer's `notes` say what else to know, such as `sort-speed-1 is at work on rig-1, and pauses when this run starts (a rig runs one run at a time).` The command line writes them on standard error.
- **Refusals** come back in the panel's words, such as `409` and `{"error":"rig-1 has no model for its agents, so they could not work: …"}` over REST. The command line writes the route, the status and that answer on standard error, and exits with 2.
- **A try.** With `--agents off`, or `"agents": false`, the twins refuse a model, a run to copy from and past research, which the panel hides: `A try (agents off) takes no model, no experiments and no background: leave them out, or start the run with agents.`

## Compare two models from zero

To compare two models on the same campaign, give each model a campaign of its own: a copy. Two runs of one campaign share its folder in [Thermite's knowledge base](../../reference/knowledge-base.md). Each new run starts with what the campaign's earlier runs recorded, and while both work, each reads the other's records every few minutes. So the second model would not start from zero. A copy has the same contract and kit under another name, its own empty folder, no [grants](../../reference/knowledge-base.md#grants) and no runs.

You need a campaign that control keeps (one saved on the **New campaign** page, or one assigned before over the command line, the REST API or MCP), and a rig for each model, or one rig with the runs one after the other.

1. Open **Campaigns** in the sidebar, then the campaign. Press **Copy**, beside **Start a run** at the top of its page. A panel opens, headed **Copy sort-speed**. It says why to copy: the copy gets its own empty folder, so its runs read nothing that the runs of `sort-speed` recorded.
2. Under **Name of the copy**, keep the free name the panel gives, such as `sort-speed-b`, or type another, such as `sort-speed-model-b`. The panel checks it as you type, with the **New campaign** page's rules, and says `✓ Free. Its runs are named sort-speed-model-b-1, sort-speed-model-b-2, and so on.` For a name it refuses, see [When the panel refuses](#when-the-panel-refuses). **Copy** stays off until the name is free.
3. Look at **MCP servers for its agents**, the tools from outside Thermite that the copy's agents can call:
   - **A research campaign.** The panel lists the servers in **Settings › MCP servers**, ticked as the campaign has them. Leave them so to compare the models alone. To give the copy's agents another server, tick it, then **Workers**, **Advisors** or both; open **Advanced: its tools for each kind of agent** under a server to untick tools. The line under the list says what each kind of agent gets, such as `The workers get 4 tools from gbrain (4 of 6); the advisors get 6 tools from gbrain.`, then `✓ The same as sort-speed.` or, when the list differs, `Not as sort-speed.`: the copy's contract then names its own servers, so its hash is its own. **Use the servers of sort-speed again** puts the campaign's list back.
   - **A hill-climb or goal campaign.** The panel shows its kit's servers, read only, such as `gbrain for the workers` and `All its 31 tools.`: they are in the kit's kit.json, which a copy does not change.

   Under **The same over REST, MCP and the command line**, the panel shows the same request for a script or an agent: see [Copy from a script or an agent](#copy-from-a-script-or-an-agent).
4. Press **Copy**. The copy's page opens, with `Copied sort-speed version 2 as sort-speed-model-b.` at the top, then `Copied from sort-speed version 2 by you, just now. Its folder in the knowledge base started empty.` and `Saved on control, with no run yet.` A copy of a research campaign whose servers differ adds `Its agents use other MCP servers than its source's:` and the list.
5. For the other model, go back to the campaign and copy it again, such as to `sort-speed-model-a`. If the campaign has no runs yet, you can also run it as it is for the first model.
6. Give each rig its model, on its **Edit rig** page, or under **The agents' model** in the next step: see [When the rig doesn't have the model yet](#when-the-rig-doesnt-have-the-model-yet).
7. On each copy's page, press **Start a run of sort-speed-model-b** (or **Start a run** at the top), choose the copy's own rig under **Where it runs**, and press **Start the run**, as [Start a run later](#start-a-run-later) says.

Don't let one copy read the other's folder: leave **Can read from** empty on each copy's page.

To tell it worked, open each copy's page: on **Campaigns** once its run reports, or at its address, `/ui/campaigns/sort-speed-model-b`. It says where the copy came from, such as `Copied from sort-speed version 2 by you, 5m ago. Its folder in the knowledge base started empty.`, or `Copied from sort-speed as assigned for sort-speed-1 on rig-1 by you, …` for a campaign that was only assigned before. A copy made with the operator's token over MCP says `by the operator`. Its **Knowledge** section counts only its own run's records, and **Can read from** says `None: its agents read only this campaign's folder.` Then compare the two runs' results on their pages.

### When the panel refuses

The panel says why under the name, or under the servers, and **Copy** stays off:

| The panel says | What to do |
| --- | --- |
| `There is a campaign named sort-speed-b already. Choose another name.` | Type another name. A name is taken when control keeps a campaign by it, a rig reported a run of it, or the knowledge base has a folder or a grant by it. For a name only the knowledge base has, the panel adds `It has no runs now, but its folder is in the knowledge base.` |
| `A campaign's name is lowercase letters, digits, dots, dashes and underscores, at most 64. It starts with a letter or a digit.` | Press the button beside it, such as **Use sort-speed-b**, for a valid name made from yours, or type another |
| `A name that starts with rig-check- is for rig checks. Choose another name.` | Type another name: [rig checks](../../reference/rig-checks.md) use these names |
| `Choose the agents that get paper-search, or untick it.` | A research copy: tick **Workers** or **Advisors** for the server, or untick the server |
| `The workers get no tool of paper-search: give them one, or untick workers.` | A research copy: tick a tool for them under **Advanced**, or untick **Workers** for that server |

Control checks the copy again when you press **Copy**, with the same words. If it refuses, for example because another copy took the name after the panel opened, the panel opens again with **Not copied.** and the reason, and control saves nothing. Without the page's script, the panel posts all the same and shows control's answer the same way.

### Copy from a script or an agent

**Copy** has twins on the command line, the REST API and MCP, which take the owner's token (MCP also an operator's) and give the same refusals:

```sh
npx thermite campaign copy sort-speed sort-speed-model-a \
  --control http://127.0.0.1:8800 --token-file .dev/secrets/control-admin-token
npx thermite run start sort-speed-model-a --rig rig-1 \
  --control http://127.0.0.1:8800 --token-file .dev/secrets/control-admin-token
```

The first command prints the copy, such as `{"campaign":"sort-speed-model-a","version":1,"contract_sha":"<sha256>","from":{"campaign":"sort-speed","version":2}}`; the second starts a run of it. Over REST it is `POST /v1/campaigns/sort-speed/copy` with `{"name": "sort-speed-model-a"}`. Over MCP it is [`copy_campaign`](../../reference/mcp-tools.md#copy_campaign) with `{"from": "sort-speed", "name": "sort-speed-model-a"}`. A research copy's other servers are `mcp_servers` there, or `--mcp-servers-json` on the command line: see [`campaign copy`](../../reference/command-line.md#campaign-copy).
