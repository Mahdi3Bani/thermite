import {
  type ConsumerConfig,
  type ConsumerMessages,
  JetStreamApiCodes,
  JetStreamApiError,
  jetstream,
  jetstreamManager,
  type MsgRequest,
  type StreamConfig,
} from "@nats-io/jetstream";
import { connect, headers, type NatsConnection, nkeyAuthenticator } from "@nats-io/transport-node";
import { reloadSubject } from "../core/link/users.ts";
import { log } from "./env.ts";

/**
 * The message bus (goal 168): a NATS server with JetStream, which control runs. Control and the
 * rigs' supervisors reach it through this module alone, which hides the NATS library behind a few
 * calls: a publish that waits for the server's ack, a durable consumer whose messages are handed
 * over one at a time, a stream made, and a message removed. The harness and the agents never
 * reach the bus.
 */

/** The setting that names the server. Not set: the part keeps to HTTP. */
export const BUS_URL_SETTING = "THERMITE_NATS_URL";
/** How long a connection attempt may take: the call that needed it fails, the next tries again. */
export const BUS_CONNECT_TIMEOUT_MS = 10_000;
/** How long a publish waits for the server's ack. It then fails; the message may be kept or not. */
export const BUS_ACK_TIMEOUT_MS = 30_000;
/** How long a consumer, or a stream not made, waits after a failure to try again. */
export const BUS_RETRY_MS = 5_000;
/** How many messages on a subject a removal looks at, at most: then it says it found none. */
export const BUS_REMOVE_LOOK_MAX = 1000;
/** How long a request for the server to reload its users may wait for the answer. It then fails. */
export const BUS_RELOAD_TIMEOUT_MS = 10_000;

/** The server's ack: the message's place in the stream, and whether it had the message's id. */
export interface Published {
  seq: number;
  duplicate: boolean;
}

/** A message from a stream, as the code that handles it sees it. */
export interface BusMessage {
  subject: string;
  /** Its place in the stream. */
  seq: number;
  data: Uint8Array;
  header(name: string): string | undefined;
}

/**
 * How a part signs in to the bus: the seed of its user key, which the server checks against the
 * key's public part in its users; and, for a rig, the start of the subjects it takes replies on,
 * the only ones its user may subscribe to.
 */
export interface BusSignIn {
  seed: Uint8Array;
  inboxPrefix?: string | undefined;
}

export type StreamSettings = Partial<StreamConfig> & { name: string };
export type ConsumerSettings = Partial<ConsumerConfig> & { durable_name: string };

/**
 * What a handler answers for a message: nothing, and the message is acked; or `againInMs`, and it
 * is handed again after that long, while the messages after it go on.
 */
export type Handled = undefined | { againInMs: number };

export interface Bus {
  /**
   * Publishes one message and waits for the server's ack. A message whose id the stream had within
   * its duplicate window is acked as a duplicate and not kept again.
   */
  publish(
    subject: string,
    data: string,
    o: { id: string; headers?: Record<string, string> | undefined },
  ): Promise<Published>;
  /**
   * Makes sure the stream and its durable consumer exist, then hands each message to `handle`, in
   * order, one at a time, and acks it when `handle` returns, unless it asks for it again. A
   * message `handle` throws on is handed again after BUS_RETRY_MS. Runs until the bus is closed.
   * `stream` is its settings, and the stream is made or brought to them first; or its name alone,
   * for a stream another part makes, which is waited for.
   */
  follow(
    stream: StreamSettings | string,
    consumer: ConsumerSettings,
    handle: (m: BusMessage) => Handled | Promise<Handled>,
  ): Promise<void>;
  /**
   * Makes the stream, or brings an existing one to these settings, and tries again every
   * BUS_RETRY_MS until it has, or the bus is closed.
   */
  makeStream(stream: StreamSettings): Promise<void>;
  /**
   * Removes the message with this id from the stream, looking among the messages on its subject.
   * False when it is not there, as when a work queue's consumer took it already.
   */
  remove(stream: string, subject: string, id: string): Promise<boolean>;
  close(): Promise<void>;
}

