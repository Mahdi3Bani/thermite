---
title: "Your first run"
description: "Start Thermite on your own computer and watch its judge check a rig, in about half an hour."
type: tutorial
sidebar:
  order: 1
---

In this tutorial you start Thermite on your own computer, sign in to its dashboard, and watch its judge decide on a dozen changes whose right answers are known. You won't need an AI model or a GPU yet.

At the end you'll have a running Thermite and you'll have seen its central idea at work: a change counts only when a judge the agents can't touch says it does.

It takes about half an hour. Most of that is the first build of Thermite's container images, which you only wait for once.

## What you need

- A computer running Linux or macOS, with a few CPU cores, a few gigabytes of free memory and several gigabytes of free disk. Thermite's three images take about 2 GB, and building them needs room of its own. With Podman on a Mac, that space must be free in Podman's virtual machine.
- **Docker** with Docker Compose, or **Podman** with `podman compose`. These run Thermite's parts as containers. On a Mac, Podman runs them in a small virtual machine, which must be started (`podman machine start`).
- **Node.js** 22.19 or later, and **git**.

## 1. Get Thermite

Open a terminal and copy Thermite to your computer:

```sh
git clone https://github.com/iammrduncan/thermite.git
cd thermite
```

## 2. Make your local tokens

Thermite uses **tokens**, long random passwords, so that only you can steer it. Make a set for this computer:

```sh
npm run dev:init
```

You see a line that ends with `.dev ready`. The tokens are now in the folder `.dev/secrets/`, which git ignores, so they stay on your computer.

This step needs only Node.js. Thermite's own packages are for its command line, which you install in [Hand the work to agents](agents-with-a-free-model.md), so you don't need `npm ci` yet.

## 3. Start Thermite

Build Thermite's images and start them. Use the line for your container tool:

```sh
docker compose up -d --build     # Docker
podman compose up -d --build     # Podman
```

The first time, this builds three images and can take 20 minutes or more. Later starts take seconds. When it finishes, check that three containers are up:

```sh
docker compose ps                # or: podman compose ps
```

You see three lines, one each for `control`, `harness` and `supervisor`, and each one's status starts with `Up`. They are the two halves of Thermite:

- **control** is the one place you watch and steer everything from: the dashboard, its API and MCP.
- **harness** and **supervisor** together make a **rig**: the place where research happens. The harness holds the judge and the agents. The supervisor is the rig's link to control. This rig is called `local-1`.

