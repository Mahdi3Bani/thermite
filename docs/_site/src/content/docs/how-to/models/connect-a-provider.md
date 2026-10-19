---
title: "Connect a model provider"
description: "Add an OpenAI-compatible, Anthropic or OpenCode provider on the Providers page and give a rig one of its models."
type: how-to
sidebar:
  order: 2
---

A **model provider** is a service that runs AI models: a hosted API, a gateway, or a model server on your own computer. You add each provider once, on the dashboard's **Providers** page. Control then reads the provider's model list, and you give each [rig](../../reference/glossary.md) the model its agents use.

This guide covers providers reached with an API key, or with no key for OpenCode's free models. For subscriptions, see [Use a Claude subscription](claude-subscription.md) and [Use a ChatGPT subscription](chatgpt-subscription.md). Not sure which model to use? Start with [Choose a model](choose-a-model.md).

## Before you start

- You are signed in to the dashboard, and the rig reports to control.
- You have the provider's base URL and API key. OpenCode's free models need neither.
- If the key is paid, decide how you will limit spending before you start a campaign on this model. Nothing stops research by default. What works on every rig: a stop time for each campaign (**Stop after (hours)** on the **New campaign** page, or `budget.wall_hours`), a spending limit at the provider if it has one, and **Pause** on the run.
- Don't count on the contract's money budget alone: `budget.llm_usd` counts only the workers' trials (their working sessions), never the planner or the advisors, and only on a rig that has token prices. Rigs that control sets up can't have them yet. See [Set a budget or a stop time](../campaigns/budget-and-stop-time.md) and [goal 061](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/061-gaps-found-by-the-docs.goal).

## Add the provider

1. Press the cog icon, **Settings**, at the foot of the sidebar.

   The **Providers** page opens. It has three blocks: **Providers**, **Add a provider**, and **Harness and model for each rig**.

2. In **Add a provider**, choose the **Type**. The group **Models by API key** has three types:

   | Type | Use it for | Base URL | API key |
   | --- | --- | --- | --- |
   | **OpenAI-compatible** | Most model servers and gateways: vLLM, LiteLLM, OpenRouter, Ollama | Required, ending in `/v1` | Required |
   | **Anthropic** | Anthropic's own API | Leave empty for `https://api.anthropic.com` | Required |
   | **OpenCode (its own models)** | OpenCode's own service. Its models run only in OpenCode v2 | Leave empty for `https://opencode.ai/zen/v1` | Leave empty for the free models |

3. Fill in the fields. Each label has an ⓘ icon; hover over it to read its description:

   | Field | Its ⓘ says | Example |
   | --- | --- | --- |
   | **Name** | "How it shows in Thermite, and how rigs and campaigns refer to it: for example my-litellm or github-deploy. Letters, digits, dots, dashes and underscores: capitals become lowercase and spaces become dashes." | `my-litellm` |
   | **Base URL** | "Where the provider's API is: for an OpenAI-compatible server, the address ending in /v1. Anthropic and OpenCode: leave it empty for their own." | `https://llm.example.com/v1` |
   | **API key** | "The provider's key. Control seals it at once and never shows it again. OpenCode: leave it empty for its free models." | |

   For a model server on the same computer as Thermite, use `http://host.docker.internal:PORT/v1`, or `host.containers.internal` with Podman. Inside a container, `localhost` is the container itself. An OpenAI-compatible provider always needs a key: if your server checks none, type any word without spaces.

4. Press **Add and list its models**.

   Control seals the key and reads the provider's model list at once. The page shows `"my-litellm" is saved and lists 12 models. Choose one for a rig below.` with your name and count.

   The provider now has a row under **Providers**: its name and type, how many models it lists, its base URL, the end of its key (for example `key …abcd`; OpenCode without a key shows `no key: its free models`), `not HTTPS` for an `http://` address, and which rigs use it. Open the row to see each model.

## Give a rig one of its models

