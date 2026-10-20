---
title: "Hand the work to agents"
description: "Give your rig a free AI model, start a campaign, and watch agents propose changes that the judge measures."
type: tutorial
sidebar:
  order: 2
---

In this tutorial you give your rig a free AI model, then start a campaign in which AI agents try to make a small program faster. You watch an agent work, and you watch the judge decide on every change it submits.

At the end you'll have seen Thermite's whole loop: agents propose, the judge measures, and only a change that is confirmed better can become the new best version.

It takes half an hour to an hour, most of it waiting. An agent may work for up to 20 minutes on one thing to try, and the judge then measures what it made. New words are explained as they come, and the [glossary](../reference/glossary.md) has them all.

## What you need

- Everything from [Your first run](first-run.md): Thermite running on your computer, the dashboard signed in, and **Judge smoke** passed on `local-1`. The smoke check left the smoke project and its kit on the rig, and this tutorial uses them.
- **Node.js** 22.19 or later, and **git**, for Thermite's command line (step 4).
- An internet connection. The free models run on OpenCode's own service. You need no account and no key. The model sees the code the agents read, which here is only the smoke project.
- A look at [Known limits](../reference/known-limits.md), if you haven't read it yet. From this tutorial on, agents run the code that a model writes, on your computer.

## 1. Add OpenCode as a model provider

A **provider** is where your agents' models come from. OpenCode is a program that runs coding agents, and its service offers some models for free.

1. Press the cog icon at the foot of the sidebar, beside **Sign out**. Its tooltip says **Settings**. It opens the **Providers** page, whose heading reads `Settings › Providers`.
2. Under **Add a provider**, set:
   - **Type**: **OpenCode (its own models)**
   - **Name**: `opencode`
   - **Base URL** and **API key**: leave them empty.
3. Press **Add and list its models**.

A green line says `"opencode" is saved and lists` a number of models, then `Choose one for a rig below.` The new row, **opencode · OpenCode**, shows **no key: its free models** and **runs in the OpenCode harness**.

## 2. Give the rig a free model

Find **Harness and model for each rig** at the bottom of the page. The row for `local-1` says `Its agents have no model: they wait.`

