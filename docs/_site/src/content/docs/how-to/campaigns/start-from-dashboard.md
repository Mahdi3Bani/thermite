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
- For agents to work, the rig needs a model from a provider in **Settings › Providers**: see [Connect a model provider](../models/connect-a-provider.md). You can give the rig one in step 4. The page won't start agents on a rig without a model; **Try the kit first** and **Save without starting** work without one.
- If the model uses a paid API key, set **Stop after (hours)** in step 4 under **Advanced**. See [Set a budget or a stop time](budget-and-stop-time.md).

## 1. Aim

Open **Campaigns** and press **New campaign**. The page shows the steps **1 Aim**, **2 Project**, **3 How to measure** (**3 The question** for research), **4 Where it runs** and **5 Review and start**. Move with **Next** and **Back**. Hover over the "i" beside a field to read what it means.

Choose a card. [Campaign modes](../../explanation/campaign-modes.md) explains each.

| Card | Use it to |
| --- | --- |
| **Hillclimbing** | Improve one measured number, such as speed, size or accuracy |
| **Reach a list of goals** | Work until checks you write all pass |
| **Research a question** | Collect sourced findings. No code changes |

Fill in **Campaign name** (lowercase letters, digits, dots and dashes, such as `sort-speed`) and **Title** (one sentence; agents read it too). Runs are named after the campaign: `sort-speed-1`, `sort-speed-2`. Using a name again saves a new version of that campaign: runs that exist keep their version, and later runs use the new one. This is how you change a campaign made here, such as its stop time: fill in the page again with the same name. The page starts empty each time.

## 2. Project

Research campaigns skip this step.

| Field | What to enter |
| --- | --- |
| **Repository** | The project's address, such as `https://git.example.com/you/project.git`. Rigs fetch it themselves. Thermite never pushes to it |
| **Start from** | A branch, a tag or a full commit. Empty: the default branch. Control pins it to one commit, so every run starts from the same code |
| **Repository access** | **Public: no key**, or a Git access from **Settings** |
| **Files the agents may change** | Patterns, one per line, such as `src/**`. A change to any other file is refused before it is built |
| **Lines never allowed** (under **Advanced**) | Regular expressions, one per line, such as `clock_gettime`. A change that adds a matching line is refused |

Press **Look it up**. Control reads the repository's file names, not their contents, and shows a line such as `Found: main is at 1a2b3c4 · 214 files. Rigs fetch it from there.` with a few folders as buttons. Press a folder to add it to **Files the agents may change**. If you skip **Look it up**, control looks the commit up when you start.

:::caution
- Without Git access, control reads only `https://` addresses. Others give `the repository must be an https:// URL, or choose Git access for a private one`.
- A private repository without access gives `control cannot read it without a key: is the repository private?`
- If you change **Repository** or **Start from** after **Look it up**, press it again: the page keeps the commit it found first.
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

For a goal campaign, do only step 3, without **The kit's metric**. Control doesn't open this kit: the rig checks it when the run starts.

### Upload a kit

Choose the file under **Kit archive**. It holds `kit.json` at its top or inside one folder, and has at most 2000 files, 64 MB in all, and no links. From a kit kept in git, `git archive --format=tar.gz -o kit.tar.gz HEAD` makes one. A `tar` of a folder made on a Mac adds hidden `._` files, which give `the archive has no kit.json at its top`. Control checks `kit.json` and shows a line such as `smoke-cpu: measures on cpu, 3 cases, scores flops_per_s.` Nothing in the kit runs until a run starts.

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

### The question

For research, step 3 asks for **Topic** (a sentence), **Questions** (one per line, up to 50; the report counts the verified claims for each), **Starting links** (pages agents start from, one per line) and **Run for at least**, such as `8h` or `2d`. The run ends after that much running time.

## 4. Where it runs

Choose the rig. Each card shows its hardware, whether it is idle, and its agents' model after `agents:`, or `no model for its agents yet` in red. A rig that is not reporting can't be chosen.