1. In **Harness and model for each rig**, find the rig's row.
2. Choose the **worker harness**, the program the agents run in: **Pi**, **OpenCode v2** or **Claude Code**. Pi is the default. [Choose a model](choose-a-model.md#where-the-agents-run) says which worker harness works with which provider.
3. Choose the model. The list groups the models by provider. A group marked "OpenCode harness only" needs **OpenCode v2**. Without a key, OpenCode serves only the models whose names end in `-free`.
4. Press **Use**.

   The page shows `rig-1 takes my-model from "my-litellm" under Pi within a minute, and checks it.`

5. Wait a minute or two, then press **refresh** in the status bar, the line along the bottom of the page. Dashboard pages do not reload by themselves. Until the rig takes the model, its row says "taking my-model under Pi".

The rig's row now says "Its agents run under Pi with my-model from my-litellm." Below it you see the model check's result, for example "Its model check passed 1m ago: my-model answered with a correct tool call in 3.2 s". Press **Check** to run it again.

You can also give a rig its agents' model where you start a campaign, under **The agents' model** on the **New campaign** page ([Start a campaign from the dashboard](../campaigns/start-from-dashboard.md#4-where-it-runs)), or let an agent do it over MCP with [`set_rig_model`](../../reference/mcp-tools.md#set_rig_model). Both work like **Use** here.

A failed check says `Its model check FAILED`, then why. With OpenCode's free models, two reasons are common:

- `Rate limit exceeded. Please try again later.`: OpenCode limits free use. Press **Check** a few minutes later, or choose another model.
- `Model unavailable: opencode/<model>`: OpenCode lists that model but does not serve it. Choose another.

For other reasons, see [Check a rig](../operate/check-a-rig.md#read-the-result).

This gives the model to the rig's workers and, unless it has its own, to its planner. To give each agent its own model and effort, use the rig's **Edit rig** page: see [Give each agent its own model](model-per-agent.md).

### How the rig gets the model

Control keeps your choice. Every 30 seconds by default, the rig's supervisor asks control for the rig's model and hands any change to the rig's harness container, with the key. Only rigs that use one of a provider's models ever receive its key. The harness checks a new model at once, and each new trial and plan uses it. A trial that is already running keeps the model it started with.

## Add a model the list leaves out

Some providers serve models that their list does not show. Open the provider's row and type the model's id in **A model it does not list**. Its ⓘ says: "Some providers serve models their list leaves out. Add one by its id at the provider; it shows as yours." Press **Add it**. The model shows in the row with "· yours".

## Refresh, change or delete a provider

Open the provider's row:

- **Refresh models** reads the provider's list again. If the list fails, the row keeps its last list and shows the error in red.
- To change the type, the base URL or the key, edit the fields and press **Save and list its models**. Leave **API key** empty to keep the current key.
- **Delete this provider** removes it. A provider that a rig or an agent uses shows "In use: give its rigs another model before deleting it." instead. Give those rigs and agents another model first.

## If something goes wrong

Errors show in a card that starts with **Not done.**

| You see | What to do |
| --- | --- |
| "A new provider needs its API key." | Enter a key. Only OpenCode's own provider may have none. |
| "An OpenAI-compatible provider needs its base URL." | Enter the address, ending in `/v1`. |
| "The base URL is http or https, with no credentials, query or fragment in it." | Remove any `user:password@`, `?…` or `#…` from the address. |
| "…could not list its models: HTTP 401 (is the key right?)" (or 403) | Check the key. |
| "…could not list its models: HTTP 404 (is the base URL right?)" | Check the address. An OpenAI-compatible one ends in `/v1`. |
| "…could not list its models: no answer in 15 s" or "could not reach it to list its models" | Control cannot reach the address. For a server on your computer, use `host.docker.internal`, not `localhost`. |
| "OpenCode's free models run only in the OpenCode harness: choose OpenCode v2 for this rig." | Choose **OpenCode v2** for that rig. |
| "Claude Code runs only with a Claude subscription here: choose Pi or OpenCode v2 for this provider." | Choose **Pi** or **OpenCode v2**. |

The provider is saved even when its list fails. Fix the cause, then press **Refresh models**.

## Use the rig's own settings instead

A rig can also take its model from its own settings, the `THERMITE_MODEL_*` variables. The rig uses them only while control gives it no model: choose **its own settings** in the rig's model list to go back to them. They suit a rig that you set up and keep yourself, or a test without the dashboard.

| Setting | What it holds |
| --- | --- |
| `THERMITE_MODEL_BASE_URL` | The provider's address, ending in `/v1` |
| `THERMITE_MODEL` | The model's name at the provider |
| `THERMITE_MODEL_API_KEY_FILE` | A file holding the key. On the local stack: `.dev/secrets/model-api-key` |
| `THERMITE_MODEL_CONTEXT_WINDOW` | The model's context per request. `0` means unknown |
| `THERMITE_MODEL_MAX_TOKENS` | The longest reply, thinking included. Default `8192` |
| `THERMITE_MODEL_REASONING_EFFORT` | `none`, `low`, `medium` or `high`. Unset: nothing is sent |
| `THERMITE_MODEL_API` | `openai` (the default), `anthropic`, `opencode`, `claude` or `chatgpt` |
| `THERMITE_AGENT_HARNESS` | `pi` (the default), `opencode` or `claude-code` |

The rig needs the base URL, the model and a key, or its agents have no model. On the local stack, set the first two in your shell or in a `.env` file next to `compose.yaml`, put the key in `.dev/secrets/model-api-key`, and start the stack again, with your `-f` options if you use [override files](../install/one-machine.md#settings-and-override-files):

```sh
THERMITE_MODEL_BASE_URL=http://host.docker.internal:8000/v1 THERMITE_MODEL=my-model \
  docker compose up -d
```

If the rig has a model from control, choose **its own settings** for it in **Harness and model for each rig** and press **Use**. Within a minute the rig's row says "Its agents use the rig's own settings (my-model, under Pi)", followed by the model check's result.

If you change only the key file, restart the harness so that it reads the file again: `docker compose restart harness`.

The local `compose.yaml` passes only the first six settings to the rig ([goal 061](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/061-gaps-found-by-the-docs.goal)). To set `THERMITE_MODEL_API` or `THERMITE_AGENT_HARNESS` on the local stack, put them on the harness container in an override file next to `compose.yaml`. For example, to run the workers in OpenCode v2:

```yaml title="compose.model.yaml"
services:
  harness:
    environment:
      THERMITE_AGENT_HARNESS: opencode
```

Then start the stack with both files, and name both in every later `up`:

```sh
docker compose -f compose.yaml -f compose.model.yaml up -d   # or: podman compose -f … -f … up -d
```

The [settings reference](../../reference/settings.md) describes every setting.
