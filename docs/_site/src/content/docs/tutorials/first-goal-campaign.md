---
title: "Your first goal campaign"
description: "Run a goal campaign on the smoke project, submit a change yourself, and watch its goal go from unmet to met until the campaign ends by itself."
type: tutorial
sidebar:
  order: 3
---

In this tutorial you run a **goal campaign**. A hill climb improves a number for as long as you let it; a goal campaign works until a list of goals is met, then ends by itself. You won't need an AI model: you propose the change yourself, and the judge decides whether it meets the goal.

At the end you'll have set a goal from a real measurement, seen it unmet, submitted a change, and watched the judge confirm the goal and close the campaign.

It takes about fifteen minutes. New words are explained as they come, and the [glossary](../reference/glossary.md) has them all.

## What you need

- Everything from [Your first run](first-run.md): Thermite running on your computer, the dashboard signed in, and **Judge smoke** passed on `local-1`. This tutorial uses the smoke project and kit that the smoke check left on the rig.
- A terminal in the `thermite` folder.

A rig works on one run at a time, so starting a run pauses any other run on `local-1`. If you did [Hand the work to agents](agents-with-a-free-model.md), its run stays paused; that is expected.

## 1. Install Thermite's command line

You start the campaign from the command line. If you did [Hand the work to agents](agents-with-a-free-model.md), this is already done, and doing it again is harmless:

```sh
npm ci
npm run build
```

## 2. Read the example contract

A **contract** says what a campaign must achieve and how the judge decides. Thermite comes with one for this tutorial, `examples/contracts/smoke-cpu-goal.json`. Open it in a text editor. It names the smoke project and its kit by their exact commits, the ones the smoke check left on your rig, and lets a change touch only files in `src/kernel/`. Then comes its goal:

```json title="smoke-cpu-goal.json (part)"
"goals": [
  {
    "id": "faster",
    "description": "the large case reaches the speed this goal sets, in floating-point operations a second",
    "verify": {
      "type": "metric_threshold",
      "metric": "flops_per_s",
      "op": ">=",
      "value": 10000000000,
      "cells": ["large"]
    }
  }
]
```

The goal `faster` is met when the program's speed on the kit's `large` case (a **cell** in the contract), `flops_per_s`, is at least `value`. The judge doesn't take one run's word for it: it runs the case five times (`threshold_reps`, which this contract leaves at its default), and the goal is met only when it is sure, with 95% confidence, that the speed is at least the value.

The value here, ten billion operations a second, is deliberately far above what the smoke project does today. A goal must fit the computer it is measured on, so first you measure yours.

## 3. Measure where the project starts

Start a run of the example as it is:

```sh
npx thermite assign --contract examples/contracts/smoke-cpu-goal.json --run goal-start-1 --agents off \
  --control http://127.0.0.1:8800 --token-file .dev/secrets/control-admin-token --rig local-1
```

It prints `{"id":"…","status":"pending"}`. Control has signed a command, and within seconds the rig starts the run `goal-start-1`. `--agents off` means that no agent works on it: only the judge.

The first thing the judge does in a goal campaign is check which goals the project already meets. After a minute or two, open **Campaigns** in the dashboard, press **refresh**, and choose the campaign **smoke-cpu-goal**. Its page shows its one run, `goal-start-1`. The **Goals** block says `0 of 1 met`, and under the goal `faster`, marked **unmet**, a line like this:

```text
flops_per_s >= 10000000000: large: 3.44791e+9 [3.32615e+9, 3.56967e+9]
```

The first number after `large:` is your computer's speed now: here 3.45 × 10⁹, or 3.45 billion operations a second. The two in brackets are the range the judge is 95% sure of. Your numbers will differ: they depend on your processor.

## 4. Set a goal you can reach

The change you will submit makes the large case much faster. You saw it in your first run: the smoke check's winning change was confirmed tens of percent faster. So set the goal a fifth above where the project starts. The starting point can't reach that, and the change can.

1. Copy the example:

   ```sh
   cp examples/contracts/smoke-cpu-goal.json my-goal.json
   ```

2. Open `my-goal.json` in a text editor and change two lines. First, the line `"version": 1` (not `"schema_version"`, which stays 1) becomes:

   ```json title="my-goal.json (part)"
   "version": 2,
   ```

   Then, in the goal, the line `"value": 10000000000` becomes:

   ```json title="my-goal.json (part)"
   "value": 4.2e9,
   ```

   For `value`, multiply your first number from step 3 by 1.2 and round it up. In the example, 3.45 × 10⁹ × 1.2 is about 4.14 × 10⁹, so `4.2e9`. The version goes up because a contract never changes in place: a changed contract is a new version of its campaign.

