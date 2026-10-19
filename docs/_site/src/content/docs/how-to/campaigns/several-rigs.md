---
title: "Run a campaign on several rigs"
description: "Run one campaign on more than one rig, and have another rig confirm the best result."
type: how-to
sidebar:
  order: 10
---

One campaign can run on several [rigs](../../reference/glossary.md) at once, each with its own run, agents and judge. You can then send one rig's [champion](../../reference/glossary.md) to another rig, whose judge tests it again on its own hardware. If it holds up there too, the result is **cross-verified**.

:::caution[Sending champions needs a shared results repository]
Rigs send each other champions through one [results repository](../operate/results-repository.md) that they all push to. Rigs that control sets up on machines and clusters, and rigs you join yourself, have no results repository yet ([goal 061](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/061-gaps-found-by-the-docs.goal)). They can run the same campaign side by side, but can't send each other champions, so nothing is cross-verified. Of the rigs Thermite sets up, only the local compose stack's two rigs, on one computer, can.
:::

## Before you start

- Two or more rigs that report to control, with the target (CPU or GPU) of the campaign's kit.
- To send champions between rigs, every rig involved pushes its results to **the same results repository**: the supervisor setting `THERMITE_RESULTS_REMOTE` is the same on each. See [Set up the results repository](../operate/results-repository.md). The local stack does this already. Start its second rig, `local-2`, with `docker compose --profile two-rigs up -d`.
- Each rig's **Exports** switch, on **Edit rig**, is on. It is on unless you turned it off.

## 1. Start a run on each rig

A rig runs one run at a time, so each rig gets its own run.

- **A campaign made on the New campaign page:** on its page, use the **Start another run** card. Choose the next **Rig**, keep **with agents**, and press **Start the run**.
- **A campaign started from the command line:** run `thermite assign` again for each rig, with the same contract and starting commit. See [Start a campaign from the command line](start-from-command-line.md).

Every run must start from the same commit, as **Start another run** does: a rig can take another rig's champion only when it has the commit that champion started from.

The campaign's page now has a table of its runs, with **Cross-verified** for a hill climb, and tabs above the run's views to switch between runs.

## 2. Publish a champion

A champion beyond the starting point can be sent once its rig has published it, with its next export. Exports happen every hour when there is something new. To publish at once, open the rig's page and press **Export now**.

## 3. Send the champion to another rig

1. Open the run that has the champion, and its **Steering** view.
2. Beside **Send champion #N**, choose the receiving run, shown as `<rig> / <run>`. The list holds other rigs' runs of the same campaign.
3. Press **Send champion #N**.

The dashboard opens the receiving run. The receiving run must be running when the champion arrives: if it is paused or closed, the command fails, and **Commands** in the sidebar shows the reason, such as `run sort-speed-1 is paused`. Resume the run, then send the champion again.

You can also send it with the owner's token over the REST API, `POST /v1/propagate` with `{"from_rig": "local-1", "run": "sort-speed-1", "to_rig": "local-2", "to_run": "sort-speed-1"}`, or with the MCP tool `propagate_champion` and the same four fields.

## 4. Check the result

The receiving rig rebuilds the champion from its patch, checks that it matches what the source rig published, and its own judge measures it against its own champion, like any other change. The receiving run's **History** shows `Champion #3 arrived from local-1 to be judged here.`, then `Another rig's champion held up here too.` or `Another rig's champion did not hold up here (…).` with the verdict.

A confirmed change waits there as any other change would: a gain above the contract's audit limit (15% unless set), or a run that asks you every time, puts it under **Needs you** on **Overview** as **Your decision**. `Another rig's champion held up here too.` comes once you press **Make it the champion**. See [Decide what waits for you](decide-what-waits.md).

When it holds up and becomes the receiving run's champion, the source run is cross-verified by the receiving rig. The campaign page's **Cross-verified** column names the rigs, or says **not yet**. `GET /v1/leaderboard` and the MCP tool `leaderboard` list them under `verified_by`, and the page `/ui/leaderboard` shows them for every hill climb.

If the receiving run's champion is already the same code, nothing is judged, and the source is not marked cross-verified.

## If it is refused

The dashboard shows `refused:` and the reason:

| Reason | What it means |
| --- | --- |
| `the source run has no champion beyond its seed` | Nothing has won yet |
| `champion seq N is not published yet (it is published with the rig's next export)` | Wait for the export, or press **Export now** |
| `<run> runs <campaign>, not <campaign>` | The receiving run is another campaign's |
| `the target works on <repo>, the champion is in <repo>` | The two runs work on different projects |

If the receiving rig can't find the champion in the results repository, the command stays **pending** on the **Commands** page and expires after 24 hours. Check that both rigs push to the same results repository: each rig's page shows **Results** with `pushed … ago`, or `no results repository`.
