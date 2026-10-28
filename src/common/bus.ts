import {
  type ConsumerConfig,
  type ConsumerMessages,
  JetStreamApiCodes,
  JetStreamApiError,
  jetstream,
  jetstreamManager,
  type StreamConfig,
} from "@nats-io/jetstream";
import { connect, headers, type NatsConnection } from "@nats-io/transport-node";
import { log } from "./env.ts";

/**
 * The message bus (goal 168): a NATS server with JetStream, which control runs. Control and the
 * rigs' supervisors reach it through this module alone, which hides the NATS library behind two
 * calls: a publish that waits for the server's ack, and a durable consumer whose messages are
 * handed over one at a time. The harness and the agents never reach the bus.
 */

/** The setting that names the server. Not set: the part keeps to HTTP. */
export const BUS_URL_SETTING = "THERMITE_NATS_URL";
/** How long a connection attempt may take: the call that needed it fails, the next tries again. */
export const BUS_CONNECT_TIMEOUT_MS = 10_000;
/** How long a publish waits for the server's ack. It then fails; the message may be kept or not. */
export const BUS_ACK_TIMEOUT_MS = 30_000;
/** How long a consumer waits after a failure (no server, a message not handled) to start again. */
export const BUS_RETRY_MS = 5_000;

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

export type StreamSettings = Partial<StreamConfig> & { name: string };
export type ConsumerSettings = Partial<ConsumerConfig> & { durable_name: string };

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
   * order, one at a time, and acks it when `handle` returns. A message `handle` throws on is handed
   * again after BUS_RETRY_MS. Runs until the bus is closed.
   */
  follow(
    stream: StreamSettings,
    consumer: ConsumerSettings,
    handle: (m: BusMessage) => void | Promise<void>,
  ): Promise<void>;
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
  const jsm = await jetstreamManager(nc);
  try {
    await jsm.consumers.info(stream, consumer.durable_name);
  } catch (err) {
    if (!(err instanceof JetStreamApiError && err.code === JetStreamApiCodes.ConsumerNotFound))
      throw err;
    await jsm.consumers.add(stream, consumer);
    log("bus", "consumer made", { stream, consumer: consumer.durable_name });
  }
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The bus at `url`, as `name` (the part and its rig, shown in the server's list of connections).
 * It connects on first use, and again after a connection fails; the NATS client reconnects on its
 * own after a drop.
 */
export function natsBus(url: string, name: string): Bus {
  const server = where(url);
  let conn: Promise<NatsConnection> | undefined;
  let closed = false;
  let reading: ConsumerMessages | undefined;
  const connection = (): Promise<NatsConnection> => {
    conn ??= connect({
      servers: url,
      name,
      timeout: BUS_CONNECT_TIMEOUT_MS,
      maxReconnectAttempts: -1,
    }).then(
      (nc) => {
        void watch(nc, server);
        return nc;
      },
      (err: unknown) => {
        conn = undefined;
        throw err;
      },
    );
    return conn;
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
      // A failure is logged as an error once, and again only after following worked.
      let failing = false;
      while (!closed) {
        try {
          const nc = await connection();
          await ensureStream(nc, stream);
          await ensureConsumer(nc, stream.name, consumer);
          const c = await jetstream(nc).consumers.get(stream.name, consumer.durable_name);
          reading = await c.consume();
          failing = false;
          log("bus", "following", { stream: stream.name, consumer: consumer.durable_name });
          for await (const m of reading) {
            try {
              await handle({
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
            m.ack();
          }
        } catch (err) {
          if (closed) break;
          const error = String(err);
          const level = failing ? "debug" : "error";
          log("bus", "following failed; trying again", { stream: stream.name, error }, level);
          failing = true;
        } finally {
          reading?.stop();
          reading = undefined;
        }
        if (!closed) await pause(BUS_RETRY_MS);
      }
    },
    async close() {
      closed = true;
      reading?.stop();
      const nc = await conn?.catch(() => undefined);
      await nc?.close();
    },
  };
}
