import type { KbKind } from "../core/kb.ts";
import {
  indexEvent,
  KB_EVENT_KINDS,
  type KbIndexTarget,
  type KbStored,
  mergeItem,
  metaOf,
  sameItem,
} from "../core/kb-index.ts";
import { eventKinds } from "../core/names.ts";
import type { Ledger } from "./ledger.ts";

/**
 * A rig's runs' part of their campaigns' folders (goal 065), for an export: the items this
 * ledger's events make, read the same way control reads them (core/kb-index.ts), so an export
 * holds what its runs put in Thermite's knowledge base. Each item keeps its origin: campaign,
 * rig, run, who wrote it and when.
 */

/** One item of the part, as an export's knowledge.jsonl holds it. */
export interface KbPartItem {
  campaign: string;
  rig: string;
  run: string;
  kind: KbKind;
  ref: string;
  title: string;
  body: string;
  by: string;
  url: string | null;
  sub: string | null;
  at: string;
  updated_at: string;
}

interface Held {
  run: string;
  kind: KbKind;
  ref: string;
  stored: KbStored;
  at: string;
  updated_at: string;
  /** The event that last changed it. */
  changed: number;
}

/** Events read per query while reading the ledger. */
const PAGE = 5000;

/**
 * The items that events after `since`, up to `through`, added or changed, each as it stands
 * after `through`, in the order they first appeared. The whole ledger is read (an item changed
 * now may have started long before), but only those items are returned.
 */
export function knowledgePart(
  ledger: Ledger,
  rig: string,
  since: number,
  through: number,
): KbPartItem[] {
  const items = new Map<string, Held>();
  const attempts = new Map<string, string>();
  const campaigns = new Map<string, string>();
  const key = (run: string, kind: string, ref: string) => JSON.stringify([run, kind, ref]);
  let current = 0;
  const target: KbIndexTarget = {
    // The run's campaign as its own ledger records it (the contract it was assigned).
    runCreated: (run, named) => {
      const campaign = ledger.getRun(run)?.campaign || named;
      if (campaign) campaigns.set(run, campaign);
    },
    item: (run, kind, ref) => {
      const s = items.get(key(run, kind, ref))?.stored;
      return s && { body: s.body, meta: metaOf(s.meta) };
    },
    attempt: (ref) => {
      const run = attempts.get(ref);
      const s = run ? items.get(key(run, "attempt", ref))?.stored : undefined;
      return run && s ? { run, body: s.body, meta: metaOf(s.meta) } : undefined;
    },
    put: (run, kind, ref, f, at) => {
      if (!campaigns.has(run) || !ref) return;
      const k = key(run, kind, ref);
      const old = items.get(k);
      const next = mergeItem(ref, old?.stored, f);
      if (old && sameItem(old.stored, next)) return;
      items.set(k, {
        run,
        kind,
        ref,
        stored: next,
        at: old?.at ?? at,
        updated_at: at,
        changed: current,
      });
      if (kind === "attempt") attempts.set(ref, run);
    },
  };
  const kinds = KB_EVENT_KINDS.flatMap((k) => eventKinds(k));
  const query = ledger.db.prepare(
    `select id, at, actor, kind, subject, body from event
     where id > ? and id <= ? and kind in (${kinds.map(() => "?").join(", ")})
     order by id limit ?`,
  );
  for (let after = 0; ; ) {
    const rows = query.all(after, through, ...kinds, PAGE) as Record<string, unknown>[];
    for (const r of rows) {
      current = Number(r.id);
      let body: unknown;
      try {
        body = JSON.parse(String(r.body));
      } catch {
        // the ledger writes every body as JSON; anything else adds no item
        continue;
      }
      if (!body || typeof body !== "object") continue;
      indexEvent(target, {
        at: String(r.at),
        actor: String(r.actor),
        kind: String(r.kind),
        subject: r.subject === null ? "" : String(r.subject),
        body: body as Record<string, unknown>,
      });
    }
    if (rows.length < PAGE) break;
    after = current;
  }
  return [...items.values()]
    .filter((x) => x.changed > since)
    .map((x) => ({
      campaign: campaigns.get(x.run) as string,
      rig,
      run: x.run,
      kind: x.kind,
      ref: x.ref,
      title: x.stored.title,
      body: x.stored.body,
      by: x.stored.by,
      url: x.stored.url,
      sub: x.stored.sub,
      at: x.at,
      updated_at: x.updated_at,
    }));
}