/** The bus's address from its setting, or undefined when not set. A bad one stops the part. */
export function busUrl(env: Record<string, string | undefined>): string | undefined {
  const raw = env[BUS_URL_SETTING]?.trim();
  if (!raw) return undefined;
  let url: URL | undefined;
  try {
    url = new URL(raw);
  } catch {
    url = undefined;
  }
  if (url?.protocol !== "nats:" || !url.hostname)
    throw new Error(
      `${BUS_URL_SETTING} takes a nats:// address, such as nats://nats:4222, not "${raw}"`,
    );
  return raw;
}

/** The server's host and port, for logs: never a user or password in its address. */
const where = (url: string) => new URL(url).host;

/** Logs the connection's changes: a drop, a reconnect, an error from the server. */
async function watch(nc: NatsConnection, server: string): Promise<void> {
  log("bus", "connected", { server });
  for await (const s of nc.status()) {
    if (s.type === "disconnect") log("bus", "disconnected; reconnecting", { server }, "warn");
    else if (s.type === "reconnect") log("bus", "reconnected", { server });
    else if (s.type === "error")
      log("bus", "server error", { server, error: String(s.error) }, "warn");
  }
}

/** Makes the stream, or brings an existing one to these settings. */
async function ensureStream(nc: NatsConnection, stream: StreamSettings): Promise<void> {
  const jsm = await jetstreamManager(nc);
  try {
    await jsm.streams.info(stream.name);
  } catch (err) {
    if (!(err instanceof JetStreamApiError && err.code === JetStreamApiCodes.StreamNotFound))
      throw err;
    await jsm.streams.add(stream);
    log("bus", "stream made", { stream: stream.name });
    return;
  }
  await jsm.streams.update(stream.name, stream);
}

