---
title: "Troubleshoot"
description: "Find out why a check failed, a port clashes, a build is slow, a rig is quiet, a message goes unread, a queue change doesn't take or a sign-in bounces back, and where the logs are."
type: how-to
sidebar:
  order: 8
---

Find the problem you see, then follow what to do. A [rig](../../reference/glossary.md) is two containers: the harness, which holds the judge and the agents, and the supervisor, its link to control. Most problems leave a line in a log, so [Where the logs are](#where-the-logs-are) comes first. Most commands below are for the local compose stack; with Podman, write `podman compose` where they say `docker compose`. For a rig on a machine or a cluster, the table below gives the commands that read its logs, and the entries say what to read there.

## Where the logs are

Every part of Thermite writes one JSON object per line, such as `{"at":"…","component":"supervisor","msg":"relay error","error":"…"}`.

| What | Where |
| --- | --- |
| Control, the harness and the supervisor of the local stack | `docker compose logs control`, `docker compose logs harness`, `docker compose logs supervisor`. Add `-f` after `logs` to follow them |
| A rig on a machine, set up by control or joined | On the machine, logged in over SSH as the user the rig runs as (not with `sudo -u`): `journalctl --user -u thermite-rig-1-supervisor.service`, and the same for `thermite-rig-1-harness.service`. For a rig that runs as root: `sudo journalctl -u thermite-rig-1-supervisor.service` |
| A rig on a cluster, set up by control or joined | `kubectl logs -n <namespace> deployment/thermite-rig-1-supervisor` (or `-harness`) |
| What a rig did | The rig's page: **Recent** for its history, **Checks** for its checks, and the **Set up by control** or **You run it yourself** block for each setup step. For a rig control set up, the MCP tool `rig_setup` lists the same steps |
| What a run's agents and advisors are doing | **Live** in the sidebar, or **Live** on the run's page: the run's lines as they come. Choose **Advisors** for each step of the advisors' rounds, with each advisor error and its reason. Choose **You** for your messages, who read them and the advisors' answers |
| What control did, refused or failed at | **Audit log** in the sidebar (the newest 300 entries), `GET /v1/audit`, or the MCP tool `control_log`. Dashboard refusals are entries named `refused`, and requests that ended in an error are named `failed`, each with the reason (for a refusal shown as a plain page, such as `bad form token`, only its HTTP status) |
| Where each command went | **Commands** in the sidebar: each command's status (`pending`, `delivered`, `rejected`, `failed`, `expired`) and the rig's answer in **Outcome** |

There is no single Logs page yet ([goal 027](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/027-logs-page.goal)).

## Compose won't start: a secret file is missing

- **You see:** `docker compose up` stops with an error about a file in `.dev/secrets/`.
- **Why:** the local tokens don't exist yet. `compose.yaml` reads them from `.dev/secrets/`.
- **Do:** run `npm run dev:init` in the repository's top folder, then start again.

## Control stops at start: `control needs the owner's credential`

- **You see:** control keeps restarting, and `docker compose logs control` has a `fatal` line that says `control needs the owner's credential`.
- **Why:** control has no owner's token. After you switch to an owner's token of your own, the token file is empty on purpose, and only the override file gives control the hash.
- **Do:** start the stack with both files: `docker compose -f compose.yaml -f compose.tokens.yaml up -d`. See [Use an owner's token of your own](../install/one-machine.md#use-an-owners-token-of-your-own).

## Control stops at start: `EPERM` on `control-signing.key`

- **You see:** control keeps restarting, and its log has a `fatal` line with `EPERM: operation not permitted, chmod '/var/lib/thermite-control/control-signing.key'`.
- **Why:** you added `compose.lifecycle.yaml` to a stack that had already run. See [Give control a deployment driver](rig-lifecycle.md#give-control-a-deployment-driver).
- **Do:** start the stack again without that file.

## The port is already in use

- **You see:** `docker compose up` fails because port 8800 is taken.
- **Why:** another program, or another Thermite stack, uses port 8800 on your computer.
- **Do:** choose another port: `THERMITE_CONTROL_PORT=8801 docker compose up -d`, or put `THERMITE_CONTROL_PORT=8801` in a `.env` file next to `compose.yaml`. The dashboard is then at `http://127.0.0.1:8801/ui`.

## The harness restarts at the first start

- **You see:** the harness's log has `timed out waiting for /keys/control-signing.pub`, and it starts again.
- **Why:** control writes its public key when it first starts, and the harness waits only two minutes for it.
- **Do:** nothing. The harness starts again by itself and finds the key.

## The first build is slow

- **You see:** `docker compose up -d --build` takes 20 minutes or more.
- **Why:** it builds three images from source, and the harness image installs compilers, Python and agent programs. A GPU image's base is a large download too.
- **Do:** wait for it once. Later, start without `--build` (`docker compose up -d`) to reuse the images, and rebuild only what changed, for example `docker compose build harness`.

## The Podman VM runs out of disk or memory

- **You see:** builds fail partway, or the VM's disk fills up. `podman system df` shows how much the images and volumes take.
- **Why:** on a Mac, Podman runs containers in a VM. Each build leaves old image layers behind, and each lane's compiler cache can grow to 8 GB.
- **Do:** free the space, then give it back to your Mac:

```sh
podman image prune -f              # remove untagged image layers only
podman machine ssh sudo fstrim -a  # give the freed space back to your Mac
```

Never prune tagged images: they may belong to other projects. For more memory or CPUs, stop the VM and change it with Podman's own command, `podman machine set --memory <MiB> --cpus <n>`.

## Sign-in comes back with no message

- **You see:** after **Sign in**, the sign-in page shows again.
- **Why:** the token is not the owner's. Only the owner's token signs in; an operator's, agent's or reader's token can't. A token with a space or a missing character fails too.
- **Do:** copy the owner's token again: `cat .dev/secrets/control-admin-token` on the local stack, or the file of the owner's token you made yourself. After 20 failures in a minute, the page says `too many failed sign-ins; wait a minute`.

A sign-in also ends when the owner's token changes, or after 30 days without use.

## A button answers `bad form token`

- **You see:** a plain page that says `bad form token` after you press a button.
- **Why:** the page was opened before your current sign-in, for example before you signed in again in another tab.
- **Do:** go back, reload the page and press the button again.

## A rig is quiet

- **You see:** the rig shows **Not reporting**, or never appears on **Rigs**.
- **Why and do:** read the supervisor's log. Most causes show in a `relay error` line:

| In the supervisor's log | Why | Do |
| --- | --- | --- |
| `waiting for the harness` and nothing more | The harness isn't up | Read the harness's log |
| `the rig's key waits for the owner's acceptance` or `rig key changed: the owner must accept the new key` | Control holds the rig's key | [Accept the rig's key](accept-a-rig-key.md) |
| `this rig is retired in control` | The rig was retired | Bring it back on its page: see [Retire and bring back](rig-lifecycle.md#retire-and-bring-back) |
| `ingest -> 401` with `unauthorized` | The supervisor's control token is wrong | Give it the rig's current token: see [Rig tokens](tokens.md#rig-tokens) |
| `the harness reports as rig …, but this supervisor is …` | The two containers have different `THERMITE_RIG_ID` settings | Make them the same |
| `report from the future` | The rig's clock is ahead of control's | Set the clocks right |
| No `relay error`, but the rig has never appeared | The supervisor has no control token file, so it reports nothing and logs no error | Check that the file its `THERMITE_CONTROL_TOKEN_FILE` names exists and holds the rig's token |

A rig control set up on a machine or a cluster may also still be pulling its images. Its setup steps say `no report after 10 minutes: it may not have started` when it took longer than that; it may still report later. For a rig on a cluster, see [A rig on a cluster never reports](#a-rig-on-a-cluster-never-reports).

## Pushes to the results repository fail with `@@@@@@@@@`

- **You see:** the **Results** row on the rig's page says `push failed: Command failed: git … push …` and `@@@@@@@@@`.
- **Why:** ssh refused the deploy key. On a Mac with Podman, it refuses a key file at mode 644.
- **Do:** see [Set up the results repository](results-repository.md#3-give-the-supervisor-the-three-settings).

## A rig on a cluster never reports

- **You see:** in the rig's **Set up by control** block, the step "First report reached control" has ✕ and `no report after 10 minutes: it may not have started`, and the block says `failed`.
- **Why:** its pods have not started, or its supervisor can't reach control. Often the nodes are still pulling the large images. A pod stays `Pending` when no node has room for what it asks, such as its GPUs, CPUs, memory or volume. It shows `ImagePullBackOff` when the nodes can't pull the images: a registry that needs a sign-in is not supported yet ([goal 061](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/061-gaps-found-by-the-docs.goal)).
- **Do:** look at the pods, in the namespace the block shows:

  ```sh
  kubectl get pods -n <namespace> -l app.kubernetes.io/instance=rig-1
  kubectl describe pods -n <namespace> -l app.kubernetes.io/instance=rig-1   # its Events say why it waits
  kubectl logs -n <namespace> deployment/thermite-rig-1-supervisor          # relay errors, as in the table above
  ```

  When the rig reports later, the block says `running` again, and a ✓ step follows the ✕: "A report reached control from the new images · it reported again after the wait ended". The ✕ stays in the list.

After **Update to these images**, **Start its pods** or **Restart them** ([Stop, restart, remove or reset a rig](rig-lifecycle.md#a-rig-on-a-cluster)), the same can happen to the new pods, with other steps:

- "Its pods run the new images" has ✕ and `not running after 15 minutes`, sometimes with kubectl's error. The new pods did not start: look at them with the commands above. An image the nodes can't pull shows `ImagePullBackOff`.
- "A report reached control from the new images" has ✕ and `no report after 10 minutes: it may not have started`. The pods run, but the supervisor did not report: read its log, as above. If the harness keeps restarting, read its log too (`deployment/thermite-rig-1-harness`).

The steps say "new images" after a start or a restart too, although no image changed. Either way, the block says `failed`. Fix the cause: the pods keep trying by themselves, for example once the nodes can pull the image. When the rig reports again, the block says `running`, with the ✓ step above.

To have control try the same images again and wait once more, press **Restart them**, or call `update_rig_images` over MCP. The page doesn't offer **Update to these images** again, because control recorded the new images at the first try. If the new images themselves are at fault, set control's image settings back to the old ones, restart control, and press **Update to these images** again. An older harness may refuse a ledger that a newer one opened: see [The harness stops at start: the ledger is newer](#the-harness-stops-at-start-the-ledger-is-newer).

## The harness stops at start: the ledger is newer

- **You see:** the harness keeps restarting, and its log has a `fatal` line with `this ledger is at schema version 13, newer than this code's 12: run a newer Thermite, or restore the ledger from before the upgrade` (the numbers vary).
- **Why:** a newer harness opened the rig's ledger and upgraded it. An older harness never opens a newer ledger, so that it can't damage the record.
- **Do:** run the newer harness image again: on the compose stack, rebuild from the newer commit; on a rig on a cluster, set control's images to the newer ones and press **Update to these images**. Going back to an older version needs the ledger from before the upgrade ([goal 035](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/035-rig-upgrades.goal)).

## A join command stops at a check and then doesn't work

- **You see:** the join command stops with a line such as `thermite: Podman is missing: install Podman 4.4 or later, then make a new join command`. Run again, it fails with curl's `The requested URL returned error: 401`.
- **Why:** a join command works once. It is used up when the machine fetches its script, before the script checks the machine ([goal 061](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/061-gaps-found-by-the-docs.goal)). The checks run before anything is written, so nothing was set up. In a namespace, a `kubectl apply` that fails uses the command up too.
- **Do:** fix what the message names. Then, on the rig's page, press **Make a new join command** and run the new one. After a failed check there is nothing to remove first, although the card asks you to. See [Join a rig yourself](../install/join-a-rig.md#4-make-a-new-one-or-revoke-it).

## A check failed

- **You see:** **Model route**, **Isolation** or **Judge smoke** shows **failed**.
- **Do:** read its sentence, and see [Check a rig](check-a-rig.md#read-the-result).

Two causes are common on a laptop:

- `not now: …`: the rig has open trials or judge jobs. Make it idle as [Check a rig](check-a-rig.md#before-you-start) says, then run the check again.
- **Judge smoke** fails with some candidates "judged otherwise", and the harness's log has `job failed` lines that say `target not ready for timing: load … above 75% of … cores`. The computer was too busy for fair timing. Close other heavy programs and run the check again.

## The isolation check failed

- **You see:** **Isolation** shows **failed**, with `isolation does NOT hold (devices: …):` and up to 12 items such as `agent-1 ledger: ALLOWED`.
- **Why:** each item is a role and a probe. `ALLOWED`: the role's user reached something it must not, such as the judge's files or a secret. `UNREADABLE`, `UNREACHABLE` or `WRONG GPUS`: a role was refused something it needs, or saw other GPUs than its own. `the device setup failed`: the rig's GPUs could not be split between the judge and the agents; the `devices:` part says why.
- **Do:**
  1. Pause the rig's runs, and start none on it until the check passes.
  2. Look up each probe in the [rig checks reference](../../reference/rig-checks.md#isolation-check). [Isolation inside a rig](../../explanation/isolation.md) explains what keeps each role apart.
  3. On an image you extended, compare with Thermite's own image ([Extend the harness image](../install/extend-harness-image.md)). For the device setup, check the rig's GPU settings ([Use several GPUs](../install/several-gpus.md)).
  4. Run the check again after each change. The harness also runs it every time it starts.

  If it still fails on Thermite's own image, ask for help with the whole sentence: see [Still stuck?](#still-stuck).

## A rig can't reach a model server on your network

- **You see:** **Model route** fails with `no answer in 120 s (is the model up?)`, or with `no tool call:` and a connection error, while the server answers on your computer.
- **Why:** the rig calls the model from its harness container. Inside a container, `localhost` is the container itself. A rig on a cluster reaches only DNS and addresses outside the private ranges, so a server on a private address is out of its reach.
- **Do:** on the local stack, use `host.docker.internal` in the provider's address (`host.containers.internal` with Podman). Give a rig on a cluster a hosted provider. See [Choose a model](../models/choose-a-model.md#2-a-model-server-on-your-own-computer).

## A campaign doesn't start: `staging:`

- **You see:** the run never appears. On **Commands**, in the sidebar, the **assign campaign** row is **failed**, and its **Outcome** holds `{"error":"staging: …"}`. The supervisor's log has a `staging failed` line with the same error, then `command not relayed`.
- **Why:** before the rig takes a campaign, its supervisor fetches the project, the kit and any model the command names. That fetch failed. The supervisor's log line `staged sources` means it worked.
- **Do:** read the reason:

| Reason after `staging:` | Do |
| --- | --- |
| `Git access <name>: control answered 404` | Control has no Git access of that name for this rig. Check the name in **Settings** (the cog at the foot of the sidebar) |
| `… has no commit …` | The commit is not in that repository, or the rig can't read it. For a private repository, see [Use a private repository](../campaigns/private-repository.md#5-check-that-the-rig-fetched-it) |
| `Command failed: git …` and git's message, such as `Host key verification failed` or `Permission denied (publickey)` | The rig can't read the repository. Give the campaign a [Git access](../campaigns/private-repository.md), or check the address |
| `<url>: HTTP <status>`, or `<url>: sha256 …, not …` | A model's address answered with an error, or its file is not the one the contract names |

## A campaign doesn't start: the kit does not fit the contract

- **You see:** the run never appears. On **Commands**, the **assign campaign** row is **failed**, and its **Outcome** has `the kit does not fit the contract:` and what doesn't fit, such as `cells names cell large, which the kit does not have` or `the kit measures on cuda-gpu, and this rig's target is cpu`.
- **Why:** when the rig takes a campaign, it checks the contract against the kit's `kit.json`. Every test case (a "cell" in `kit.json` and the contract), metric and verifier the contract names must be in the kit, and the kit's target must be the rig's. A kit with a broken `kit.json` fails with `has no valid kit.json:` instead.
- **Do:** fix the contract or the kit, then start the campaign again. See [Write a contract](../campaigns/write-a-contract.md) and [Write a kit](../campaigns/write-a-kit.md). For a kit described or uploaded on the **New campaign** page, the page runs the same check before it sends anything.

## Agents don't start

- **You see:** the harness's log says `agents wait for a model route`, and no trials start. Or the **New campaign** page won't start the run: `rig-1 has no model for its agents, so they could not work: choose one under "The agents' model".` On a campaign's page, **Start a run** says **Not started.** and `rig-1 has no model for its agents, so they could not work: choose one under "The agents' model", or give it one on its Edit rig page.`
- **Why:** the rig has no model yet. A run without agents (**Agents**: **Off: a try**) needs none.
- **Do:** [connect a model provider](../models/connect-a-provider.md) and give the rig one of its models, on **Settings › Providers**, or under **The agents' model** on the **New campaign** page or in the **Start a run** panel. From **Start a run**, control gives the rig the model first and says `rig-1 takes <model> within a minute. When the rig shows it, start the run again.`: press **Start a run** again once the rig's page shows the model. Until the rig has taken a model that control gave it, **Start a run** says **Not started.** and `rig-1 has not taken <model> yet (it does within a minute of being given it): start the run once its page shows that model.` If six trials in a row had already failed, the agents rest for 30 minutes; a new model, or resuming the run, ends that rest at once.

## A research campaign's trials all end in errors

- **You see:** each trial of a research run ends at once with an error that names the model.
- **Why:** research workers run in Pi or OpenCode v2, and the rig's model can't serve them there:

| The error | Do |
| --- | --- |
| `this rig has no model for its agents: give it one on its Edit rig page` | Give the rig a model: see [Agents don't start](#agents-dont-start) |
| `research workers run in Pi or OpenCode, and a Claude subscription runs only in Claude Code: give this rig another model for research` | Give the rig a model from another provider |
| `<model> is one of OpenCode's own models, which work only inside OpenCode: set this rig's agents' harness to OpenCode on its Edit rig page` | Set the workers' **Runs in** to **OpenCode v2** on **Edit rig** |

The dashboard refuses to start a research run with agents in the last case. A run started from the command line, or on a rig whose model changed after the start, can still meet it. See [Write a contract](../campaigns/write-a-contract.md#4-write-a-research-campaign).

## A trial stopped without a "trial ended" line

- **You see:** in a run's **Live**, a lane's trial started, but no "trial ended" line follows it. The lane's next trial may already have started.
- **Why:** the rig's harness restarted while the trial ran, for example after **Restart them**, **Update to these images**, a restart with your compose tool, or a crash. A restart stops the running trials. When the harness starts again, it closes them as `interrupted`, without a "trial ended" line. Control shows a trial as working only while the rig says it is at work, or for 15 minutes after its last line.
- **Do:** nothing. The lane goes on with a new trial, and a change the trial had already submitted stands. The trial's experiment goes back to the top of the queue: see [An experiment came back at the top of the queue](#an-experiment-came-back-at-the-top-of-the-queue).

## A message to the agents was refused

- **You see:** after **Send** in **Live**, your message never shows in the stream. Above the message box, a strip says **Not sent.** and why:
  - when control refused the message, its reason shows at once;
  - when the rig refused it, the strip says `The rig refused your last message:` and the rig's reason. It shows once the rig has answered, so press **refresh** in the status bar after a few seconds.

  On **Commands**, the message's **message agent** row is **failed**, with the rig's reason in **Outcome**. The strip stays until a later message to the run goes through. It also shows the rig's refusal of a message sent over MCP, the REST API or the command line.
- **Why:** the rig refuses a message that nothing would read, rather than keep it waiting for ever. The **To** list in **Live** greys out most of these recipients, with the reason, but a message sent over MCP or the REST API can still meet them:

| Reason in **Outcome** | Do |
| --- | --- |
| `run run-1 has no agents (the judge alone tries the kit): nothing would read this message` | The run is a try, without agents: nothing reads a message to everyone working, a lane, a trial or the planner. Write to the advisors, or start a run with agents |
| `a research run plans its rounds with a fixed method; it has no planner to message` | Write to everyone working, or to a lane |
| `the planner is off on this rig (Edit rig), so nothing would read this message`, or the same for the teacher pair, the auditor or the review panel | Switch the part on, on **Edit rig**, or write to someone else |
| `a research run has no audits, so the auditor would never read this message` | Write to the teachers instead |
| `this run has no goal the review panel reviews, so the panel would never read this message` | The panel reads messages only in a goal run with a goal it reviews |
| `none of the advisors would read this message:` and each one's reason | As above, for each advisor |
| `run run-1 has 2 lanes` | Choose a lane the run has |
| `run run-1 is closed: nothing will read this message` | The run has finished: nothing reads messages there |

If the message isn't on **Commands** at all, control refused it before signing it. **Live** shows control's reason in the **Not sent.** strip. A message from **Tell the planner**, on a run's **Planner** tab, shows neither refusal on that tab: look for its **message agent** row on **Commands**.

The rig itself checks only the **Edit rig** switches. So a message sent over MCP, the REST API or the command line to an advisor that has no model is accepted, and nothing reads it until you give the role a model ([Configure advisors](advisors.md)). **Live** greys such a role out, once the rig's supervisor has reported which advisors it has: `This rig's supervisor has no auditor set up, so nothing would read it.`

## A message shows, but nobody reads it

- **You see:** your message shows in **Live**, but no "✓ … read your message" line follows.
- **Why:** each agent reads a message at a set time, and the box's placeholder says when:
  - a Pi worker at its next step;
  - an OpenCode or Claude Code worker when its current run ends without a submission, which can take many minutes;
  - a worker that has already submitted doesn't read it: its lane's next trial does;
  - the planner at its next plan, and only when its model answers;
  - the teachers in a round that starts at once, for a run that is running;
  - the auditor and the review panel only with their next audit or review, which come only when the judge holds a result for audit or a goal waits for review;
  - when the rig hasn't said which program runs its agents, the placeholder says only that each agent reads it `when it can`.
- **Do:** wait. To have every new trial of a lane, or of all lanes, read a message, keep it in force with 📌 when you send it. [Steer a run](../campaigns/steer-a-run.md) has more on messages.

## A change to the queue or a rule didn't take

Each run has an [experiment queue](../campaigns/choose-what-runs-next.md): the experiments up next, in order, which the planner gives to free lanes, and the lanes' ideas, which wait for the planner or you.

- **You see:** on a run's **Experiments** or **Planner** tab, you pressed **Add**, **↑ Top**, **Drop it**, **Queue it**, **Drop** or **Remove**, or dragged an experiment. The page said `Control sent the command to rig-1. The rig does it in less than 10 seconds. This page shows the result.`, but the tab doesn't change. On **Commands**, the command's row, such as **queue move** or **drop directive**, is **failed**, with the rig's reason in **Outcome**.
- **Why:** most often, the queue changed on the rig before your command reached it. A lane took the experiment, or the planner queued or dropped an idea first. A change that worked shows on the tab after the rig's next report, within a minute by default.
- **Do:** press **refresh** in the status bar, and act on what the tab shows now.

A reason about one experiment names its state, then the rule: `only queued experiments move` after **↑ Top** or a drag, and `only proposed or queued experiments can be dropped` after **Drop**. For example, `experiment x-3f2a9c41d07e is assigned: only queued experiments move`.

| Reason in **Outcome** | Why |
| --- | --- |
| `experiment x-… is assigned: …` | A lane's trial is working on it: it shows under **In progress** |
| `experiment x-… is done: …` | Its trial has ended: it is under **Tried** |
| `experiment x-… is dropped: …` | Someone dropped it first: **Tried** says who, and why |
| `experiment x-… is queued, not a proposed idea` | The planner queued the idea before you pressed **Queue it** |
| `no experiment x-… in run run-1` | The run has no experiment with that id |
| `no rule 4 in force in run run-1` | The rule was removed already, or replaced, for example by the teachers' next set of rules |
| `run run-1 is closed: its queue no longer changes` | The run has finished |

## An experiment came back at the top of the queue

- **You see:** an experiment that a lane already worked on is first under **Up next** again. Its reason starts with `tried again: its trial on lane-2 was interrupted` or `… failed`, and the old experiment's id.
- **Why:** when a trial ends because it was interrupted, by **Pause**, **Restart the lanes** or a restart of the harness, or because of an error, its experiment was not really tried. It is marked as done, and a copy goes to the top of the queue, with the same author.
- **Do:** nothing, or press **Drop** on it if it should not be tried again. A trial that ended for another reason, such as its time running out, doesn't come back.

## History says the model's plan was refused

- **You see:** in a run's **History**, `The planner planned round 3 (its fallback plan: the model's plan was refused, because …)`, sometimes without a reason.
- **Why:** that round had no plan from the planner's model. In two tries, the model didn't answer or gave a plan that code refused; or the rig has no model for the planner; or the **Planner** switch is off on **Edit rig**. The reason after `because` names the first problem. The lanes then took experiments from the queue in order, by fixed rules: they skip directions that an **Avoid** rule names, and take those that an **Always** rule, then a **Try** rule, names first. Rules in your own words, rather than a direction's name, are applied only by the planner's model.
- **Do:** nothing is lost: the run goes on. If it happens every round, open the run's **Planner** tab. The **The planner** card names the planner's model, or says `No model: the lanes take the queue in order and keep to the rules.`, and counts the hand-outs made by the model and those made in queue order. Give the planner a model on **Edit rig**, or switch it on there ([Give each agent its own model](../models/model-per-agent.md)).

## Something was refused

Thermite says why it refuses something. Where you see it depends on how you asked:

- **The dashboard** shows `Not done.` and the reason on the rig and Providers pages, `Not started.` in a campaign's **Start a run** panel, and `Not sent.` above the message box in a run's **Live**. Some actions answer with a plain page that says `refused:` and the reason: use your browser's **Back** button. A command that control sent but the rig refused shows as **failed** on **Commands**, as for the [queue](#a-change-to-the-queue-or-a-rule-didnt-take).
- **The REST API** answers `401 {"error":"unauthorized"}` for a token that isn't the owner's, and `400 {"error":"invalid request"}` for a body with a wrong field, without saying which. Other refusals answer **500** with the reason, for example `{"error":"unknown rig rig-9"}` or `{"error":"bad pause_run payload: run: …"}`.
- **MCP** tools answer `{"error":"…"}` with the reason. A command kind that the token may not issue, such as `queue_add` with an agent's token, fails the tool's own input check with `Input validation error` instead.
- **A rig** that refuses a command marks it `rejected` or `failed` on **Commands**, with the reason in **Outcome**. For example, `not now: …` for a busy rig, or `<kind> is the owner's to issue, not …'s` for a command only the owner may give.

Control writes the dashboard's `Not done.`, `Not started.` and `refused:` answers, and failed requests, to its audit log as well. To list them over MCP, call `control_log` with `action: "refused"` or `action: "failed"`.

## Still stuck?

See [Getting help](../../project/getting-help.md) for where to ask, and include the log lines you found.
