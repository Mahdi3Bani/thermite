import { X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import { type ConnectionOptions, checkServerIdentity } from "node:tls";
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
import {
  connect,
  errors,
  headers,
  type NatsConnection,
  nkeyAuthenticator,
  type TlsOptions,
} from "@nats-io/transport-node";
import { reloadSubject } from "../core/link/users.ts";
import { log } from "./env.ts";

/**
 * The message bus (goal 168): a NATS server with JetStream, which control runs. Control and the
 * rigs' supervisors reach it through this module alone, which hides the NATS library behind a few
 * calls: a publish that waits for the server's ack, a durable consumer whose messages are handed
 * over one at a time, a key-value bucket watched from the latest of each key, a subject's last
 * message, a stream made, a message removed, and the streams' state. Every connection is over
 * TLS, and trusts the server through the authority it is given (control's own, which control hands
 * every rig it sets up), or else the system's. The harness and the agents never reach the bus.
 */

/** The setting that names the server. Not set: the part keeps to HTTP. */
export const BUS_URL_SETTING = "THERMITE_NATS_URL";
/** The settings that give a supervisor the authority it trusts the server through: the PEM itself… */
export const BUS_CA_SETTING = "THERMITE_NATS_CA";
/** …or a file that holds it, read at each connection. */
export const BUS_CA_FILE_SETTING = "THERMITE_NATS_CA_FILE";
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
/** How many consumers of a stream its state lists, at most: then it says how many it left out. */
export const BUS_STATE_CONSUMERS_MAX = 200;

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
  /** The authority the server's certificate must come from; none: the system's authorities. */
  trust?: BusTrust | undefined;
}

/** The certificate authority a part trusts the bus's server through: its PEM, or a file of it. */
export type BusTrust = { ca: string } | { caFile: string };

/** A stream as the server has it now, with what each of its consumers has still to take. */
export interface StreamState {
  name: string;
  messages: number;
  bytes: number;
  /** How many subjects hold its messages. */
  subjects: number;
  /** When its oldest and its newest message came; null while it holds none. */
  first_at: string | null;
  last_at: string | null;
  consumers: {
    name: string;
    /** Messages it has not been handed yet. */
    pending: number;
    /** Messages it was handed and has not acked yet. */
    ack_pending: number;
    /** Messages it was handed more than once. */
    redelivered: number;
  }[];
  /** Consumers past BUS_STATE_CONSUMERS_MAX, left out of the list. */
  consumers_left_out: number;
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
   * As follow, for a key-value bucket's reader: the durable consumer is made again each time
   * watching starts, and after a failure, so `handle` gets the newest message of each subject the
   * consumer takes first (its deliver policy `last_per_subject`), then each new one. The stream is
   * another part's, and is waited for.
   */
  watch(
    stream: string,
    consumer: ConsumerSettings,
    handle: (m: BusMessage) => Handled | Promise<Handled>,
  ): Promise<void>;
  /** The newest message on `subject`; undefined when it has none, or there is no such stream. */
  last(stream: string, subject: string): Promise<BusMessage | undefined>;
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
  /** The state of each of these streams the server has; a stream not made yet is left out. */
  streams(names: readonly string[]): Promise<StreamState[]>;
  /** Whether the part holds a connection to the server now. */
  connected(): boolean;
  close(): Promise<void>;
}

/**
 * Whether the server refused a publish for good, so that the same message would be refused
 * again: its user may not publish to the subject, or the stream refused the message itself. Any
 * other failure, such as no ack in time or no stream yet, may pass.
 */
export function refusedForGood(err: unknown): boolean {
  let e: unknown = err;
  for (let depth = 0; e instanceof Error && depth < 5; depth++, e = e.cause)
    if (e instanceof errors.PermissionViolationError || e instanceof JetStreamApiError) return true;
  return false;
}

/**
 * The bus's address from its setting (`setting`: another that names one), or undefined when not
 * set. A bad one stops the part.
 */