/** Makes the durable consumer unless it exists. */
async function ensureConsumer(
  nc: NatsConnection,
  stream: string,
  consumer: ConsumerSettings,
): Promise<void> {
  // No check of the account's JetStream first: a rig's user may not read the account's figures.
  const jsm = await jetstreamManager(nc, { checkAPI: false });
  try {
    await jsm.consumers.info(stream, consumer.durable_name);
  } catch (err) {
    if (err instanceof JetStreamApiError && err.code === JetStreamApiCodes.StreamNotFound)
      throw new Error(`no stream ${stream} on the bus yet: control makes it`, { cause: err });
    if (!(err instanceof JetStreamApiError && err.code === JetStreamApiCodes.ConsumerNotFound))
      throw err;
    await jsm.consumers.add(stream, consumer);
    log("bus", "consumer made", { stream, consumer: consumer.durable_name });
  }
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The bus at `url`, as `name` (the part and its rig, shown in the server's list of connections),
 * signed in with `signIn` when given. It connects on first use, and again after a connection fails
 * or the client gave one up, as after the server refused its user; the NATS client reconnects on
 * its own after a drop.
 */
export function natsBus(url: string, name: string, signIn?: BusSignIn): Bus {
  const server = where(url);
  let conn: Promise<NatsConnection> | undefined;
  let closed = false;
  let reading: ConsumerMessages | undefined;
  const connection = (): Promise<NatsConnection> => {
    if (conn) return conn;
    const made = connect({
      servers: url,
      name,
      timeout: BUS_CONNECT_TIMEOUT_MS,
      maxReconnectAttempts: -1,
      ...(signIn
        ? { authenticator: nkeyAuthenticator(signIn.seed), inboxPrefix: signIn.inboxPrefix }
        : {}),
    }).then(
      (nc) => {
        void watch(nc, server);
        // Given up (its user refused twice running): the next call connects again.
        void nc.closed().then(() => {
          if (conn === made) conn = undefined;
        });
        return nc;
      },
      (err: unknown) => {
        conn = undefined;
        throw err;
      },
    );
    conn = made;
    return made;
  };
  return {
    async publish(subject, data, o) {
      const nc = await connection();
      const h = headers();
      for (const [k, v] of Object.entries(o.headers ?? {})) h.set(k, v);
      const ack = await jetstream(nc)
        .publish(subject, data, { msgID: o.id, headers: h, timeout: BUS_ACK_TIMEOUT_MS })
        .catch((err: unknown) => {
          // The library's words for a subject no stream takes, as before control made it.
          if (err instanceof Error && err.name === "JetStreamNotEnabled")
            throw new Error(`no stream on the bus takes ${subject} yet: control makes it`, {
              cause: err,
            });
          throw err;
        });
      return { seq: ack.seq, duplicate: ack.duplicate };
    },
    async follow(stream, consumer, handle) {
      const name = typeof stream === "string" ? stream : stream.name;
      // A failure is logged as an error once, and again only after following worked.
      let failing = false;
      while (!closed) {
        try {
          const nc = await connection();
          if (typeof stream !== "string") await ensureStream(nc, stream);
          await ensureConsumer(nc, name, consumer);
          const c = await jetstream(nc).consumers.get(name, consumer.durable_name);
          reading = await c.consume();
          failing = false;
          log("bus", "following", { stream: name, consumer: consumer.durable_name });
          for await (const m of reading) {
            let handled: Handled;
            try {
              handled = await handle({
                subject: m.subject,
                seq: m.seq,
                data: m.data,
                header: (k) => m.headers?.get(k) || undefined,
              });
            } catch (err) {
              // Handed again after the wait; a consumer with one message in flight hands no later
              // message first.
              m.nak(BUS_RETRY_MS);
              throw err;
            }
            if (handled) m.nak(handled.againInMs);
            else m.ack();
          }
        } catch (err) {
          if (closed) break;
          const error = String(err);
          const level = failing ? "debug" : "error";
          log("bus", "following failed; trying again", { stream: name, error }, level);
          failing = true;
        } finally {
          reading?.stop();
          reading = undefined;
        }
        if (!closed) await pause(BUS_RETRY_MS);
      }
    },
    async makeStream(stream) {
      let failing = false;
      while (!closed) {
        try {
          await ensureStream(await connection(), stream);
          return;
        } catch (err) {
          if (closed) break;
          const what = { stream: stream.name, error: String(err) };
          log("bus", "making the stream failed; trying again", what, failing ? "debug" : "error");
          failing = true;
        }
        await pause(BUS_RETRY_MS);
      }
    },
    async remove(stream, subject, id) {
      const jsm = await jetstreamManager(await connection());
      let after = 0;
      for (let looked = 0; looked < BUS_REMOVE_LOOK_MAX; looked++) {
        // The server finds the next message on a subject from a place in the stream; the library's
        // type for this call names only the other two ways to ask (by place, and the last one).
        const next = { next_by_subj: subject, seq: after + 1 } as unknown as MsgRequest;
        const m = await jsm.streams.getMessage(stream, next);
        if (!m) return false;
        if (m.header.get("Nats-Msg-Id") === id)
          return await jsm.streams.deleteMessage(stream, m.seq);
        after = m.seq;
      }
      return false;
    },
    async close() {
      closed = true;
      reading?.stop();
      const nc = await conn?.catch(() => undefined);
      await nc?.close();
    },
  };
}

/**
 * Asks the server at `url` to read its configuration again, as control's system user (`seed`):
 * the users file control wrote takes effect without a restart, and the connections of a user it
 * no longer has are closed. Throws when the server can't be reached, refuses the user, or says the
 * reload failed.
 */
export async function reloadBus(url: string, seed: Uint8Array): Promise<void> {
  const nc = await connect({
    servers: url,
    name: "control (reloads)",
    timeout: BUS_CONNECT_TIMEOUT_MS,
    maxReconnectAttempts: 0,
    authenticator: nkeyAuthenticator(seed),
  });
  try {
    const id = nc.info?.server_id;
    if (!id) throw new Error("the bus's server gave no id");
    const m = await nc.request(reloadSubject(id), "", { timeout: BUS_RELOAD_TIMEOUT_MS });
    const answer = m.json<{ error?: { description?: string } }>();
    if (answer.error)
      throw new Error(
        `the bus's server did not reload: ${answer.error.description ?? "no reason"}`,
      );
  } finally {
    await nc.close();
  }
}