| Field | What it does |
| --- | --- |
| **Agents working at once** | 1 to 4 (2 unless changed). Despite its name, it sets how many [lanes](../../reference/glossary.md) the planner plans, not how many agents work at once. See the caution below |
| **The agents' model** | **the rig's model** (the default) keeps the model the rig has. Or choose one of the models in **Providers**, listed by provider. It becomes the rig's model for every run on that rig, as on its **Edit rig** page. See the note below |
| **The agents run in** | The [worker harness](../../reference/glossary.md), the program that runs the agents, for the model you chose: **what the model needs** (the default: OpenCode v2 for OpenCode's free models, Claude Code for a Claude subscription, else Pi), **OpenCode v2** or **Pi** |
| **When a change is confirmed better** | **the rig's default**: the choice on the rig's **Edit rig** page, **Automatically** unless changed. Or **always keep it**, or **ask me every time**. See [Decide what waits for you](decide-what-waits.md#promotions) |

:::note[A model the rig doesn't have yet]
The rig takes a model you choose here within a minute, and checks it. Until then its agents could not work, so **Start the campaign** saves the campaign without starting it. The campaign's page says `Saved. rig-1 takes <model> within a minute. When the rig shows it, start the run here.` Keep that page's address: the **Campaigns** list shows the campaign only once a rig reports a run of it. When the rig's row under **Harness and model for each rig** on **Settings › Providers** says `Its agents run under` the harness `with` that model, come back to the campaign's page and press **Start the run** on its **Start a run** card. A model the rig already has starts the run at once.
:::

:::caution[How many agents work at once]
The rig's **Workers at a time** decides it: on **Rigs**, open the rig, press **Edit rig**, and find it in the **Workers (agents)** row. It is 1 unless changed, so with the defaults the two lanes take turns, one trial at a time. Raise it for agents to work side by side ([goal 061](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/061-gaps-found-by-the-docs.goal)). The summary at **5 Review and start** counts lanes as agents too.
:::

Under **Advanced**:

| Field | What it does |
| --- | --- |
| **One try lasts (minutes)** | How long an agent works on one idea, in one [trial](../../reference/glossary.md), 1 to 1440. Empty: the rig's default, 20 unless changed |
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

:::caution[Keep the address of a campaign you save without starting]
The **Campaigns** list shows a campaign only once a rig reports a run of it. A campaign saved without starting, or whose first run failed to start, is not on the list. Its page is at `/ui/campaigns/<name>`, such as `http://127.0.0.1:8800/ui/campaigns/sort-speed`: keep that address. The page has a **Start a run** card ([goal 061](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/061-gaps-found-by-the-docs.goal)).
:::

## Check that it started

- After **Start the campaign** or **Try the kit first**, the campaign's page says, for example, `Starting rig-1/sort-speed-1.` Wait a minute and press **refresh** in the status bar, the line along the bottom of the page: pages don't reload by themselves. The run then shows with its **Overview**, **Attempts**, **History** and **Steering** views.
- A try's run is named like `sort-speed-try-1`, and its page says **A try of the kit.** When its results look right, use the **Start the campaign** card below it with **with agents**, and press **Start the run**. A rig runs one run at a time, so the new run pauses the try.
- After **Save without starting**, the page says `Saved, with no run yet.` and offers **Start a run**.
- If the page comes back at **Review and start** with **Not started: fix these first.**, fix each item in the list. Everything you typed is kept. A kit described here or uploaded is checked against the campaign here, before anything is saved. The items about the agents' model are:
  - `rig-1 has no model for its agents, so they could not work: choose one under "The agents' model".`
  - `OpenCode's free models run only in the OpenCode harness: choose OpenCode v2 for this rig.` Choose **OpenCode v2** or **what the model needs** under **The agents run in**.
  - For research, with one of OpenCode's free models and the agents in Pi: `… is one of OpenCode's free models, which work only inside OpenCode, and rig-1's agents would run in Pi: a research run there could not work. Set the agents' harness to OpenCode, or give the rig a model Pi can use.` Choose **OpenCode v2** under **The agents run in**, or another model.
- If the run never shows, open **Commands** in the sidebar. The newest **assign campaign** row is **failed**, with the reason.

| The reason starts with | What to do |
| --- | --- |
| `staging:` | The rig could not fetch the project or the kit: the reason names the address, such as `staging: https://git.example.com/you/project.git has no commit …`, or gives git's own error. Check that the address works from the rig and that the commit is pushed there. For a private repository, use **Try it** on its Git access: see [Use a private repository](private-repository.md#5-check-that-the-rig-fetched-it). |
| `the kit does not fit the contract:` | A kit in a repository lacks a case, metric or verifier that the page named, or measures on another target. Each problem is named, such as `cells names cell large, which the kit does not have`. Correct the names, or commit the kit again and use its new **Kit commit**. |

When nothing in the campaign must change, such as after you fixed the repository's access, the **Start a run** card on the campaign's page starts the same version again. Otherwise fill in the **New campaign** page again with the same **Campaign name** and press **Start the campaign**: this saves a new version and starts it.

## Start another run later

The campaign's page has a **Start another run** card. Choose the **Rig** (rigs with other hardware are greyed out), **Agents**, **When a change is confirmed better** and **GPUs for the judge**, then press **Start the run**. It runs the latest saved version. See [Run a campaign on several rigs](several-rigs.md).

This card has no model field. On a rig whose agents have no model, it refuses with `rig-1 has no model for its agents, so they could not work: give it one on its Edit rig page first.`, also for a try of the kit. For a research campaign, it refuses a rig whose agents would run OpenCode's free models in Pi, with the message above.