3. Check the file with Thermite's own rules:

   ```sh
   npx thermite contract validate my-goal.json
   ```

   It prints `ok goal smoke-cpu-goal v2 sha256=` and a long hash.

## 5. Start the goal campaign

```sh
npx thermite assign --contract my-goal.json --run goal-1 --agents off --promotion auto \
  --control http://127.0.0.1:8800 --token-file .dev/secrets/control-admin-token --rig local-1
```

`--promotion auto` lets a change that the judge confirms become the **champion**, the run's best version, without waiting for you.

After a minute, press **refresh** on the campaign's page. It now has two runs. The table at the top shows `goal-start-1` as **paused**, `replaced by goal-1`, because a rig runs one run at a time. Below the table, choose the tab `goal-1`. Its **Goals** block says `0 of 1 met`: the goal `faster` is **unmet**, and its line shows your new value, `4200000000`, above the speed the judge measured.

## 6. Propose a change yourself

The change is the one the smoke check confirmed in your first run: it loops over the matrix in a different order, so the inner loop reads memory in sequence. Thermite's image holds it, with the smoke project.

You submit it from inside the rig's harness container, the way an agent would. The harness has no port open to your computer: only the rig's supervisor reaches it from outside its container.

1. Open a shell in the harness container:

   ```sh
   docker compose exec harness sh     # Docker
   podman compose exec harness sh     # Podman
   ```

   The prompt changes to `#`: you are now inside the container.

2. Make the change as a patch, and submit it to the run `goal-1`:

   ```sh
   rm -rf /tmp/smoke
   cp -r /opt/thermite/checks/examples/smoke-project /tmp/smoke
   cd /tmp/smoke
   git init -q -b main
   git add -A
   cp /opt/thermite/checks/kits/smoke-cpu/candidates/good/src/kernel/matmul.c src/kernel/matmul.c
   git diff > /tmp/good.patch
   thermite submit --harness http://127.0.0.1:8700 --token-file /run/secrets/harness-proposer-token \
     --run goal-1 --patch-file /tmp/good.patch --hypothesis "i-k-j loop order makes the inner loop contiguous"
   ```

   The last command prints a line that starts with `{"attempt":"a-` and goes on with `"lifecycle":"queued"`. Your change is now an **attempt**, waiting for the judge.

3. Leave the container:

   ```sh
   exit
   ```

## 7. Watch the goal be met

It takes about a minute. On the campaign's page, with the tab `goal-1` chosen, press **refresh** after a minute, and again until the run is **Closed**. Under **Recent**, in the run's **Overview**, the story unfolds, newest first; the run's **History** keeps all of it. In order:

1. The judge screens your change: it builds it and checks the goal. It says the change `looked like goal progress; being confirmed on fresh runs`, and `Newly met: faster.`
2. It checks the change again on fresh runs: `confirmed: it meets more goals and loses none`. At the same moment your change `became champion #2`. Champion #1 was the project as it started.
3. The judge checks the goals of the new champion: `1 of 1 goals met, every required goal`.
4. It checks them a second time, because ending a campaign is final and one check is not enough. Then: `Every required goal is met: the campaign is complete.`

The run's state is now **Closed**, and the **Goals** block says `1 of 1 met`, with a ✓ beside `faster`. Under **Campaigns**, the campaign says `Its best run meets 1 of 1 goals.` Nothing more runs: a goal campaign stops once its goals are met.

## What you did

You measured where a project starts, set a goal the judge can check, and saw it unmet. Then you submitted a change from inside the rig, and watched the judge screen it, confirm it, make it the champion, check the goals twice and close the campaign by itself.

## Next

- [Your own project](your-own-project.md): give Thermite a project of your own from the dashboard, with agents, and take the result home.
- [Campaign modes](../explanation/campaign-modes.md): hill climbs, goal campaigns and research, and when each fits.
- [Write a contract](../how-to/campaigns/write-a-contract.md): goals checked by your kit's own code, by a measured value, or by people.
- [Test a kit with known candidates](../how-to/campaigns/test-a-kit.md): submit changes yourself to see that a kit judges them right.
- [Decide what waits for you](../how-to/campaigns/decide-what-waits.md): approvals, audits, reviews and "not possible" endings.
- [Contract](../reference/contract.md): every field of a goal contract.
