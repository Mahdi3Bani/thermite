---
title: "Get a rig's results from control"
description: "Find the exports a rig without a results repository sent to control, download their files, and check that every result has left the rig before you remove it."
type: how-to
sidebar:
  order: 10
---

A rig without a [results repository](results-repository.md), such as a rig that control set up on a machine or a cluster, or a rig on a GPU cloud, sends its exports to control. Control checks every file against the export's manifest and keeps it. This page lists those exports, downloads their files, and checks that a rig's results have all left it, for example before you remove the rig.

## Before you start

- The owner's token in a file. These steps use the local install's, `.dev/secrets/control-admin-token`.
- `curl`, and `jq` for the loop in step 3.
- A rig whose page says, on the **Results** row of **The rig** block, `N exports · sent to control … ago`. A rig with a results repository says `pushed … ago` instead: its results are there.

## 1. Export now

On the rig's page, press **Export now**. Wait a minute or two, then press **refresh** in the status bar. The **Results** row says `sent to control` a moment ago, and no longer says `waiting to leave the rig`.

## 2. List the rig's exports

```sh
TOKEN=$(cat .dev/secrets/control-admin-token)
curl -fsS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8800/v1/rigs/rig-1/exports
```

```json
{"exports":[{"name":"20261020T120000Z-0123abcd","full":false,"from_event":180,"through_event":245,"files":14,"files_kept":14,"bytes":5230113,"bytes_received":5230113,"created_at":"2026-10-20T12:00:03.120Z","complete_at":"2026-10-20T12:00:09.877Z"}]}
```

Newest first. An export with `complete_at` set holds every file it promised, each checked. One with `null` is still arriving.

## 3. Download an export's files

The export's own listing names each file with its size and SHA-256:

```sh
NAME=20261020T120000Z-0123abcd
curl -fsS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8800/v1/rigs/rig-1/exports/$NAME
```

Download them all into a folder of the same name:

```sh
curl -fsS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8800/v1/rigs/rig-1/exports/$NAME \
  | jq -r '.files[] | select(.kept) | .path' | while read -r p; do
      mkdir -p "$NAME/$(dirname "$p")"
      curl -fsS -H "Authorization: Bearer $TOKEN" -o "$NAME/$p" \
        "http://127.0.0.1:8800/v1/rigs/rig-1/exports/$NAME/file?path=$(jq -rn --arg p "$p" '$p|@uri')"
    done
```

Each answer carries the file's SHA-256 in the header `x-thermite-sha256`. Compare it, or the listing's `sha256`, with `sha256sum` on Linux (`shasum -a 256` on a Mac). [Set up the results repository](results-repository.md#what-gets-pushed) says what each file holds. A run's champion is also a patch you can [download from the run's page](../campaigns/take-the-result.md).

## 4. Check that every result has left the rig

```sh
curl -fsS -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:8800/v1/rigs/rig-1/results-left?export=$NAME"
```

```json
{"left":true,"why":"every export has left the rig: they are on control","to":"control","waiting":0,"champions_waiting":0,"reported_at":"2026-10-20T12:01:00.000Z"}
```

With `"left":false`, `why` says what still waits, such as `1 export waits on the rig to go to control`. Wait for the next round, a minute by default, and ask again. [Have all results left the rig?](../../reference/exports.md#have-all-results-left-the-rig) lists every answer.

With `"left":true` for the export you made in step 1, everything the rig recorded up to that export is on control. You can now [remove the rig](rig-lifecycle.md#remove) without losing its results.
