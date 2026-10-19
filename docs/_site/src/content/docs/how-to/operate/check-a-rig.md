---
title: "Check a rig"
description: "Run a rig's model, isolation and smoke checks, and read what they found."
type: how-to
sidebar:
  order: 1
---

A rig can check itself in three ways: that its model answers, that its agents are kept away from the judge, and that its judge gives known changes the verdicts they should get. Run the checks after you set a rig up, after a new version, and after you change its model.

| Check | On the dashboard | What it tells you | How long |
| --- | --- | --- | --- |
| Model route | **Model route** | The rig's model answers a request with a correct tool call, the way its agents use it | Seconds; at most 2 minutes |
| Isolation | **Isolation** | Each agent's user is refused what it must not reach: the judge's files, secrets, other agents' work, devices outside its share | Seconds |
| Smoke | **Judge smoke** | The judge gives each change in a known set its expected verdict, on this rig's own device | A few minutes on a CPU, up to an hour on a GPU |

A result reaches the dashboard with the rig's next report, which comes every minute. The [rig checks reference](../../reference/rig-checks.md) describes each check in full.

## Before you start

- The rig reports to control: its page says it is live.
- For **Isolation** and **Judge smoke**, the rig must be idle. **Judge smoke** pauses the rig's running runs itself and resumes them after. For **Isolation**, pause its runs first, because each probe ends the processes of the role it tests.
- For **Model route**, the rig needs a model. See [Connect a model provider](../models/connect-a-provider.md).

## Run a check on the dashboard

1. Open **Rigs** and choose the rig.
2. Find the **Checks** block. Each check shows **not run yet**, **running**, **passed** or **failed**, with when it ran.
3. Press **Run it** beside the check.

   The page says that control sent the command, and that the rig does it in less than 10 seconds.

4. Wait, then press **refresh** in the status bar at the foot of the page. Dashboard pages do not reload by themselves.

The check shows **passed** or **failed** and one sentence about what it found. The same sentence goes to the rig's history.

While **Judge smoke** runs, a run named `check-smoke-` and eight letters and digits appears under **Campaigns**. You can open it and watch the judge work. It closes when the check is done.

## Run a check from the command line or an agent

The dashboard sends a signed `rig_check` command. You can send the same command yourself.

With the command line and the owner's token:

```sh
npx thermite command --control http://127.0.0.1:8800 --token-file .dev/secrets/control-admin-token \
  --rig local-1 --kind rig_check --payload '{"check":"smoke"}'
```

Use `"model"`, `"isolation"` or `"smoke"` for `check`. The command prints the command's id and `"status":"pending"`. The result appears on the rig's page and in its history, as above.

Over MCP, an agent, operator or owner token can send it with the `issue_command` tool, kind `rig_check`. See [Let an agent run Thermite over MCP](../automate/agent-over-mcp.md).

:::caution[Forcing a check]
A busy rig refuses a check with `not now:` and the reason. The command accepts `"force": true` to run it anyway, which ends whatever the check's probes touch. Use it only when you know what is running. The dashboard never forces a check.
:::

## Read the result

| You see | It means | What to do |
| --- | --- | --- |
| Model route **passed**: "*model* answered with a correct tool call in *n* s" | The model works for the agents | Nothing |
| Model route **failed**, "no answer in 120 s (is the model up?)" | The model server did not answer | Check the server and the provider's base URL |
| Model route **failed**, "no tool call" | The model answered but did not call the tool | Choose a model that supports tool calling |
| Model route **failed**, "no model route" | The rig has no model | [Connect a model provider](../models/connect-a-provider.md) |
| Smoke **passed**: "smoke on smoke-cpu: all 12 candidates were judged as expected" | The judge works on this device | Nothing |
| Smoke **failed**: "*k* of *n* candidates were judged otherwise" | Some known change got the wrong verdict | Read the names it lists, then see [Troubleshoot](troubleshoot.md) |
| "the *check* check is still running" | That check has not finished | Wait for it |
| "not now: …" | The rig is busy | Pause its runs, or wait, then run the check again |

The harness also runs the isolation check on its own each time it starts, before it does anything else, so a rig's page usually already shows a recent result.