export function busUrl(
  env: Record<string, string | undefined>,
  setting = BUS_URL_SETTING,
): string | undefined {
  const raw = env[setting]?.trim();
  if (!raw) return undefined;
  let url: URL | undefined;
  try {
    url = new URL(raw);
  } catch {
    url = undefined;
  }
  if (url?.protocol !== "nats:" || !url.hostname)
    throw new Error(`${setting} takes a nats:// address, such as nats://nats:4222, not "${raw}"`);
  return raw;
}

/**
 * The authority a supervisor trusts the bus's server through, from its settings: the certificate
 * itself (THERMITE_NATS_CA, as a rig on a cluster gets it), or a file of it (THERMITE_NATS_CA_FILE,
 * read at each connection, so that it may come after the supervisor starts); undefined when neither
 * is set, and the system's authorities serve. Both set, or a certificate that is not an
 * authority's, stops the part at start.
 */
export function busTrust(env: Record<string, string | undefined>): BusTrust | undefined {
  const ca = env[BUS_CA_SETTING]?.trim();
  const caFile = env[BUS_CA_FILE_SETTING]?.trim();
  if (ca && caFile) throw new Error(`set ${BUS_CA_SETTING} or ${BUS_CA_FILE_SETTING}, not both`);
  if (caFile) return { caFile };
  if (!ca) return undefined;
  let authority = false;
  try {
    authority = new X509Certificate(ca).ca;
  } catch {
    authority = false;
  }
  if (!authority)
    throw new Error(
      `${BUS_CA_SETTING} takes the PEM certificate of the authority that signed the bus's server's certificate`,
    );
  return { ca: `${ca}\n` };
}

/** The server's host and port, for logs: never a user or password in its address. */
const where = (url: string) => new URL(url).host;

/** The host of a nats:// address, as a certificate names it: no brackets round an IPv6 one. */
export const busHost = (url: string) => new URL(url).hostname.replace(/^\[(.*)\]$/, "$1");

/**
 * The client's TLS options: always TLS, with the authority when one is given. A server reached at
 * an address, not a name, is checked against the certificate's addresses: the NATS client gives
 * Node's TLS no name then, and Node would check the certificate against "localhost".
 */
function tlsOf(trust: BusTrust | undefined, url: string): TlsOptions {
  const host = busHost(url);
  if (!isIP(host)) return trust ?? {};
  const byAddress: TlsOptions & Pick<ConnectionOptions, "checkServerIdentity"> = {
    ...trust,
    checkServerIdentity: (_name, cert) => checkServerIdentity(host, cert),
  };
  return byAddress;
}

/**
 * Logs the connection's changes (a drop, a reconnect, an error from the server) and tells
 * `up` whether the connection holds now.
 */
