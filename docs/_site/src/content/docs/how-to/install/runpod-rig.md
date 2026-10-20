---
title: "Run a rig on RunPod"
description: "Launch a rig on a RunPod GPU from control, set its spend limit, stop, start and terminate it, and keep its results."
type: how-to
sidebar:
  order: 8
---

:::caution[This spends money]
A rig on RunPod is a real RunPod pod. RunPod bills its GPU by the hour from the launch until the pod is stopped or removed, and its volume while the pod exists. Thermite sets no limit of its own: give each launch a **spend limit**, an **idle stop**, or both, as in step 2.
:::

A [rig](../../reference/glossary.md) on RunPod runs on a GPU you rent by the hour. Control launches the pod, connects to it through RunPod's proxy, follows its price and what it has cost, and stops it at the limits you set. This page launches one, runs it, and terminates it with every result kept on control.

The dashboard has no launch form or buttons for these rigs yet ([goal 022](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/022-runpod-launch.goal) and [goal 023](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/023-runpod-lifecycle.goal)). You launch and manage them with the command line, the REST API or MCP, with the owner's token. The rig's page under **Rigs** works as for any rig once it reports.

## Before you start

- **A RunPod account in Settings › Providers**, added with an API key that may write. [Test a GPU on RunPod](runpod-test.md#1-add-the-runpod-account) gives the steps. A test pod there is a cheap way to check a GPU type first.
- **The rig image, on control.** A pod runs the [one-container rig image](../../reference/harness-image.md#the-one-container-rig-image): the CUDA harness and the supervisor in one container. Each release publishes it on `ghcr.io` ([Published images](../../reference/harness-image.md#published-images)), and the release's `compose.yaml` gives it to control, pinned by its digest, in `THERMITE_RUNPOD_RIG_IMAGE`. With a release's `compose.yaml` there is nothing to do: a launch runs that image. A control that runs from the source code's `compose.yaml` has no rig image until you name one in `.env`: a published one, such as `ghcr.io/iammrduncan/thermite-rig:0.1.0-cuda`, or [one of your own](#use-a-rig-image-of-your-own).
- **The owner's token in a file.** On the local compose stack it is `.dev/secrets/control-admin-token`. Only the owner may launch, stop, start or terminate a rig on RunPod.
- **A way out to the internet for control.** Control needs no public address: it connects to the pod, and the pod never connects to control ([Rigs in pull mode](../../explanation/trust.md#rigs-in-pull-mode)). The local compose stack is enough.

The examples use the local stack's address and token file. Put yours in their place.

```sh
c="--control http://127.0.0.1:8800 --token-file .dev/secrets/control-admin-token"
```

## 1. Choose a GPU

Open **Settings › Providers** and the RunPod account's row. It lists RunPod's GPU types on Secure cloud with their price per GPU per hour and their stock, and the data centers. Over MCP, the tool [`providers`](../../reference/mcp-tools.md#providers) gives the same. Use a GPU type's id or its name, such as `RTX A4000`.

Rigs launch on Secure cloud, on demand. Community cloud and spot pods come in a later version.

## 2. Launch the rig

```sh
thermite runpod launch runpod --gpu "RTX A4000" --spend-limit 20 --idle-stop 60 $c
```

`runpod` is the account's name in **Providers**. It prints the rig on one line, then `Launched: RunPod bills the pod from now. Control enrolls it once it runs; follow it with thermite runpod list.`

```text
rp-1a2b3c4d · pod abc123xyz · PROVISIONING · 1 × RTX A4000 (Secure) · $0.25/h · spent $0.00 · spend limit $20.00 · idle stop 60 min · not enrolled yet
```

- **`--spend-limit USD`**: control stops the pod once it has cost this much.
- **`--idle-stop MIN`**: control stops the pod once no run has run on the rig for this many minutes, counted from its enrollment or its last start at the earliest.
- **`--gpus N`** gives the pod more GPUs, and **`--setting NAME=VALUE`** the rig's settings, such as `--setting THERMITE_JUDGE_GPUS=1`. By default the rig measures on CUDA with all the pod's GPUs.
- **`--image IMAGE`** runs another rig image than control's ([Use a rig image of your own](#use-a-rig-image-of-your-own)).

[`thermite runpod launch`](../../reference/command-line.md#runpod-launch) lists every option. The same launch over the REST API, or with the MCP tool [`runpod_launch`](../../reference/mcp-tools.md#runpod_launch):

```sh
curl -sS -X POST http://127.0.0.1:8800/v1/gpu-clouds/runpod/rigs \
  -H "Authorization: Bearer $(cat .dev/secrets/control-admin-token)" \
  -H 'content-type: application/json' \
  -d '{"gpu":"RTX A4000","spend_limit_usd":20,"idle_stop_minutes":60}'
```

The pod's environment holds only public values and a one-time enrollment code. Control's RunPod key and every other secret stay on control. A launch that RunPod refuses starts nothing and leaves no rig: the answer says why, such as `RunPod answered 400 for POST /v2/pods (Bad Request: …)`.

## 3. Wait until it reports

```sh
thermite runpod list $c
```

The pod first pulls the image, which takes a few minutes. Then control enrolls it: the line ends with `enrolled`, and the status is `RUNNING`. Soon after, the rig's first report reaches control, and the rig shows under **Rigs** in the dashboard.

On the rig's page, check that its **Isolation** check at start passed ([Check a rig](../operate/check-a-rig.md)). Then start campaigns on it as on any rig: [from the dashboard](../campaigns/start-from-dashboard.md) or [from the command line](../campaigns/start-from-command-line.md).

If it never enrolls, the rig's page shows **Pull mode** with the last error, and `thermite runpod list` shows `last error:` for control's last read of the pod.

## 4. Change its limits

```sh
thermite runpod limits rp-1a2b3c4d --spend-limit 40 --idle-stop off $c
```

A number sets a limit, `off` clears it, and a limit you leave out stays. A pod that reaches a limit is stopped as in step 5: its runs are paused and its results sent out first. It is never removed. While the pod has cost its spend limit, control refuses to start it: raise or clear the limit first.

## 5. Stop and start it

A stopped pod costs nothing for its GPU, and keeps its volume, with the rig's state, until you start it again.

```sh
thermite runpod stop rp-1a2b3c4d $c
```

It prints `Stopping: its runs are paused and its results go out first, then the pod stops.` Control pauses the rig's running runs, asks for an export, and stops the pod once that export, and every export and champion's patch waiting on the rig, has reached control. If they can't leave within 15 minutes, it stops the pod all the same, and what did not leave stays on the volume. Follow it with `thermite runpod list`: `under way: stopping: …` while it waits, then the status `EXITED` and `stopped by the owner`.

```sh
thermite runpod start rp-1a2b3c4d $c
```

RunPod gives a stopped pod's GPU to whoever asks next. When it has no GPU free for the pod, the start is refused and says so: `RunPod has no free GPU for pod … now, so the pod stays stopped (…). Its volume stays. Try again later, or terminate it and launch a new rig.` Once the pod runs, control resumes the runs the stop paused. The rig reports again with the same keys and enrollment: it does not enroll again.

`thermite runpod restart rp-1a2b3c4d` stops the pod and starts it again, with no export: the volume keeps everything. It can meet the same lack of a free GPU.

## 6. Get its results

A rig on RunPod has no results repository: it sends its exports, and its champions' patches, to control, which checks every file. [Get a rig's results from control](../operate/exports-on-control.md) lists and downloads them. Each stop and the terminate below send what waits on the pod first.

## 7. Terminate it

Terminating removes the pod and its volume at RunPod. Control does it only once every result has left the pod.

```sh
thermite runpod terminate rp-1a2b3c4d $c
```

It prints `Terminating: its runs are paused, and the pod is removed only once every result has left it.` Control pauses the runs, waits until no judge job and no command waits on the rig, asks for a full export, and waits until it, and everything else that waits on the pod, has reached control. Then RunPod removes the pod, and control retires the rig: it leaves the rig lists, and its records and exports stay on control.

If a result can't leave, the terminate is refused, and the pod keeps running with its runs paused. `thermite runpod list` shows `last error: Not terminated: …` with the reason, such as a supervisor that has nowhere to send its exports. Fix the cause, then terminate again, or resume the runs.

A stopped pod is terminated at once when its last stop sent every result out. Otherwise the terminate is refused: start the pod, so its results can leave, then terminate it.

To check that nothing is left at RunPod, press **Read again** on the account's row in **Providers**: **Pods** no longer lists `thermite-rp-1a2b3c4d`.

## Fully reset it

A full reset wipes the rig's state and keeps the pod and its GPU. Every result leaves the pod first, then you check the export and confirm the wipe.

```sh
thermite runpod reset rp-1a2b3c4d $c
thermite runpod confirm-wipe rp-1a2b3c4d $c
```

Run the second only after you have checked the export on control, as [Fully reset a rig](../operate/rig-lifecycle.md#fully-reset-a-rig) says. `thermite runpod cancel-reset` cancels it before the wipe. The reset needs the pod running: a stopped pod's results can't leave it.

## Every change is in the rig's history

`GET /v1/rigs/<rig>/runpod` answers the rig with its `history`, oldest first, and the MCP tool [`rig_setup`](../../reference/mcp-tools.md#rig_setup) lists the same steps: the launch, each stop, start, restart and terminate, and each full reset, with what happened. The MCP tool [`runpod_rig`](../../reference/mcp-tools.md#runpod_rig) stops, starts, restarts, terminates and resets a rig, with the owner's token.

## Use a rig image of your own

Build the rig image yourself when the published one does not fit: you [added your project's tools to the harness](extend-harness-image.md), you changed Thermite's code, or you want a build of your own commit. RunPod must pull the image without a login, because control gives RunPod no registry credentials.

1. Build the CUDA harness and push it to your registry, as [Push the images to your own registry](own-registry.md) says. The rig image is built on it.
2. Build the rig image on that harness, then push it:

   ```sh
   r=registry.example.com/thermite
   tag=$(git rev-parse --short=12 HEAD)
   docker build -t $r/thermite-rig:$tag-cuda --build-arg HARNESS_IMAGE=$r/thermite-harness:$tag-cuda \
     -f containers/rig/Containerfile .
   docker push $r/thermite-rig:$tag-cuda
   ```

   Build both images for amd64, as the release does. On a Mac with Apple silicon, add `--platform linux/amd64` to each `docker build`. Use a new tag for every build.
3. Tell control. Name the image in `.env` next to `compose.yaml`, then run `docker compose up -d` with your `-f` options:

   ```sh title=".env (part)"
   THERMITE_RUNPOD_RIG_IMAGE=registry.example.com/thermite/thermite-rig:1a2b3c4d5e6f-cuda
   ```

   Every launch then runs it. Or give it to one launch only: `--image` on the command line, `"image"` over the REST API, or `image` in the MCP tool `runpod_launch`.

To tell that it worked: `GET /v1/rigs/<rig>/runpod` answers the launched rig with your image in `image`.

## What does not work yet

- **The dashboard.** No launch form, no price or spend on the rig's page, and no buttons to stop, start or terminate the pod ([goal 022](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/022-runpod-launch.goal), [goal 023](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/023-runpod-lifecycle.goal)). **Restart the rig's containers** in the rig's **⋯** menu does not reach RunPod; use `thermite runpod restart`.
- **Community cloud and spot pods.**
- **Gated models.** A Hugging Face token for gated models can't reach a pod yet ([goal 024](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/024-runpod-models-and-results.goal)).
- **Registry sign-in.** The image must be pullable without a login.