1. In its first list, choose **OpenCode v2**. This is the **worker harness**: the program the agents work in. (It is not the rig's `harness` container, which runs it.) OpenCode's free models run only in OpenCode's own program.
2. In its second list, under **opencode (OpenCode harness only)**, choose the first model whose name ends in `-free`. Those are the models OpenCode serves without a key. OpenCode decides which they are, and the list changes over time.
3. Press **Use**.

A green line says that `local-1` takes your model from `"opencode"` under OpenCode v2 within a minute, and checks it.

## 3. Check that the model works

The rig checks a new model by itself. It asks the model, through the worker harness, to run one command, and the answer must come back as a correct tool call. That is how agents work: by calling tools.

Wait a minute or two, then press **refresh** in the status bar along the bottom of the page. The row for `local-1` now says that its agents run under OpenCode v2 with your model from `opencode`, and below that:

`Its model check passed … ago:` your model's name, then `answered with a correct tool call in` some seconds `(OpenCode)`.

If it says **FAILED** instead, the rest of the sentence says why, such as `Rate limit exceeded. Please try again later.` when the free model is busy, or `Model unavailable:` and the model's name when OpenCode no longer serves it, though its list still names it. Choose another model whose name ends in `-free`, press **Use**, and wait again. It can take a few tries to find one that answers. **Check** runs the check again at any time.

The rig's own page shows the same result: open **Rigs**, then `local-1`, and under **Checks**, **Model route** says **passed**, with the same sentence.

## 4. Install Thermite's command line

You start this campaign from the command line. It comes with Thermite's source code, and you build it once, in a folder of its own beside your `thermite` folder. This step needs **Node.js** 22.19 or later and **git**.

1. Go to the folder that holds your `thermite` folder. Get the source code of your Thermite version, and build its command line:

   ```sh
   cd ..
   git clone --branch v0.1.0 https://github.com/iammrduncan/thermite.git thermite-source
   cd thermite-source
   npm ci
   npm run build
   ```

   `v0.1.0` is the release your `compose.yaml` names in its first line, `# Thermite 0.1.0`. If yours names another one, put a `v` before it and use it in place of `v0.1.0`.

2. Link your tokens into the new folder, so the command line finds them where this page says:

   ```sh
   ln -s ../thermite/.dev .dev
   ```

3. Check that the command line runs:

   ```sh
   npx thermite help
   ```

   It prints `usage: thermite <command> [options]`, then a list of commands.

From now on, run `npx thermite` in your `thermite-source` folder; [Command line](../reference/command-line.md) describes every command. The `docker compose` commands still run in your `thermite` folder.

## 5. Write the campaign's contract

A **contract** says what a campaign must achieve and how the judge decides. Save this as `contract.json` in the `thermite-source` folder:

```json title="contract.json"
{
  "schema_version": 1,
  "campaign": "smoke-agents",
  "version": 1,
  "title": "Make the smoke project's matrix multiply faster",
  "mode": "hill_climb",
  "project": {
    "repo": "smoke-cpu-project",
    "commit": "460b3b7cd3ce1bfc55fc885ac190f2bad8ce9e7b",
    "kit": { "repo": "smoke-cpu-kit", "commit": "69c3d2f6db63a51e77b6a794a02a14c8b07eeb4e" }
  },
  "target": { "type": "cpu", "class": "generic-cpu" },
  "lanes": { "count": 1, "trials_per_epoch": 3 },
  "objective": {
    "primary": { "metric": "flops_per_s", "direction": "max", "min_effect": 0.1 }
  },
  "cells": ["small", "large"],
  "held_out_cells": ["held"],
  "editable_paths": ["src/kernel/**"],
  "forbidden_patterns": [
    "clock_gettime",
    "gettimeofday",
    "\\brdtsc",
    "\\btimes\\s*\\(",
    "__real_",
    "__wrap_",
    "thermite_ref_calls"
  ],
  "acceptance": {
    "equivalence_band": 0.05,
    "runs_per_cell": 3,
    "audit": { "ratio_to_median": 1000, "absolute": 1000 }
  }
}
```

You don't need every line. What matters here:

- `project`: the smoke project and its **kit**, the judge's recipe for building, running and checking it. Each is pinned to the exact commit that the smoke check made from files in Thermite's image. The same files always make the same commits, so your `thermite-source` folder, at the same version as your images, holds the commits your own rig has: the file `examples/contracts/smoke-cpu-goal.json` names them in its `project` block. The kit's commit also starts the name of the smoke check's campaign in [Your first run](first-run.md), such as `rig-check-smoke-cpu-69c3d2f6`. If either commit differs from the ones above, copy the `project` block from `examples/contracts/smoke-cpu-goal.json` into your `contract.json`.
- `objective`: make `flops_per_s`, the matrix multiply's speed, higher. A change must be at least 10% faster (`min_effect` is 0.1) to count.
- `cells`: the kit's test cases, which the dashboard calls cases. The judge measures every change on `small` and `large`, and keeps `held` back as a hidden test, run only to double-check a change that already looks better.
- `editable_paths` and `forbidden_patterns`: the agent may change only files in `src/kernel/`, and may not add a line that matches one of these patterns, such as a call to a timer. A change that breaks either rule is refused before it is built.
- `lanes`: one **lane**, a line of search worked by one agent at a time. The **planner**, an agent that decides what each lane tries, plans in rounds, which the contract calls **epochs** and the dashboard calls rounds. In each round the lane gets three **trials** (`trials_per_epoch`): three goes by its agent, each at one thing to try. Step 7 shows them at work.

The other fields give the file's format (`schema_version`), the campaign's name and version, the kind of machine it runs on (`target`), and how carefully the judge measures (`acceptance`). [Contract](../reference/contract.md) explains every field.

Check the file with Thermite's own rules:

```sh
npx thermite contract validate contract.json
```

It prints `ok hill_climb smoke-agents v1 sha256=` and a long hash.

## 6. Start the campaign

Send the campaign to your rig:

```sh
npx thermite assign --contract contract.json --run smoke-agents-1 \
  --control http://127.0.0.1:8800 --token-file .dev/secrets/control-admin-token --rig local-1
```

`--token-file` names the file that holds your owner's token, the one you signed in with. The command prints `{"id":"…","status":"pending"}`. Control has signed a command for the rig. Within seconds the rig takes it and starts a **run**: this campaign at work on `local-1`.

The command sets no `--promotion`, so the run follows the rig's own rule. On `local-1` that rule is automatic: a change the judge confirms becomes the best version without waiting for you, unless it is held for a second look (see step 8).

Open **Campaigns** in the sidebar. After a minute, press **refresh**. Under **At work now**, a card shows `smoke-agents › smoke-agents-1`, on `local-1`: the campaign, then its run. Under **All campaigns**, the row `smoke-agents` shows your contract's title, `Make the smoke project's matrix multiply faster`, and `1 at work` under **Runs**.

For the first few minutes, while the planner works, the card's `lanes` line says `waiting for the first round`. `lane-1` takes its place once the planner has given the lane its work.

:::tip[If the run does not appear]
Open **Commands** in the sidebar. The `assign campaign` line shows **failed**, and its outcome says why. If it says that a kit commit or a seed commit (the project commit a run starts from) is not in `smoke-cpu-kit` or `smoke-cpu-project`, there are two causes:

- The smoke check has not run on this rig. Run **Judge smoke** (step 6 of [Your first run](first-run.md)), then the same command again.
- Your version of Thermite makes other commits than the ones on this page. Copy the `project` block from `examples/contracts/smoke-cpu-goal.json` in your `thermite-source` folder into `contract.json`, as step 5 says, then run the command again.
:::

## 7. Watch the agent work

Open **Live** in the sidebar. It shows the run at work, `smoke-agents-1`. The list on its left, **At work**, holds every run at work: here, only this one. In a narrow window that list is hidden, and **☰** in the header shows it. In the header above the lines, the run's name is followed by **Running**, then `local-1` (the rig) and how the run stands: its round and its gain so far. On the right are the buttons **Open the run**, **Pause** and **⋯**, which holds **Restart the lanes**.

Under the header is a row of filters, which choose whose lines you see:

- **Everyone** is chosen at first, and shows every line.
- **lane-1** is the agent itself. Its filter appears only when the planner has given the lane its work, a few minutes in. The agent gets a fresh copy of the project, works on the one thing the planner gave it to try, and ends by submitting its change. This is one **trial**, and it lasts at most 20 minutes.
- **Planner** works first. Before each round of work, it reads what has happened so far and gives each lane an **experiment**: one thing to try. It takes experiments from the run's **queue**, the list of what to try next, and adds new ones of its own.
- **Judge** is the code that measures each change. It is not an agent, and takes no messages.
- **Advisors** shows the rig's advisors, models that review the work, and **You** shows your own messages. You won't need them here.

When the planner is done, a few minutes after the run starts, the planner's line says `round 1:` and how it planned, and the lane's first trial begins. A **lane-1** filter appears with its first line. Choose **lane-1**. Its trial starts with the line `lane-1 · trial started`, followed by the experiment it was given: its direction (the kind of change), then what to try, such as `optimization, Kernel micro-interleaving for flops_per_s (from the champion, seq 1)`. Each line after that is one step: a command the agent ran, or a file it read or wrote, with what came back. Most agents look around the project and read `src/kernel/matmul.c`, then change it, build it and try it.

New lines come in by themselves, at the bottom: the newest line is the last. **↓ Follow**, on the right above the lines, keeps the newest line in view; press it to stop following, so you can read further up. The rest of this page, like every other page, needs **refresh**. After a **refresh**, a green dot on **lane-1** means it is working.

The box under the lines sends the agents a message, and its grey text says when they would read it. You won't need it here: see [Steer a run](../how-to/campaigns/steer-a-run.md).

## 8. Watch the judge decide

The first change takes a while. The planner works for a few minutes, a trial can last up to 20 minutes, and the judge then needs a minute or more to measure what it made. Expect the first verdict between 5 and 30 minutes after the run starts, depending on how fast the model works.

When the agent submits its change, the judge takes over. Open **Overview** in the sidebar and look at **What happened**, newest first. You see `lane-1 submitted` with the agent's description of its change, then the judge screening it: building it and measuring it against the champion. The **champion** is the best version so far. At the start it is the project as it was: champion #1.

Then open **Campaigns**, and on the card under **At work now**, choose `smoke-agents › smoke-agents-1`. The run's page opens. Its title, `smoke-agents-1`, is followed by `on local-1 · hill climb · Running`. On the right of the header are the buttons **Live**, **Message**, **Pause** and **⋯**. Below the header are the run's tabs: **Overview**, **Experiments**, **Journal**, **Attempts**, **History** and **Planner**.

Choose **Experiments**. It shows the run's queue of experiments. Three of its parts matter here:

- **Up next**: the experiments that wait for a lane, in order. It starts with a form to add an experiment, and the waiting experiments are below it. The planner fills it as it plans, so it may be empty: `Nothing queued.`
- **In progress**: what `lane-1` works on now, while its trial runs.
- **Tried**: every experiment that has ended, newest first, with its result. For a trial that submitted a change, the result is its attempt and a word for how the judge decided it, as in the table below.

The card **Ideas from the lanes** holds what an agent proposes beyond its own experiment; it is usually empty. You can add, reorder and drop experiments yourself, and queue or drop the lanes' ideas. You don't need to here: [Choose what a run tries next](../how-to/campaigns/choose-what-runs-next.md) says how.

The next tab, **Journal**, holds the agents' **field notes**: what they observe, the decisions they make and why, and what they learn, written as they work. Later runs can read them: see [Use past research in a new run](../how-to/campaigns/use-past-research.md).

Choose **Attempts**. Each change the agent submitted is an **attempt**, with one word for how it ended. The word sums up the judge's verdict, as in [Your first run](first-run.md#7-see-what-the-judge-decided):

| You see | It means |
| --- | --- |
| **Judging** | The judge is still measuring it |
| **Lost** | Not faster, not faster by 10%, or its gain did not hold up when measured again |
| **Unclear** | The measurements could not tell, or the rig failed while measuring it |
| **Broken** | It did not build, gave wrong answers, or crashed |
| **Judging**, with `rejected v0` under the change | It broke a rule of the contract, and was refused before it was built. It never gets a verdict, so the word stays **Judging**: a known fault ([goal 061](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/061-gaps-found-by-the-docs.goal)) |
| **Needs you** | It was confirmed faster, and waits for your decision |
| **Declined** | You rejected it |
| **Champion #2** | It was confirmed faster on fresh runs and became the new best version |

[Outcome words on the dashboard](../reference/verdicts.md#outcome-words-on-the-dashboard) lists every word. Open an attempt to read the judge's reasons. Not every experiment works, and that is normal: the agent's next trial reads the judge's reasons for its last attempts and tries again. When a change is confirmed faster and nothing holds it, it becomes **champion #2**, every later trial starts from it, and the **Champions** chart on the run's **Overview** tab shows the gain.

:::tip[Nothing yet after half an hour?]
- On **Live**, choose **lane-1**. If it has its green dot and new lines keep coming, the agent is still on its experiment: wait.
- In **What happened**, a line that says `lane-1's trial` … `ended without a submission` gives the reason. A free model is sometimes busy: `Rate limit exceeded. Please try again later.` The next trial tries again. If every trial ends this way, give the rig another model whose name ends in `-free`, as in step 2, or pause the run (step 9) and resume it later.
- If **What happened** says that the planner planned a round `(by the fixed rules: the model gave no usable plan, because` and a reason, the model could not plan that round, often because a free model was busy. The lane then takes the next experiment in the queue, or a new one that the fixed rules add when the queue is empty. The next round asks the model again.
:::

### If a change waits for you

A confirmed change waits for you only when it needs a second look. That happens when its agent wrote down problems it knows the change has, or when the gain is so large that the contract asks for an audit. This contract's `audit` limits are so high that a gain's size almost never holds a change: `absolute` 1000 holds only a gain of more than 1000 times (100,000%), where the default, 0.15, holds any gain above 15%. If no change waits, you see **Champion #2** in the list instead, and **Needs you** stays empty: skip to step 9. If after an hour you see only **Lost**, **Unclear** or **Broken**, that is normal for a small model: go on to step 9.

An **auditor**, a model that gives such second looks, isn't set up on this rig, so the decision is yours. **What happened** says that the change `is held for an audit`, the first line of **Overview** in the sidebar says `1 needs you`, and **Needs you** shows **Your decision** with the question `Make this change the new champion?`.

1. Open it. It shows what the agent says it did, the problems it wrote, and what the judge measured. Read the problems: they are why the change waits. Some matter, such as a change that only wins because of how the benchmark calls it; some don't, such as a little more memory.
2. For this tutorial, press **Reject it**, to see what happens to a change you decline. In [Your own project](your-own-project.md) you make a change the champion instead. [Decide what waits for you](../how-to/campaigns/decide-what-waits.md) explains each choice.

The item says `You selected Reject it`. After a **refresh**, **What happened** says `You declined` the change: `it will not become the champion.` The attempt now shows **Declined**.

## 9. Pause the campaign

A hill climb never ends by itself, and Thermite sets no time limit unless you ask for one: see [Why Thermite runs until the job is done](../explanation/runs-until-done.md). When you have seen enough, open the run's page: **Campaigns**, then `smoke-agents › smoke-agents-1` on the card under **At work now**. In the page's header, press **Pause**, just right of **Message**. A small menu opens. It says that the lanes' running trials stop, and that the run's jobs waiting for the judge wait until you resume. In its field **why (optional)**, type `seen enough for now`, then press **Pause the run**.

A line at the top of the page says that control sent the command to `local-1`. If `lane-1` was in a trial, the trial stops, and a copy of its experiment goes back to the top of **Up next**, to be tried again when the run resumes. Within a minute, after a **refresh**, the line under the run's name ends `· Paused`, and the button says **Resume**. On the run's **Overview** tab, the **Now** block says `This run is paused: seen enough for now. Nothing new starts until it is resumed.`

The rig keeps its model. [Your own project](your-own-project.md) uses it.

## What you did

You gave a rig a free model and checked it, wrote a contract, and started a campaign from the command line. Then you watched an agent propose changes while the judge measured each one. Only a change the judge confirmed could become the champion.

## Next

- [Your first goal campaign](first-goal-campaign.md): a campaign that ends by itself when its goal is met. It needs no model.
- [Agents, lanes and the planner](../explanation/agents-lanes-planner.md): how the planner and the workers share the work.
- [Why agents never judge](../explanation/why-agents-never-judge.md): how the judge decides, step by step.
- [Choose a model](../how-to/models/choose-a-model.md): other free and paid models, and models on your own machine.
- [Verdicts and states](../reference/verdicts.md): every verdict the judge can give.
