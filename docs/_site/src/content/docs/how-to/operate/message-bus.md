---
title: "Run the message bus"
description: "Check the message bus beside control, follow the move of control's events to it, open its port to rigs on other machines and clusters, give it more memory or disk, and turn it off."
type: how-to
sidebar:
  order: 11
---

The message bus carries the rigs' reports and live lines to control, and control's commands and each rig's config to the rigs, as soon as each is there, and it keeps control's copy of every rig's events. It is a NATS server with JetStream, and it runs beside control: the compose stack's `nats` service. This page says how to tell that it works, what you see while control copies its events to it, what to open so that rigs on other machines and clusters reach it, what control keeps for its certificate, how to give it more memory or disk, and how to turn it off. [How the parts talk](../../explanation/how-the-parts-talk.md#reports-over-the-message-bus) explains what travels on it and why.

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

   `"bus":"connected"` says control holds a connection to the server now; `"away"` says it holds none and tries again every 5 seconds; `"off"` says the bus is turned off. The answer is 200 in all three: control's own pages and routes serve whatever the bus does.
3. For the bus's streams and what each consumer still has to take, ask `GET /v1/bus` with the owner's token, or call the MCP tool `bus_state`: [The message bus](../../reference/rest-api.md#the-message-bus).

A rig on the bus has the step "Its key on the message bus registered" in its history, on its page. A rig that never got that step reports over HTTP.

## Follow the move of control's events

With the bus, control copies every event it holds to the bus's `EVENTS` stream, and each new one as it arrives ([Control's events on the message bus](../../explanation/how-the-parts-talk.md#controls-events-on-the-message-bus)). Nothing reads the stream yet, so nothing you see on control's pages changes. When control starts, it copies the events the stream lacks: the first time, all of them. Control serves and takes reports meanwhile; a million events took about 41 seconds when measured.

1. Read control's log as it starts:

   ```sh
   docker compose logs control | grep "events"     # or: podman compose logs control | grep "events"
   ```

   `control's events go on the bus after the stream's last` says where the copy starts and how many events it has to copy (`behind`). For more than 1,000, `moving control's events to the bus` follows every 100,000, with how many it `copied` and how many are `left`, and `control's events moved to the bus` says when it is done, and in how many seconds.
2. Or ask the bus's state, with the owner's token:

   ```sh
   curl -fsS -H "Authorization: Bearer $(cat .dev/secrets/control-admin-token)" http://127.0.0.1:8800/v1/bus
   ```

   Under `events`, `behind` falls to 0 while `stream_seq` climbs to `table_seq`; after that, each report's events follow within a second. `/metrics` has the same figures, `thermite_events_behind` among them.

To tell that it worked: `behind` is 0, `stopped` is `null`, and under `streams` the `EVENTS` stream holds as many messages as control has events.

If `waiting` names a reason, such as `the bus's store is full`, the copy waits for the bus and tries again every 5 seconds: give the bus more disk (below), or bring its server back. If `stopped` names an event, with its rig, ledger, seq and size, the copy stopped there: an event control kept before it refused events too large for the bus. Control works as before, and tries again when it starts again.

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

## Turn it off

To run everything over HTTP, as Thermite did before the bus, set `THERMITE_NATS_URL` to nothing in `.env`, then start the stack again:

```sh title=".env (part)"
THERMITE_NATS_URL=
```

Control and both of the stack's supervisors then leave the bus, and `/v1/health` says `"bus":"off"`. Control keeps its events in its own store, as before; when you turn the bus on again, it copies to the bus the events it took meanwhile. The `nats` container still starts: on the files control wrote while the bus was on, or, on a new stack, it waits for them, which control no longer writes. Control reads nothing from it. Rigs that control sets up from then on get no bus.

A rig that control set up on a machine or a cluster while the bus was on keeps the bus's address until it moves onto new images: what it publishes there reaches no one until then. Turn the bus off before you set such rigs up, or move each onto new images after. To turn the bus on again, take the line out of `.env` and start the stack again.

A rig on RunPod never uses the bus: control reaches it in [pull mode](../../explanation/trust.md#rigs-in-pull-mode), on or off.
