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

- A computer running Linux or macOS, with a few CPU cores, a few gigabytes of free memory and some free disk space for the images.
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

You see `control`, `harness` and `supervisor`, each with the status `Up`. They are the two halves of Thermite:

- **control** is the one place you watch and steer everything from: the dashboard, its API and MCP.
- **harness** and **supervisor** together make a **rig**: the place where research happens. The harness holds the judge and the agents. The supervisor is the rig's link to control. This rig is called `local-1`.

## 4. Sign in

1. Show your owner token, and copy it:

   ```sh
   cat .dev/secrets/control-admin-token
   ```

2. Open <http://127.0.0.1:8800/ui> in your browser.
3. Paste the token into **Admin token** and press **Sign in**.

You see the **Overview**. Its first line says `nothing needs you · 0 runs at work · 1 of 1 rigs reporting`. If it says `0 of 1`, the rig hasn't reported yet: wait a minute and press **refresh** at the foot of the page. Dashboard pages never reload by themselves.

:::tip
If the sign-in page comes back with no message, the token didn't match. Copy it again, without spaces.
:::

## 5. Meet your rig

Choose **Rigs** in the sidebar, then **local-1**.

The page says `local-1 is live; it reported 10s ago.`, with your computer's processors, memory and disk under **What it runs on**. Find the **Checks** block. **Isolation** already shows **passed**: the rig ran it by itself when it started. It checked that each of the agents' users is refused what it must not reach, such as the judge's files and other agents' work.

## 6. Run the judge's smoke check

Now give the judge something to judge. The **Judge smoke** check submits twelve changes to a small matrix-multiplication program. For each one, the right verdict is already known.

1. Beside **Judge smoke**, press **Run it**.

   A message says that control sent the command to `local-1`.

2. Open **Campaigns** in the sidebar.

   A campaign named `rig-check-smoke-cpu-` and some letters appears, with one run named `check-smoke-` and some letters. That run is the check. Open it to watch: each change shows up, then gets its verdict. Press **refresh** to see more.

3. After a few minutes, go back to **Rigs** › **local-1**.

   **Judge smoke** shows **passed**, with `smoke on smoke-cpu: all 12 candidates were judged as expected`.

## 7. See what the judge decided

Open the check's run again and look at its attempts. Here is what the judge did with some of the twelve changes:

| The change | The judge's verdict | Why |
| --- | --- | --- |
| Loops in a better order | `win_confirmed`, then champion | It was faster, and stayed faster when measured again on fresh runs |
| The same code with a renamed variable | `neutral` | No real difference |
| Skips half of the work | `invalid` | Its answers were wrong |
| Calls a timer in the code | refused before building | Changes may not touch timing |
| Edits the reference answer | refused before building | That file is not the agents' to change |
| Secretly calls the reference code | `invalid` | The judge noticed the reference ran |
| Uses far too much memory | `crash_candidate` | Stopped at the run's memory limit |

The Overview's **What happened** block tells the same story in sentences, newest first. For example: `confirmed faster on fresh runs (+67.1%)` and `became champion #2`.

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
