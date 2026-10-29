---
title: "Run the message bus"
description: "Check the message bus beside control, follow control's events to it and back, open its port to rigs on other machines and clusters, give it more memory or disk, and turn the rigs off it."
type: how-to
sidebar:
  order: 11
---

The message bus carries the rigs' reports and live lines to control, and control's commands and each rig's config to the rigs, as soon as each is there, and it keeps control's copy of every rig's events, from which control writes its records. It is a NATS server with JetStream, and it runs beside control: the compose stack's `nats` service. Control needs it, and does not start without it. This page says how to tell that it works, what you see while control copies its events to it and applies them from there, what to open so that rigs on other machines and clusters reach it, what control keeps for its certificate, how to give it more memory or disk, and how to keep the rigs off it. [How the parts talk](../../explanation/how-the-parts-talk.md#reports-over-the-message-bus) explains what travels on it and why.

```sh
docker compose ps nats                      # or: podman compose ps nats
curl -fsS http://127.0.0.1:8800/v1/health   # {"ok":true,"bus":"connected"}
```

## Before you start

- Thermite runs from the compose file of a release, or of the source code: [Install Thermite on one machine](../install/one-machine.md).
- Your owner's token, for `GET /v1/bus`.

## Check it

1. List the `nats` container:

   ```sh
   docker compose ps nats     # or: podman compose ps nats
   ```

   Its status starts with `Up` and ends with `(healthy)`: its health check asks the server, on the container's own loopback, whether it answers with JetStream on. While control has not yet written the server's users and certificate, the server waits, its log says `waiting for control to write the bus's users and certificate`, and the check fails.
2. Ask control:

   ```sh
   curl -fsS http://127.0.0.1:8800/v1/health
   ```

   `"bus":"connected"` says control holds a connection to the server now; `"away"` says it holds none and tries again every 5 seconds. The answer is 200 in both: control's own pages and routes serve whatever the bus does, though what control writes from the rigs' new events waits for the bus.
3. For the bus's streams and what each consumer still has to take, ask `GET /v1/bus` with the owner's token, or call the MCP tool `bus_state`: [The message bus](../../reference/rest-api.md#the-message-bus).

A rig on the bus has the step "Its key on the message bus registered" in its history, on its page. A rig that never got that step reports over HTTP.

## Follow control's events to the bus and back

Control copies every event it holds to the bus's `EVENTS` stream, and each new one as it arrives, whether its rig reported it over the bus or over HTTP. From that stream, in its order, control then writes what it derives from the events: a run a rig created in its run registry, a command's outcome as the harness gave it, each model call's usage, and the knowledge base's items ([Control's events on the message bus](../../explanation/how-the-parts-talk.md#controls-events-on-the-message-bus)). Control's other pages still read its own copy of the events. When control starts, it copies the events the stream lacks, the first time all of them, and applies the stream from the place its store applied through, the first time from its start. Control serves and takes reports meanwhile; a million events took about 41 seconds to copy when measured.

1. Read control's log as it starts:

   ```sh
   docker compose logs control | grep "events"     # or: podman compose logs control | grep "events"
   ```

   `control's records go on from the events stream's place` says where control applies from (`place`), the stream's last place (`last`) and how many messages it has to apply (`behind`). `control's events go on the bus after the stream's last` says where the copy starts and how many events it has to copy (`behind`). For more than 1,000, `moving control's events to the bus` follows every 100,000, with how many it `copied` and how many are `left`, and `control's events moved to the bus` says when it is done, and in how many seconds.
2. Or ask the bus's state, with the owner's token:

   ```sh
   curl -fsS -H "Authorization: Bearer $(cat .dev/secrets/control-admin-token)" http://127.0.0.1:8800/v1/bus
   ```

   Under `events`, `behind` falls to 0 while `stream_seq` climbs to `table_seq`; under `events.apply`, `behind` falls to 0 while `place` climbs to `last_place`. After that, each report's events follow within a second. `/metrics` has the same figures, `thermite_events_behind` and `thermite_events_unapplied` among them.

To tell that it worked: both `behind` are 0, both `stopped` are `null`, and under `streams` the `EVENTS` stream holds as many messages as control has events.

If `waiting` names a reason, such as `the bus's store is full`, the copy or the apply waits for the bus and tries again every 5 seconds: give the bus more disk (below), or bring its server back. If the copy's `stopped` names an event, with its rig, ledger, seq and size, the copy stopped there: an event control kept before it refused events too large for the bus. Control tries again when it starts again; the events after it wait.

If control stops as it starts, with `control's store is past the events stream's end` in its log and the reason `control's store has applied the EVENTS stream to place …, past its last, …`, its store holds records of events the stream no longer has, as when the bus's volume was restored from a backup older than control's store, or removed. Control does not go on with such a store: the stream's next events would be skipped. Restore the stream from a backup at least as new as the store, or the store from one no newer than the stream, and start control again.

## Let rigs on other machines reach it

A rig that control sets up on a machine or a cluster, or that you join yourself, reaches the bus from outside the compose stack, on NATS's own port, 4222, over TLS. Compose publishes the port on this computer's `127.0.0.1` only. To open it:

1. Publish it on the computer's addresses. In `.env`:

   ```sh title=".env (part)"
   THERMITE_NATS_PUBLISH=0.0.0.0:4222
   ```

   Or give one address of the computer in place of `0.0.0.0`.
2. Let the rigs' machines and clusters reach TCP port 4222 on this computer, in its firewall and in any firewall between them. Unlike control's port, the bus needs no reverse proxy: its TLS is its own.
3. If the rigs reach the bus at another name or port than control's address for rigs (`THERMITE_CONTROL_PUBLIC_URL`) and 4222, name it in `.env`:

   ```sh title=".env (part)"
   THERMITE_NATS_PUBLIC_URL=nats://bus.example.com:4222
   ```

   Control gives this address to every rig it sets up, and names its host in the server's certificate.
4. Start the stack again, with your `-f` options:

   ```sh
   docker compose up -d     # or: podman compose up -d
   ```

Each rig set up from then on gets the bus's address and the certificate of control's authority with its other files. A rig set up before gets them when it moves onto new images (**Update to** control's version, or **Update to these images** on a cluster): until then, it reports over HTTP as before.

To tell that it worked: from a rig's machine, `nc -zv control.example.com 4222` connects, and the rig's page shows "Its key on the message bus registered". A rig that can't reach the port never reports: its setup ends with "no report after 10 minutes", and its supervisor's log says `following failed; trying again` or `making the stream failed; trying again`.

## The certificate

Every connection to the bus is over TLS. Control keeps its own certificate authority for it, beside its signing key in its state folder (the `control-state` volume): `bus-ca.pem` and `bus-ca.key`. It makes them at its first start with the bus, valid for 10 years, and signs the server's certificate with them:

- **The server's certificate** names the hosts control and the rigs reach the bus by: `nats`, and the host of `THERMITE_NATS_PUBLIC_URL` or of control's address for rigs. It is valid for 397 days. Control makes a new one when the names change, and when the certificate ends within 30 days; the server takes it without a restart, and the rigs' connections stay. Control's log says `the bus's server certificate made`.
- **The rigs** trust the server through the authority's certificate alone, which control gives each rig it sets up: as a file on a machine and in the compose stack, in the supervisor's environment on a cluster. A connection that does not come from such a rig, or that trusts another authority, is refused, and so is one without TLS.

Keep `bus-ca.key` with control's other state: a backup of the `control-state` volume holds it. If it is lost, delete `bus-ca.pem` too and start control again: it makes a new authority, and every rig on the bus needs its certificate again, by moving onto new images. Until then those rigs can't connect.

## Give it more memory or disk

The bus keeps its messages on disk, on the `nats-data` volume. The `EVENTS` stream keeps every rig's events for good, so the store grows with the rigs' history. Its memory holds the index of each stream's subjects and the blocks a read loads. Compose gives it 256 MiB, and tells the server's Go runtime 78% of that, so that it frees what a read loaded before the limit is reached. Its disk is 75% of the volume's free space when it starts.

1. In `.env`, set either or both:

   ```sh title=".env (part)"
   THERMITE_NATS_MEMORY=512m
   THERMITE_NATS_STORE=20G
   ```

   Keep `THERMITE_NATS_STORE` under what the disk has free: at the limit, the bus refuses new messages and keeps the old, but a server whose disk itself is full turns JetStream off.
2. Start the stack again, with your `-f` options:

   ```sh
   docker compose up -d     # or: podman compose up -d
   ```

To tell that it worked: the server's log as it starts, `docker compose logs nats`, says `Max Memory` at 75% of what Go is told (149.76 MB for 256 MiB), and `Max Storage` at the store's size (`20G` shows as 18.63 GB).

## Keep the rigs off it

Control always uses its bus: it keeps every rig's events there. A rig may still report over HTTP, and take its commands and config from control's API, as Thermite did before the bus: control keeps its events on the bus all the same. To keep the compose stack's own rigs off the bus, set `THERMITE_NATS_URL` to nothing in `.env`, then start the stack again:

```sh title=".env (part)"
THERMITE_NATS_URL=
```

Both of the stack's supervisors then report over HTTP. Control stays on the bus, and `/v1/health` still says `"bus":"connected"`. The line never reaches control: its own `THERMITE_NATS_URL` is fixed in the compose file. Take the line out of `.env` and start the stack again to put the rigs back on the bus.

A rig that control sets up on a machine or a cluster gets the bus's address with its other files, and reports over the bus: open the bus's port to it ([Let rigs on other machines reach it](#let-rigs-on-other-machines-reach-it)). A rig whose supervisor has no `THERMITE_NATS_URL`, such as one you join yourself without it, reports over HTTP.

A rig on RunPod never uses the bus: control reaches it in [pull mode](../../explanation/trust.md#rigs-in-pull-mode), and keeps its events on the bus as it keeps any rig's.

A control without `THERMITE_NATS_URL` stops at start, with `control needs its message bus: set THERMITE_NATS_URL to its NATS server, such as nats://nats:4222. …` in its log.
