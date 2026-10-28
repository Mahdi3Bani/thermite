---
title: "Run the message bus"
description: "Check the message bus beside control, open its port to rigs on other machines and clusters, and turn it off."
type: how-to
sidebar:
  order: 11
---

The message bus carries the rigs' reports and live lines to control, and control's commands and each rig's config to the rigs, as soon as each is there. It is a NATS server with JetStream, and it runs beside control: the compose stack's `nats` service. This page says how to tell that it works, what to open so that rigs on other machines and clusters reach it, what control keeps for its certificate, and how to turn it off. [How the parts talk](../../explanation/how-the-parts-talk.md#reports-over-the-message-bus) explains what travels on it and why.

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

## Turn it off

To run everything over HTTP, as Thermite did before the bus, set `THERMITE_NATS_URL` to nothing in `.env`, then start the stack again:

```sh title=".env (part)"
THERMITE_NATS_URL=
```

Control and both of the stack's supervisors then leave the bus, and `/v1/health` says `"bus":"off"`. The `nats` container still starts: on the files control wrote while the bus was on, or, on a new stack, it waits for them, which control no longer writes. Control reads nothing from it. Rigs that control sets up from then on get no bus.

A rig that control set up on a machine or a cluster while the bus was on keeps the bus's address until it moves onto new images: what it publishes there reaches no one until then. Turn the bus off before you set such rigs up, or move each onto new images after. To turn the bus on again, take the line out of `.env` and start the stack again.

A rig on RunPod never uses the bus: control reaches it in [pull mode](../../explanation/trust.md#rigs-in-pull-mode), on or off.
