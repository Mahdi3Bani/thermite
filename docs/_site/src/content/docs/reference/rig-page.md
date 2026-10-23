---
title: "A rig's page"
description: "Every part of a rig's page on the dashboard: its state and version banners, Update to control's version, Check again, its facts, and a RunPod rig's pod, limits, lifecycle, pod log and history."
type: reference
sidebar:
  order: 21
---

A [rig](glossary.md)'s page shows one rig: whether it reports, its version against control's, what runs on it, its checks, and what you can do to it. Open it from [**Rigs**](rigs-list.md): press the rig's row. Its address is `/ui/rigs/<rig>`. This page describes each part, from the top down. [Stop, restart, remove or reset a rig](../how-to/operate/rig-lifecycle.md) and [Run a rig on RunPod](../how-to/install/runpod-rig.md) give the steps.

## Places on the page

Other pages link to these places with the address and the anchor, for example `/ui/rigs/rig-1#version`. The Rigs list's **needs update** opens `#version`, and its rows open the place of the rig's state ([Where a row leads](rigs-list.md#where-a-row-leads)).

| Anchor | What it is | When the page has it |
| --- | --- | --- |
| `#reporting` | The banner for a rig that does not report: stale or offline | The rig is stale or offline, is not a stopped RunPod rig, and control does not refuse it |
| `#version` | The banner for the rig's version, or for its last update | Its version is behind or ahead of control's, control refuses it, or an update began in the last day |
| `#pod` | The pod: its cost, its limits and its lifecycle | The rig was launched on RunPod |
| `#limits` | The form that changes the spend limit and the idle stop | The same, while the pod exists |
| `#results` | The results that must leave the pod before it ends | The same, while the pod exists |
| `#podlog` | **Pod log**: the pod's log, read from RunPod | The same, while the pod exists |
| `#hist` | The history, with its filters | The rig was launched on RunPod |

## The top

The title is the rig's name. The line beside it says the rig's state:

| It says | When |
| --- | --- |
| `live` | The rig reported within the stale window (`THERMITE_CONTROL_STALE_SECONDS`, 180 s by default) |
| `stale · no report for 6 minutes` | No report for longer than the stale window |
| `offline · no report for 3 h 12 min`, or `offline · no report yet` | No report for longer than the offline window (`THERMITE_CONTROL_OFFLINE_SECONDS`, 900 s by default), or never |
| `refused · 0.0.7` | Control refuses the rig: its protocol and control's do not meet. The version is the rig's |
| `stopped` | A rig on RunPod whose pod is stopped. It is not called stale or offline |

After it, the line adds `0.1.0, behind control` or `0.2.0, ahead of control` when the rig's version differs from control's. A rig on RunPod adds `RunPod`, and its price per hour while its pod runs, such as `RunPod · $0.50/h`.

The buttons at the right:

- **Edit rig** opens the rig's settings and models.
- **Live** opens what the rig's agents and judge do now.
- **Export** opens a choice under **What to export**: **What changed** (what the rig recorded since its last export) or **Full export** (also a snapshot of the ledger, every run's research folder, finished or not, and the pages each run fetched). Its **Export** button sends the signed `export_now` command with `full` as you chose, and a line at the top of the page says the export was asked for and that it shows on the **Exports** page when all its files reach control. The **Exports page** link in it, and **its exports on control** on the **Results** row of a rig that sends its exports to control, open the [Exports page](exports.md#download-an-export) for this rig.
- **⋯** has **Restart the rig's containers** (with a deployment driver only), **Full reset** (type `reset <rig>`) and **Retire it** (type `retire <rig>`). For a rig on RunPod it has only **Retire it**, and says that its pod's changes are on the page, under **The pod**. Retiring stops nothing: a pod that still exists keeps running and costing money, and the menu says to terminate it instead.

A button that needs typed words stays off until the words are typed exactly. Control checks them again when the form arrives.

The first lines under the title say, in a few sentences: for a RunPod rig, its pod and what it has cost; whether it reports; what runs on it; what its judge does; a check that failed; a key that waits for you; for a RunPod rig, a connection to its pod that failed.

A card after an action says what happened: its words in green, or **Not done.** and the reason. A button that sends a command to the rig, such as **Export**, **Run it** or **Pause**, says at once that the click took, and the page follows the command to its outcome with no refresh: see [Signed commands](signed-commands.md#on-the-dashboard). After **Save changes** on **Edit rig**, the green line here goes on with how the settings' command stands, such as `rig-1 took it at 03:41 UTC. This page shows the change when the rig next reports.`

## The reporting banner

| State | Title | What it says | Buttons |
| --- | --- | --- | --- |
| Stale | `No report for 6 minutes.` | The stale and offline windows. A stale rig may still be at work: its runs go on, and what they did arrives with its next report. Then what control found when it last checked where the rig runs, or that it has not checked yet. For a rig control can't reach: check it there | **Check again**, **Restart the rig** |
| Offline | `Offline: no report for 3 h 12 min.` | When its last report came, in UTC, and how many lanes its runs had at work then; what control found when it last checked; that what it did since arrives with its next report | **Check again** (**Check the cluster** for a rig on a cluster), **Restart the rig**, **Retire it** |

**Check again** and **Restart the rig** show only where control can do them:

| The rig | Check again | Restart the rig |
| --- | --- | --- |
| Set up by control on a machine | Over SSH: whether its two services are active, its containers' states, and the supervisor's last 3 log lines | Restarts both services over SSH (the same as **Restart them** in **Set up by control**) |
| Set up by control on a cluster | **Check the cluster**: reads its two deployments from the cluster's API, and how many of their pods are ready | Restarts both deployments (the same as **Restart them**) |
| Launched on RunPod | None: **The pod** shows RunPod's status, read every 30 seconds | Stops the pod and starts it again |
| Joined yourself | None: control can't reach it | None |
| Any other, such as the compose stack | None | With a deployment driver only: restarts its containers |

Control also checks a rig it set up, on a machine or a cluster, by itself: once when the rig turns stale, and once more when it turns offline. **Check again** checks now. What a check found goes in the banner and in the history, for example `Both containers run: the harness is running (up 3 days), the supervisor is running (up 3 days). The supervisor's last log lines: control: connection refused`, or `cluster-1's API did not answer: …`. The supervisor's log lines are cut to 200 characters each, and tokens in them are hidden.

## The version banner

Control compares the rig's version with its own ([Rig versions](rest-api.md#rig-versions)). A rig that runs control's version, or sends no version, has no banner: the **Version** fact says it.

| State | Title | What it says | Buttons |
| --- | --- | --- | --- |
| Behind | `rig-1 runs Thermite 0.1.0. Control runs 0.2.0.` | They work together, so nothing stops. Update the rig when its runs allow. Then what the update does, or how to do it yourself | **Update to 0.2.0**, for a rig control can update |
| Ahead | `rig-1 runs Thermite 0.3.0, newer than control's 0.2.0.` | They work together. Update control when you can | None |
| Refused, older | `Control refuses this rig: its version is too old.` | Both versions and the reason. Control takes none of its reports and sends it no commands. What the page shows is from its last report that control took. How many of its calls control refused, and when the last came. How to fix it | **Update to 0.2.0**, for a rig control can update; **Retire it** |
| Refused, newer | `Control refuses this rig: its version is too new.` | The same, and to update control to the rig's version or later. The refusal then ends by itself | **Retire it** |
| Updated | `Updated. It runs Thermite 0.2.0, as control does.`, or `The last update stopped, but it runs Thermite 0.2.0, as control does.` | The steps of the last update | None |
| Update, version unknown | `The update to 0.2.0 is under way. Control does not know the rig's version.` (or `stopped`) | The notice, and the update's steps | None |

When the update can't come from control, the banner says how to do it:

- a rig set up by control whose place is gone or not ready: why, such as `The machine gpu-host-1 is no longer in Settings › Providers, so control can't reach it.`, or control's missing images or address;
- a rig on RunPod: `Control can't move a pod onto another image. To run 0.2.0, terminate this rig and launch a new one on control's image.`;
- any other rig: `Pull the 0.2.0 images where the rig runs, and start it again with them.`

### Update to control's version

**Update to** moves a rig control set up, on a machine or on a cluster, onto the images control deploys now: `THERMITE_RIG_HARNESS_IMAGE` (`THERMITE_RIG_HARNESS_CUDA_IMAGE` for a rig with GPUs) and `THERMITE_RIG_SUPERVISOR_IMAGE`. Control needs its address for rigs, `THERMITE_CONTROL_PUBLIC_URL`. One update runs on a rig at a time. The steps show in the banner as they happen, with the one under way. The page follows them by itself until the update ends: you do not need to refresh it.

| Step | What control does | Waits at most | When it can't |
| --- | --- | --- | --- |
| Update to control's version asked | Notes the versions, from and to, and who asked | | |
| Its runs paused at a safe point | Sends `pause_run` for each running run, with the reason `control updates the rig to <version>`, and waits until the rig takes them | 5 minutes | It goes on, and says so. A refused rig takes no command, and a rig that does not report can't take one: their runs are not paused |
| Its containers moved onto control's images | **On a machine:** over SSH, pulls both images while the rig still runs, writes its two container units again, and restarts both services. **On a cluster:** applies its two deployments again, as **Update to these images** does | 30 minutes over SSH | It stops here: the rig keeps the images it had, and its paused runs resume |
| A report reached control from control's version | Waits for a report in which both parts run control's version | 20 minutes | It stops here, with what the rig reports, and its paused runs resume |
| The isolation check after the update | Sends `rig_check` for the isolation check, and waits for its result | 30 minutes | It says why: it failed, the rig refused it (such as `not now: …`, while a judge job waits), or no result came |
| Its runs resumed | Sends `resume_run` for each run it paused | | |

The rig's volumes, tokens, key, ledger, runs and results stay. A trial in progress stops, and its experiment goes back to the top of the queue. On a machine the update writes only the two container units: the rig's secrets, keys, volumes and networks stay as they were. If a step fails, the banner shows **The update stopped**, and its steps say why.

## Blocks

A key that waits for you has a card under the banners, with its fingerprint and **Accept this key**: see [Accept a rig's key](../how-to/operate/accept-a-rig-key.md).

**At work** lists the runs at work now. **Checks** lists the rig's three [checks](rig-checks.md), each with **Run it**, and its state: **not run yet**, **sent**, **running** with the time so far, **passed** or **failed**, or why the rig did not run it ([Where results show](rig-checks.md#where-results-show)); for a refused rig it says `Control sends no command to a refused rig, so its checks can't run. Update it first.` **Runs on this rig** lists every run; for a rig that does not report, or that control refuses, its heading says `as of its last report`. **The judge's last jobs** lists its last 8 jobs. A rig on RunPod has **Pod log** under it ([Pod log](#pod-log)).

**What it runs on** shows the rig's hardware, from its signed report.

**The rig** shows its facts:

| Fact | What it says |
| --- | --- |
| **Version** | The rig's version, and how it stands: `0.2.0 · as control`; `0.1.0 · control 0.2.0 · they work together`; `0.3.0 · newer than control's 0.2.0 · they work together`; the rig's version in red, `· control 0.2.0 can't work with it`; or `not reported · control 0.2.0`. When the harness and the supervisor differ, both: `harness 0.1.0, supervisor 0.2.0` |
| **Last report** | How long ago, and the time in UTC. For a refused rig, the last one control took |
| **Calls refused** | Only for a refused rig: how many of its calls control refused since the refusal began, and when the last came |
| **Placed on** | Where it runs: a machine over SSH, a cluster and namespace, a RunPod pod, or a place you set it up on yourself |
| **Key** | The fingerprint of its report key, or `not pinned` |
| **Ledger** | Its ledger's id |
| **Results**, **Models**, **Advisors** | From its supervisor's figures (unsigned) |

Then the block of how it was set up, if control set it up: **Set up by control** (a machine or a cluster), **You run it yourself** (joined), or **Pull mode** (RunPod).

**Recent** lists what happened, newest first: the rig's events, and the lines of its state:

- `Control refused the rig.` and the reason, and `Control refused a call from the rig (N calls since the refusal began; shown once).`;
- `Control runs 0.2.0, and this rig runs 0.1.0: they work together.`, at the later of control's update and the rig's report of its build;
- `Stale: no report for 3 minutes.` and `Offline: no report for 15 minutes.`, at the time each began;
- each check of where the rig runs, and each step of an update.

## The pod

A rig launched on RunPod has **The pod**, under the banners. Its heading has the pod's state at RunPod (**Running**, **Stopped**, **Terminated**, a change under way such as **stopping…**, or RunPod's own word), the cloud, the data center, the pod's id, and when control last read the pod.

| Fact | What it shows |
| --- | --- |
| **Cost now** | While the pod runs: its price per hour, from RunPod's price for it (the GPU's list price times its GPUs until RunPod gives one). While it is stopped: `storage only`. Once it is terminated: `none` |
| **Spent so far** | What it cost while it ran, since launch, as control counts it every 30 seconds. With a spend limit: `of $20.00 · about 38 h of work left`, and a bar. It leaves out what RunPod bills for a stopped pod's volume |
| **Spend limit** | The limit, or `none` |
| **Idle stop** | The minutes, or `never`. Under it: how long no run has been at work, `a run is at work`, or that it counts once the pod enrolls or while it runs |

**Change the spend limit or the idle stop** opens a form with **Spend limit (USD)** and **Stop when idle for (minutes)**. An empty field clears that limit. The idle stop is 5 minutes or more. A limit the pod has reached already stops it at control's next check, within 30 seconds, its results sent out first. The page then says, for example, `Saved. No spend limit. It stops after 30 minutes with no run at work.`

The idle stop counts the time no run is at work on the rig: no campaign runs, or every run is paused, blocked or finished ([When a rig is idle](rest-api.md#when-a-rig-is-idle)). Starting or resuming a run on the stopped pod starts it again.

### Start, stop and end it

Five boxes, each with what it does and its button. A box that does not apply now is grey, says why, and its button is off.

| Box | Button | Applies when | Typed words |
| --- | --- | --- | --- |
| **Stop** | **Stop the pod** | The pod runs, and no change or full reset is under way | |
| **Start** | **Start the pod** | The pod is stopped, and no change or full reset is under way | |
| **Restart** | **Restart the pod** | The pod runs, and no change or full reset is under way | |
| **Full reset** | **Start the full reset** | The pod runs, and no change or full reset is under way | `reset <rig>` |
| **Terminate** | **Terminate** | No change or full reset is under way | `terminate <rig>` |

After a button, the page says what began: `Stopping: its runs are paused and its results go out first, then the pod stops.`, `Starting: RunPod starts the pod, and its paused runs resume once it runs.`, `Restarting: the pod stops, then starts again.`, or `Terminating: its runs are paused, and the pod is removed only once every result has left it.` A refusal shows **Not done.** with RunPod's or control's reason, such as `RunPod has no free GPU for pod … now, so the pod stays stopped (…)`. The full reset goes on as for any rig: [Fully reset a rig](../how-to/operate/rig-lifecycle.md#fully-reset-a-rig).

While a change is under way, a card shows it in words, such as `stopping: waiting for its export`, who asked and when, and its steps: done, under way, and still to come.

| Change | Its steps |
| --- | --- |
| Stop | Pause the runs at a safe point. Send the waiting results out of the pod. Wait until they have left the pod (15 minutes at most). Ask RunPod to stop the pod |
| Start | Ask RunPod to start the pod. Wait for the pod to run. Resume the runs the stop paused |
| Restart | Ask RunPod to stop the pod. Wait for the pod to stop. Ask RunPod to start it again, and wait for it to run. The harness starts again: a trial that was in progress is planned again. A restart pauses no run |
| Terminate | Pause the runs at a safe point. Wait until no judge job and no command waits on the rig (1 hour at most). Make a full export (30 minutes at most). Wait until every result has left the pod (1 hour at most). Ask RunPod to delete the pod and its volume |

What went wrong last shows in red under them. An error from control's last read of the pod goes at its next good read. A refused terminate, `Not terminated: …`, stays until you stop, start, restart or terminate the pod, or until a newer step in its history, such as a full reset.

### Results in the pod

What must leave the pod before it ends, from the rig's supervisor's last report:

| Row | What it says |
| --- | --- |
| Exports waiting to leave the pod | How many exports wait, and where they go: control, or the results repository |
| Champions' patches waiting to reach control | How many wait |
| The last export | The export the change under way or the last stop made: out, on its way, or can't leave, with why |

Its heading says `N waiting`, `all out`, or `not reported`.

### History

A rig on RunPod has **History** in place of **Recent**, with filters: **All**, **The pod**, **Runs** and **The judge**. **The pod** lists its launch, each stop, start, restart and terminate, and each full reset, with what happened, such as `Pod stopped: its GPU is no longer billed, and its volume stays: …`. **Runs** and **The judge** list the rig's events.

### Pod log

**Pod log** shows the pod's log as RunPod keeps it: what the rig image printed and RunPod's own steps. Before the rig enrolls, it is the one place that says why a pod runs but never enrolls. Control reads it from RunPod's API (`GET /v2/pods/<pod>/logs`) with the GPU cloud's key from **Settings › Providers**. A read asks for the newest 200 lines and stops once they came, once no line came for 2 seconds, or after 10 seconds.

| Part | What it shows |
| --- | --- |
| The lines | Oldest first, the newest at the bottom, in a box that opens scrolled to the newest. Each line has its source, `container` (what the rig image printed) or `system` (RunPod's own, such as the image pull), and its time in UTC; the full time shows when you point at it |
| Under them | `Read 2m ago, at 14:05 UTC: 57 lines, container and system, oldest first.` A read over MCP or REST for one source only says `system lines only` or `container lines only` |
| **Read the log** or **Read again** | Reads the log now. The button says `Reading…` until the lines come, and the block is drawn again with them, with no refresh |
| A refusal | `Not read:` and why, in red, such as `RunPod refused to show pod …'s log with this key: the key may not read pod logs. A key with read access to pods can` |
| Nothing read | `Not read yet.`, or `Not read yet. Reading it…` while the page reads it by itself |
| An empty log | `RunPod has no line in this pod's log yet.` |

Loading the page never reads RunPod: a read holds RunPod's stream open for up to 10 seconds, and the page's script loads the page again every few seconds while it follows a button. Control keeps each rig's last read in memory until it restarts, and a read over REST or MCP shows here too. Before the rig's first report, when control has no read of the log yet, the page's script presses **Read the log** once the page has opened; after the first report, the block waits for you to press it. After the first report, **Pod log** is in the left column, below **The judge's last jobs**.

Before control shows a line, it takes out what looks like a credential: a URL's user and password, a bearer token, and keys with a known prefix, such as `hf_`, `ghp_` or `rpa_`, which become `hf_***`. It also takes out a terminal's colour codes. A pod that is terminated has no **Pod log**: RunPod no longer has it.

### Before its first report, and after its end

Before the rig's first report, its page shows **Getting it ready**: the launch, the pod pulling the image and running, control enrolling it with its one-time code, and the rig's first report, each done, under way or still to come. Then **Pod log**, **The pod**, its history and **Pull mode**.

Once the pod is terminated, the rig is retired. Its page says so, with **Bring it back**, and shows what the pod cost in all, its facts and its history.
