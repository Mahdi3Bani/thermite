---
title: "Hand the work to agents"
description: "Give your rig a free AI model, start a campaign, and watch agents propose changes that the judge measures."
type: tutorial
sidebar:
  order: 2
---

In this tutorial you give your rig a free AI model, then start a campaign in which AI agents try to make a small program faster. You watch an agent work, and you watch the judge decide on every change it submits.

At the end you'll have seen Thermite's whole loop: agents propose, the judge measures, and only a change that is confirmed better can become the new best version.

It takes half an hour to an hour, most of it waiting. An agent may work on one idea for up to 20 minutes, and the judge then measures what it made. New words are explained as they come, and the [glossary](../reference/glossary.md) has them all.

## What you need

- Everything from [Your first run](first-run.md): Thermite running on your computer, the dashboard signed in, and **Judge smoke** passed on `local-1`. The smoke check left the smoke project and its kit on the rig, and this tutorial uses them.
- An internet connection. The free models run on OpenCode's own service. You need no account and no key. The model sees the code the agents read, which here is only the smoke project.

## 1. Add OpenCode as a model provider

A **provider** is where your agents' models come from. OpenCode is a program that runs coding agents, and its service offers some models for free.

1. Press the cog icon at the foot of the sidebar. It is labelled **Settings**, and it opens the **Providers** page.
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

If it says **FAILED** instead, the rest of the sentence says why. A free model is sometimes busy: choose another model whose name ends in `-free`, press **Use**, and wait again. **Check** runs the check again at any time.

## 4. Install Thermite's command line

You start this campaign from the command line. In the `thermite` folder from [Your first run](first-run.md), install Thermite's packages and build it:

```sh
npm ci
npm run build
```

Then check that the command line runs:

```sh
npx thermite help
```

It prints `usage: thermite <command> [options]`, then a list of commands. Run `npx thermite` in your `thermite` folder like this from now on; [Command line](../reference/command-line.md) describes every command.

## 5. Write the campaign's contract

A **contract** says what a campaign must achieve and how the judge decides. Save this as `contract.json` in the `thermite` folder:

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

- `project`: the smoke project and its **kit**, the judge's recipe for building, running and checking it. Each is pinned to the exact commit that the smoke check made from files in Thermite's image, so the commits are the same on every rig built from the same version of Thermite as this page. The kit's commit starts with `69c3d2f6`, like the name of the smoke check's campaign in [Your first run](first-run.md).
- `objective`: make `flops_per_s`, the matrix multiply's speed, higher. A change must be at least 10% faster (`min_effect` is 0.1) to count.
- `cells`: the kit's test cases, which the dashboard calls cases. The judge measures every change on `small` and `large`, and keeps `held` back as a hidden test, run only to double-check a change that already looks better.
- `editable_paths` and `forbidden_patterns`: the agent may change only files in `src/kernel/`, and may not add a line that matches one of these patterns, such as a call to a timer. A change that breaks either rule is refused before it is built.
- `lanes`: one **lane**, a line of search worked by one agent at a time. The planner plans in rounds called **epochs**, and in each one the lane gets three trials (`trials_per_epoch`).

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

Open **Campaigns** in the sidebar. After a minute, press **refresh**: the campaign `smoke-agents` is there, with its run `smoke-agents-1` under it and the state **Running**.

:::tip[If the run does not appear]
Open **Commands** in the sidebar. The `assign campaign` line shows **failed**, and its outcome says why. If it says that a kit commit or a seed commit (the project commit a run starts from) is not in `smoke-cpu-kit` or `smoke-cpu-project`, the smoke check has not run on this rig. Run **Judge smoke** (step 6 of [Your first run](first-run.md)), then the same command again.
:::

## 7. Watch the agent work

Open **Live** in the sidebar, then **local-1**. The header shows your agents: **OpenCode v2**, your model, and `(from opencode)`. On the left, **Sessions** lists **Everything** and a line for each part at work:

- **Planner** works first. Before each round of work, it reads what has happened so far and gives each lane a direction to try.
- **Worker · lane-1** is the agent itself. It gets a fresh copy of the project, works on one idea, and ends by submitting its change. This is one **trial**, and it lasts at most 20 minutes.
- **Judge** is the code that measures each change. It is not an agent.

The worker's line appears when the planner is done, a few minutes after the run starts. Choose **Worker · lane-1**, marked **working**. Each line is one step: a command the agent ran, or a file it read or wrote, with what came back. Most agents look around the project and read `src/kernel/matmul.c`, then change it, build it and try it. Only Live updates itself; other pages need **refresh**.