async function watch(nc: NatsConnection, server: string, up: (on: boolean) => void): Promise<void> {
  log("bus", "connected", { server });
  up(true);
  for await (const s of nc.status()) {
    if (s.type === "disconnect") {
      up(false);
      log("bus", "disconnected; reconnecting", { server }, "warn");
    } else if (s.type === "reconnect") {
      up(true);
      log("bus", "reconnected", { server });
    } else if (s.type === "error")
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

/** Makes the durable consumer unless it exists; `again`: removes it first, and makes it anew. */
async function ensureConsumer(
  nc: NatsConnection,
  stream: string,
  consumer: ConsumerSettings,
  again = false,
): Promise<void> {
  // No check of the account's JetStream first: a rig's user may not read the account's figures.
  const jsm = await jetstreamManager(nc, { checkAPI: false });
  if (again)
    await jsm.consumers.delete(stream, consumer.durable_name).catch((err: unknown) => {
      // Not there to remove: made below. No such stream: said below, as for any consumer.
      const gone: number[] = [JetStreamApiCodes.ConsumerNotFound, JetStreamApiCodes.StreamNotFound];
      if (!(err instanceof JetStreamApiError && gone.includes(err.code))) throw err;
    });
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
  let up = false;
  /** The consumers being read now, each by its own loop: a close stops them all. */
  const readings = new Set<ConsumerMessages>();
  const connection = (): Promise<NatsConnection> => {
    if (conn) return conn;
    const made = connect({
      servers: url,
      name,
      timeout: BUS_CONNECT_TIMEOUT_MS,
      maxReconnectAttempts: -1,
      tls: tlsOf(signIn?.trust, url),
      ...(signIn
        ? { authenticator: nkeyAuthenticator(signIn.seed), inboxPrefix: signIn.inboxPrefix }
        : {}),
    }).then(
      (nc) => {
        void watch(nc, server, (on) => {
          up = on;
        });
        // Given up (its user refused twice running): the next call connects again.
        void nc.closed().then(() => {
          up = false;
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
  /** Follows or watches a consumer (`again`: made anew each time), until the bus is closed. */
  const consume = async (
    stream: StreamSettings | string,
    consumer: ConsumerSettings,
    handle: (m: BusMessage) => Handled | Promise<Handled>,
    again: boolean,
  ): Promise<void> => {
    const name = typeof stream === "string" ? stream : stream.name;
    // A failure is logged as an error once, and again only after following worked.
    let failing = false;
    while (!closed) {
      let reading: ConsumerMessages | undefined;
      try {
        const nc = await connection();
        if (typeof stream !== "string") await ensureStream(nc, stream);
        await ensureConsumer(nc, name, consumer, again);
        const c = await jetstream(nc).consumers.get(name, consumer.durable_name);
        reading = await c.consume();
        readings.add(reading);
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
        if (reading) {
          reading.stop();
          readings.delete(reading);
        }
      }
      if (!closed) await pause(BUS_RETRY_MS);
    }
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
    follow(stream, consumer, handle) {
      return consume(stream, consumer, handle, false);
    },
    watch(stream, consumer, handle) {
      return consume(stream, consumer, handle, true);
    },
    async last(stream, subject) {
      const jsm = await jetstreamManager(await connection());
      // The server finds the last message on a subject; the library's type names other ways to ask.
      const query = { last_by_subj: subject } as unknown as MsgRequest;
      const m = await jsm.streams.getMessage(stream, query).catch((err: unknown) => {
        if (err instanceof JetStreamApiError && err.code === JetStreamApiCodes.StreamNotFound)
          return null;
        throw err;
      });
      if (!m) return undefined;
      return {
        subject: m.subject,
        seq: m.seq,
        data: m.data,
        header: (k) => m.header?.get(k) || undefined,
      };
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
    async streams(names) {
      const jsm = await jetstreamManager(await connection());
      const out: StreamState[] = [];
      for (const name of names) {
        let info: Awaited<ReturnType<typeof jsm.streams.info>>;
        try {
          info = await jsm.streams.info(name);
        } catch (err) {
          if (err instanceof JetStreamApiError && err.code === JetStreamApiCodes.StreamNotFound)
            continue;
          throw err;
        }
        const st = info.state;
        const consumers: StreamState["consumers"] = [];
        let leftOut = 0;
        for await (const c of jsm.consumers.list(name)) {
          if (consumers.length >= BUS_STATE_CONSUMERS_MAX) {
            leftOut++;
            continue;
          }
          consumers.push({
            name: c.name,
            pending: c.num_pending,
            ack_pending: c.num_ack_pending,
            redelivered: c.num_redelivered,
          });
        }
        const at = (ts: string) => (st.messages && !ts.startsWith("0001") ? ts : null);
        out.push({
          name,
          messages: st.messages,
          bytes: st.bytes,
          subjects: st.num_subjects ?? 0,
          first_at: at(st.first_ts),
          last_at: at(st.last_ts),
          consumers,
          consumers_left_out: leftOut,
        });
      }
      return out;
    },
    connected: () => up,
    async close() {
      closed = true;
      for (const r of readings) r.stop();
      const nc = await conn?.catch(() => undefined);
      await nc?.close();
    },
  };
}

/**
 * Asks the server at `url` to read its configuration again, as control's system user (`seed`),
 * trusting it through `trust`: the users file and the certificate control wrote take effect without
 * a restart, and the connections of a user it no longer has are closed. Throws when the server
 * can't be reached, refuses the user, or says the reload failed.
 */
export async function reloadBus(url: string, seed: Uint8Array, trust?: BusTrust): Promise<void> {
  const nc = await connect({
    servers: url,
    name: "control (reloads)",
    timeout: BUS_CONNECT_TIMEOUT_MS,
    maxReconnectAttempts: 0,
    tls: tlsOf(trust, url),
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