:::tip[If a line is missing or its status isn't `Up`]
Read that container's log, for example `docker compose logs harness` (or `podman compose logs harness`). If `up` stopped because port 8800 is in use, see [The port is already in use](../how-to/operate/troubleshoot.md#the-port-is-already-in-use). [Troubleshoot](../how-to/operate/troubleshoot.md) has the other common problems.
:::

## 4. Sign in

1. Show your **owner's token**, the token that lets you steer everything, and copy it. The sign-in page calls it the **Admin token**:

   ```sh
   cat .dev/secrets/control-admin-token
   ```

2. Open <http://127.0.0.1:8800/ui> in your browser.
3. Paste the token into **Admin token** and press **Sign in**.

You see the **Overview**. Its first line says `nothing needs you · 0 runs at work · 1 of 1 rigs reporting`. If it says `0 of 1`, the rig hasn't reported yet: wait a minute and press **refresh** in the status bar, the line along the bottom of every page. Dashboard pages never reload by themselves.

The sidebar on the left holds the dashboard's pages: **Overview**, **Campaigns**, **Rigs**, **Live** and more.

:::tip
If the sign-in page comes back with no message, the token didn't match. Copy it again, without spaces.
:::

## 5. Meet your rig

Choose **Rigs** in the sidebar, then **local-1**.

The page says `local-1 is live; it reported 10s ago.`, with your computer's processors, memory and disk under **What it runs on**. Find the **Checks** block. **Isolation** already shows **passed**: the rig ran it by itself when it started. Each agent works as its own operating-system user, and the check made sure that those users can't reach what they must not, such as the judge's files and other agents' work.

## 6. Run the judge's smoke check

Now give the judge something to judge. The **Judge smoke** check submits twelve changes to a small matrix-multiplication program. For each one, the right verdict is already known.

1. Beside **Judge smoke**, press **Run it**.

   A message says that control sent the command to `local-1`.

2. Open **Campaigns** in the sidebar. Within a minute, after a **refresh**, a campaign named `rig-check-smoke-cpu-` and some letters appears. Under its name is one **run**, `check-smoke-` and some letters: the campaign at work on your rig.

   That run is the check. Choose it to watch: its page starts with the line `Run check-smoke-…`, and each change shows up, then gets its verdict. Press **refresh** to see more.

3. Two or three minutes after you pressed **Run it**, go back to **Rigs** › **local-1** and press **refresh**.

   **Judge smoke** shows **passed**, with `smoke on smoke-cpu: all 12 candidates were judged as expected`. While it works, it shows **running**.

   If it shows **failed**, the sentence beside it says why. The usual reason on a laptop is a computer too busy for fair timing: close other heavy programs and press **Run it** again. See [A check failed](../how-to/operate/troubleshoot.md#a-check-failed).

## 7. See what the judge decided

Open the check's run again: in **Campaigns**, choose `check-smoke-…`, then **Attempts** in the line at the top of the run. **How the judge decided** counts the judge's **verdicts**, its decision on each change: `invalid 4`, `neutral 3`, `rejected v0 2`, `crash candidate 2` and `win confirmed 1`. Below it, each change is listed by what it tries, and starts with one word for how it ended. Here is what the judge did with some of the twelve:

| The change | Its word | The verdict | Why |
| --- | --- | --- | --- |
| `i-k-j loop order makes the inner loop contiguous` | **Champion #2** | win confirmed | It was faster, and stayed faster when measured again on fresh runs |
| `rename the accumulator` | **Lost** | neutral | No real difference |
| `skip half of the reduction` | **Broken** | invalid | Its answers were wrong |
| `call the reference implementation` | **Broken** | invalid | The judge noticed the reference ran |
| `use a large scratch buffer` | **Broken** | crash candidate | Stopped at the run's memory limit |
| `time the kernel from inside` | **Judging** | rejected v0 | It adds a timer call, which the rules forbid |
| `make the reference trivial` | **Judging** | rejected v0 | That file is not the agents' to change |

The word sums up the verdict. [Hand the work to agents](agents-with-a-free-model.md) uses these words. The **champion** is the run's best version so far. Champion #1 is the project as the run started, so the first change that beats it becomes champion #2.

`rejected v0` means refused by the first, static checks, before the change was built. Such a change never gets a verdict, so its row shows **Judging** for ever, with `rejected v0` under the change: a known fault ([goal 061](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/061-gaps-found-by-the-docs.goal)). Nothing more happens to it.

Open **Overview** in the sidebar. Its **What happened** block tells the same story in sentences, newest first. For example: `confirmed faster on fresh runs (+67.1%)` and `became champion #2`.

That is Thermite's central rule: **agents propose, and code they cannot touch decides.** Later, AI agents will propose the changes instead of the smoke check, and the same judge will decide.

## 8. Stop or keep Thermite

Thermite can keep running in the background. To stop it:

```sh
docker compose down              # or: podman compose down
```

To start it again, run `docker compose up -d` (or `podman compose up -d`). Your campaigns and results are kept between starts.

## What you did

You started control and a rig on your own computer, signed in, and watched the judge give twelve known changes their right verdicts. You've seen a champion promoted only after a confirmed gain.

## Next

- [Hand the work to agents](agents-with-a-free-model.md): connect a free model and watch agents propose changes.
- [Why agents never judge](../explanation/why-agents-never-judge.md): how the judge decides, step by step.
- [Install Thermite on one machine](../how-to/install/one-machine.md): keep Thermite running for real work.