The box at the bottom lets you send the agent a message. You won't need it here: see [Steer a run](../how-to/campaigns/steer-a-run.md). Choose **Judge** and the box says why it takes no messages.

## 8. Watch the judge decide

The first change takes a while. The planner works for a few minutes, a trial can last up to 20 minutes, and the judge then needs a few minutes to measure what it made. Expect the first verdict about 15 to 30 minutes after the run starts.

When the worker submits its change, the judge takes over. Open **Overview** and look at **What happened**, newest first. You see `lane-1 submitted` with the agent's description of its change, then the judge screening it: building it and measuring it against the champion. The **champion** is the best version so far. At the start it is the project as it was: champion #1.

Then open **Campaigns** and choose the run `smoke-agents-1`. Its page starts with the line `Run smoke-agents-1`, which holds **Overview**, **Attempts**, **History** and **Steering**, then the **Live** and **Pause** buttons. Choose **Attempts**. Each change the agent submitted is an **attempt**, with one word for how it ended. The word sums up the judge's verdict, as in [Your first run](first-run.md#7-see-what-the-judge-decided):

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

[Outcome words on the dashboard](../reference/verdicts.md#outcome-words-on-the-dashboard) lists every word. Open an attempt to read the judge's reasons. Not every idea works, and that is normal: the agent's next trial reads the judge's reasons for its last attempts and tries again. When a change is confirmed faster and nothing holds it, it becomes **champion #2**, every later trial starts from it, and the run's **Champions** chart shows the gain.

:::tip[Nothing yet after half an hour?]
- On **Live**, choose **Worker · lane-1**. If it is **working** and new lines keep coming, the agent is still on its idea: wait.
- In **What happened**, a line that says `lane-1's trial` … `ended without a submission` gives the reason. A free model is sometimes busy: `Rate limit exceeded. Please try again later.` The next trial tries again. If every trial ends this way, give the rig another model whose name ends in `-free`, as in step 2, or pause the run (step 9) and resume it later.
- If **What happened** says that the planner used `its fallback plan`, the planner's call to the model failed, often because a free model was busy. The run goes on with a simple plan, and the next epoch asks the planner again.
:::

### If a change waits for you

A confirmed change waits for you only when it needs a second look. That happens when its agent wrote down problems it knows the change has, or when the gain is so large that the contract asks for an audit. This contract's `audit` limits are so high that a gain's size almost never holds a change. If no change waits, you see **Champion #2** in the list instead, and **Needs you** stays empty: skip to step 9.

An **auditor**, a model that gives such second looks, isn't set up on this rig, so the decision is yours. **What happened** says that the change `is held for an audit`, the Overview's first line says `1 needs you`, and **Needs you** shows **Your decision** with the question `Make this change the new champion?`.

1. Open it. It shows what the agent says it did, the problems it wrote, and what the judge measured. Read the problems: they are why the change waits. Some matter, such as a change that only wins because of how the benchmark calls it; some don't, such as a little more memory.
2. For this tutorial, press **Reject it**, to see what happens to a change you decline. In [Your own project](your-own-project.md) you make a change the champion instead. [Decide what waits for you](../how-to/campaigns/decide-what-waits.md) explains each choice.

The item says `You selected Reject it`. After a **refresh**, **What happened** says `You declined` the change: `it will not become the champion.` The attempt now shows **Declined**.

## 9. Pause the campaign

A hill climb never ends by itself, and Thermite sets no time limit unless you ask for one: see [Why Thermite runs until the job is done](../explanation/runs-until-done.md). When you have seen enough, open the run's page (**Campaigns**, then the run `smoke-agents-1`). In the line `Run smoke-agents-1` at the top, press **Pause**, just right of the **Live** button. Within a minute, after a **refresh**, the run shows **Paused**, the button says **Resume**, and the page says `Nothing new starts until it is resumed.`

The rig keeps its model. [Your own project](your-own-project.md) uses it.

## What you did

You gave a rig a free model and checked it, wrote a contract, and started a campaign from the command line. Then you watched an agent propose changes while the judge measured each one. Only a change the judge confirmed could become the champion.

## Next

- [Your first goal campaign](first-goal-campaign.md): a campaign that ends by itself when its goal is met. It needs no model.
- [Agents, lanes and the planner](../explanation/agents-lanes-planner.md): how the planner and the workers share the work.
- [Why agents never judge](../explanation/why-agents-never-judge.md): how the judge decides, step by step.
- [Choose a model](../how-to/models/choose-a-model.md): other free and paid models, and models on your own machine.
- [Verdicts and states](../reference/verdicts.md): every verdict the judge can give.
