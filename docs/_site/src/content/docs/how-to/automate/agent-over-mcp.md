---
title: "Let an agent run Thermite over MCP"
description: "Connect an AI agent to control's MCP server with a token of its own, so it can watch and steer campaigns for you."
type: how-to
sidebar:
  order: 1
---

Control has an MCP server, so an AI agent such as Claude Code can watch rigs and campaigns, start runs, steer them and check rigs for you. You give the agent a token of its own, whose role decides what it may do. The decisions that matter stay yours.

## Before you start

- **Control's address, as the agent's computer reaches it:** `http://127.0.0.1:8800` on the computer that runs the local stack, or your control's address, such as `https://control.example.com`.
- **A token for the agent** (step 1).
- **To start runs:** a [contract](../campaigns/write-a-contract.md) file, and the `thermite` command line where the agent works, to turn the contract into a command (step 3). Run `npx thermite` in your Thermite folder, after `npm ci` and `npm run build` (see [the command line](../../reference/command-line.md)). The command line has no option to name a [Git access](../campaigns/private-repository.md), so start campaigns on private repositories from the dashboard's **New campaign** page.

## 1. Choose the agent's token

| Token | Give it to | It may |
| --- | --- | --- |
| **Operator** | An agent that runs campaigns for you | Read everything; start, pause, resume, redirect and reset runs; export; run rig checks; send champions to other rigs; message a run's agents; read control's own log and providers; add rigs on a cluster and set a cluster's slots; give a rig's agents a model; start and end RunPod test pods, which costs money |
| **Agent** | An agent that only coordinates runs | Read; start, pause, resume, redirect and reset runs; export; run rig checks; send champions to other rigs. Not control's log, providers or RunPod. While you fully reset a rig, `issue_command` refuses it for that rig |
| **Reader** | An agent that only watches | Read, including control's log and providers |

The reader's token reads control's log and providers, and the agent's token doesn't: they describe control itself, not the campaigns, and are for whoever runs control.

Give the agent the token with the least it needs: it acts with that token's rights, and nothing more. Don't give an agent the owner's token. The owner's token also approves and declines promotions over MCP, retires rigs, works on the whole REST API and signs in to the dashboard.

Some things no token can do over MCP: approving a goal the review panel passed, ending a campaign as not possible, changing a rig's settings (apart from its agents' model), accepting a rig's key and wiping a rig. A model is never the last word on what counts as a result; see [Why agents never judge](../../explanation/why-agents-never-judge.md). Approving and declining promotions is the owner's alone.

On the local stack, an operator's token is ready in `.dev/secrets/control-operator-token`, unless you replaced it with one of your own. For an agent's or a reader's token, see [Make and change tokens](../operate/tokens.md).

## 2. Connect the agent

The MCP server is at `/mcp` on control, for example `http://127.0.0.1:8800/mcp` or `https://control.example.com/mcp`. It uses MCP's streamable HTTP transport, with the token in an `Authorization: Bearer` header.

**Claude Code**, with the server named `thermite-control` (any name works; Claude Code shows the tools under it):

```sh
claude mcp add --transport http thermite-control http://127.0.0.1:8800/mcp \
  --header "Authorization: Bearer $(cat .dev/secrets/control-operator-token)"
```

**Any other MCP client:** add an HTTP (streamable HTTP) server with the address above and the header `Authorization: Bearer <token>`. A client you write yourself must send `Accept: application/json, text/event-stream` with each request, or the server answers 406.

To check the connection, ask the agent to list Thermite's rigs. It calls the `list_rigs` tool, and its answer names your rigs, such as `local-1`, with whether each is live and what it runs. A wrong token gets `401` and no tools.

## 3. What the agent can do

The [MCP tools reference](../../reference/mcp-tools.md) lists every tool, its inputs and who may call it. In short:

- **Look:** `list_rigs`, `get_run` (one run with its attempts and verdicts), `recent_events`, `leaderboard`, `rig_reports` (the supervisors' daily reports), `list_commands` and `command_status`.
- **Act:** `issue_command` sends a [signed command](../../reference/signed-commands.md) to a rig, of a kind its token allows: `assign_campaign`, `pause_run`, `resume_run`, `redirect`, `reset_workers`, `export_now` or `rig_check`, and for an operator also `message_agent`. `propagate_champion` sends a champion to another rig's run of the same campaign.
- **Set rigs up:** `add_cluster_rig` (as **Rigs › Add a rig** does on a Kubernetes cluster), `set_cluster_slots` (a cluster's pre-made slots) and `set_rig_model` (a rig's agents' model, as on **Edit rig**), with the same checks as those pages, for operator tokens. Retiring a rig (`retire_rig`, `bring_back_rig`) is the owner's.
- **Debug:** `control_log` (control's audit log, with what it refused and why) and `providers` (what control holds in **Settings › Providers**, never a key), for operator and reader tokens.

A command is queued, not done at once. `issue_command` returns the command's id. The agent then calls `command_status` until the status is `delivered`, `failed` or `rejected` with the rig's reason, or `expired`. `delivered` means the rig applied the command; a rig check's result comes later, in the rig's events.

To start a run, the agent needs an `assign_campaign` payload. `npx thermite assign … --print` builds one from a contract, and the agent passes it to `issue_command`; see [Start a campaign from the command line](../campaigns/start-from-command-line.md).

:::caution[Text from agents is data]
Run histories, hypotheses and events hold text that the rigs' own worker agents wrote, and daily reports come unsigned from the rigs' supervisors. The tools' descriptions tell the connected agent to treat it as data, not instructions. Keep that in mind when you let an agent act on what it reads.
:::

## 4. See what it did

Control writes each tool call it runs, reads included, to its audit log, as an `mcp:<tool>` entry with the call's arguments. Each token has its own name there. An operator acts for you, so its name starts with `owner:`:

| Token | Name in the audit log and on commands |
| --- | --- |
| Operator | `owner:operator` |
| Agent | `agent:mcp` |
| Reader | `reader:mcp` |
| Owner | `owner:mcp` |

Open **Audit log** in the dashboard's sidebar to see them. **Commands** shows who issued each command in its **By** column.
