---
title: "Exports"
description: "Where a rig's exports go, what control keeps of them, the supervisor's export figures, and how control tells that a rig's results have left it."
type: reference
sidebar:
  order: 19
---

An [export](glossary.md) is what a rig's harness writes when something new happened: the new attempts, champions, events and notes since the last export, and a copy of its ledger. The rig's supervisor sends each export off the rig. This page says where it goes, what control keeps of it, how the supervisor reports it, and how control tells that a rig's results have left it. [Get a rig's results from control](../how-to/operate/exports-on-control.md) gives the steps.

```sh
curl -fsS -H "Authorization: Bearer $(cat .dev/secrets/control-admin-token)" \
  http://127.0.0.1:8800/v1/rigs/rig-1/results-left
```

```json
{"left":true,"why":"every export has left the rig: they are on control","to":"control","waiting":0,"champions_waiting":0,"reported_at":"2026-10-20T12:01:00.000Z"}
```

## Where exports go

| The rig's supervisor has | Its exports go to | The rig's **Results** row says |
| --- | --- | --- |
| A results repository (`THERMITE_RESULTS_REMOTE`) | The results repository, pushed with git. See [Set up the results repository](../how-to/operate/results-repository.md) | `N exports · pushed … ago` |
| No results repository, and a control | Control, sent over control's API with the rig's token | `N exports · sent to control … ago`, or `sent to control: none yet` |
| Neither | Nowhere: they stay in the supervisor's own repository, in its volume | `no results repository` |

The rigs that control sets up on machines and clusters, and the rigs you join yourself, have no results repository, so their exports go to control. The local compose stack has one. Champion patches go to control in every case, so you can [download a run's champion](../how-to/campaigns/take-the-result.md).

An export leaves the harness's outbox only once it is safe: pushed to the results repository, or kept in full on control. Until then the supervisor tries again every round (`THERMITE_POLL_SECONDS`, 60 seconds by default).

## What goes to control

Every file the export's manifest lists, each with the SHA-256 the manifest gives it. The copy of the ledger (`ledger.sqlite`) goes with the first export, then at most once a day, and with every full export: the same rule as the results repository's ledger branch. A ledger copy never holds held-out results.

## How an export is sent

1. The supervisor starts the export on control with its manifest and the size of each file it sends. Control refuses a list that leaves out a file of the manifest (the ledger copy aside), or names one the manifest does not list.
2. It sends each file in pieces of up to 8 MiB, each at the place control says it has. When a send breaks, the next round goes on from there.
3. When a file's last byte arrives, control checks its SHA-256 against the manifest. It keeps the file only if they match; otherwise it deletes it, and the supervisor sends it again.
4. The export is complete when every file it promised is kept. Then the supervisor tells the harness, and the export leaves the outbox.

The routes are in the [REST API reference](rest-api.md#routes-used-by-rigs). A rig whose control reaches it through a proxy (a RunPod pod) sends the same requests through its tunnel.

## Where control keeps them

| Place | What |
| --- | --- |
| `THERMITE_CONTROL_DIR`, under `exports/<rig>/<export>/manifest.json` | The export's manifest, as the harness wrote it |
| `THERMITE_CONTROL_DIR`, under `exports/<rig>/<export>/files/` | Each file, at its path in the export. A file still arriving ends in `.part` |
| Control's database | Each export: its manifest, the files it promised with their sizes and SHA-256, which arrived, and when the last one did |

Control never deletes an export. They take room in control's state volume until you remove them yourself.

## The supervisor's export figures

The supervisor reports these every round, unsigned. They are `supervisor.export` in `GET /v1/rigs/<rig>/view`.

| Field | Meaning |
| --- | --- |
| `remote` | Whether it has a results repository |
| `to` | Where its exports go: `repository`, `control` or `none` |
| `exports` | Exports it has taken from the outbox |
| `pushed`, `pushed_commit`, `last_push_at` | The newest 50 exports in the results repository, the commit the last push left there, and when |
| `uploaded`, `last_upload_at` | The newest 50 exports control holds in full, and when the last one was complete |
| `waiting` | Exports still on the rig: not yet taken from the outbox, or taken and not yet pushed or kept on control |
| `champions_waiting` | Champion patches not yet on control |
| `last_error` | The last push's or send's error, or an export that failed its check |

## Have all results left the rig?

Control answers this from the rig's latest supervisor report and, for exports on control, from its own copy. A RunPod pod's terminate waits for it, and so does its stop, for 15 minutes at most ([Stop, start, restart and terminate](rest-api.md#stop-start-restart-and-terminate)). `GET /v1/rigs/<rig>/results-left` asks it, with the owner's token; `?export=<name>` also asks about that export.

The answer is yes only when all of these hold:

- the supervisor has reported, and its report says where its exports go and how many wait;
- no export waits on the rig (`waiting` is 0);
- for a rig that sends to control, no champion patch waits either;
- with `export`: for a results repository, the supervisor reports that export pushed; for control, control holds every file of it.

Results recorded after the rig's last export are in no export yet. To include them, export first (**Export now**, or the `export_now` command) and ask about that export by name.

| Field | Meaning |
| --- | --- |
| `left` | The answer |
| `why` | Why not, or where they are, in plain words |
| `to` | `repository`, `control`, or `null` when the report does not say |
| `waiting`, `champions_waiting` | The report's counts, or `null` |
| `reported_at` | When control received the report it read |

| `why` | Meaning |
| --- | --- |
| `the rig's supervisor has not reported yet` | No report |
| `the rig has no results repository, and its supervisor does not send exports to control (an older version)` | A supervisor from before exports went to control |
| `the rig's supervisor does not say what waits to leave (an older version)` | The report has no `waiting` |
| `<n> exports wait on the rig to go to control` | Not yet sent. Also for the results repository |
| `<n> champion patches wait on the rig to go to control` | Not yet uploaded |
| `export <name> is not in the results repository yet` | Not yet pushed |
| `export <name> has not reached control yet` | Not started on control |
| `export <name> is on its way to control: <k> of <n> files arrived` | Partly sent |
| `every export has left the rig: they are on control` | Yes. Or `in the results repository` |

## A full reset

A [full reset](../how-to/operate/rig-lifecycle.md#fully-reset-a-rig) waits at `verifying` until its full export has left the rig in the same way: reported pushed to the results repository, or held in full on control. For a rig without either, the reset fails with `the rig has no results repository, and its supervisor does not send exports to control (an older version): its export cannot be verified`.

## Errors

The supervisor's `last_error`, on the rig's **Results** row and on **Rigs** as `Its last export failed: …`:

| Error | Meaning |
| --- | --- |
| `upload failed: …` | A send to control failed: control could not be reached, or answered with an error. The export waits and goes again next round |
| `upload failed: export <name>: control answered 503: control keeps no exports: it has no folder for them` | A control started without its exports folder. The export waits |
| `export <name> refused: …` | The export does not match its own manifest. It is never sent, and stays in the outbox |
| `export <name>: control has another export named <name> from this rig` | Control already holds a different export by that name. It is not sent again, and stays in the outbox |
| `export <name> is no longer in the outbox` | The export went before it was sent, for example in a wipe. It is not sent |

The **Results** row also says `· N waiting to leave the rig` while exports wait.
