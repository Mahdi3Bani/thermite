import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { compactionOf, KEPT_MAX } from "../compactions.ts";
import type { ApiContext } from "./context.ts";

/**
 * A running trial's own routes, each bound to the trial by its token: its session's lines for the
 * live log, the owner's messages waiting for it and its receipt for them, its ideas and field
 * notes, and the compactions of its conversation.
 */
export function trialRoutes(app: Hono, { service, trialOf }: ApiContext): void {
  // A worker's own lines for the live log: its trial decides the source, lane and run.
  app.post("/v1/trial/live", bodyLimit({ maxSize: 256 * 1024 }), async (c) => {
    const { trial } = trialOf(c.req.header("authorization"));
    const body = z
      .object({
        entries: z
          // What an agent's session produces; the owner's messages and their receipts are the
          // harness's own lines, never a worker's.
          .array(
            z.object({
              kind: z.enum(["text", "thinking", "tool", "result"]),
              text: z.string().max(8000),
            }),
          )
          .max(200),
        /** The session's counters so far (turns, tool calls, tokens). */
        progress: z
          .object({
            turns: z.number().int().min(0),
            tool_calls: z.number().int().min(0),
            tokens_in: z.number().int().min(0),
            tokens_out: z.number().int().min(0),
          })
          .optional(),
        /**
         * Its open model call, as a Pi worker reports it every 30 seconds: since when, and the
         * characters of text, thinking and tool-call arguments so far; null: it ended (goal 143).
         */
        reply: z
          .object({
            since: z.iso.datetime(),
            text: z.number().int().min(0),
            thinking: z.number().int().min(0),
            tool_args: z.number().int().min(0),
          })
          .nullable()
          .optional(),
        /** The trial waits for its provider, then goes on in the same conversation (goal 079). */
        wait: z
          .object({
            until: z.iso.datetime(),
            kind: z.enum(["rate_limit", "server", "model", "context", "credits", "auth", "route"]),
            words: z.string().max(2000),
          })
          .optional(),
      })
      .parse(await c.req.json());
    service.trialReport(trial, body);
    if (body.wait) service.trialWait(trial, body.wait);
    return c.json({ ok: true });
  });

  // The owner's messages waiting for this trial (to it, its lane or everyone working). Fetching
  // them gives nothing to the agent: the worker confirms each one once its agent has it.
  app.get("/v1/trial/messages", (c) => {
    const { trial } = trialOf(c.req.header("authorization"));
    return c.json({
      messages: service.trialInbox({ id: trial.id, run: trial.run, lane: trial.lane }).waiting(),
    });
  });

  // The worker's receipt: these messages reached its agent (only messages waiting for it count).
  app.post("/v1/trial/messages/read", bodyLimit({ maxSize: 16 * 1024 }), async (c) => {
    const { trial } = trialOf(c.req.header("authorization"));
    const body = z
      .object({ ids: z.array(z.number().int().positive()).min(1).max(100) })
      .parse(await c.req.json());
    service.trialInbox({ id: trial.id, run: trial.run, lane: trial.lane }).given(body.ids);
    return c.json({ ok: true });
  });

  // A worker's idea for its run's queue: proposed by its lane (its trial decides run and lane).
  app.post("/v1/trial/idea", bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
    const { token } = trialOf(c.req.header("authorization"));
    return c.json(service.proposeIdea(token, await c.req.json()), 201);
  });

  // A worker's field note: its trial decides the run, the lane and who wrote it.
  app.post("/v1/trial/note", bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
    const { token } = trialOf(c.req.header("authorization"));
    return c.json(service.writeTrialNote(token, await c.req.json()), 201);
  });

  // A Pi worker compacts its conversation (goal 070): first the whole conversation, kept in the
  // run's research folder (the trial decides the run, the lane and the file's name), then the
  // record of the compaction. Both come from the worker's own code, never from its agent.
  app.post("/v1/trial/snapshot", bodyLimit({ maxSize: 2 * KEPT_MAX + 64 * 1024 }), async (c) => {
    const { trial } = trialOf(c.req.header("authorization"));
    if (!service.compactions) return c.json({ error: "this harness keeps no compactions" }, 404);
    const body = z
      .strictObject({
        number: z.number().int().min(1).max(10_000),
        markdown: z.string().min(1).max(KEPT_MAX),
      })
      .parse(await c.req.json());
    return c.json(service.compactions.keep(compactionOf(trial), body.number, body.markdown), 201);
  });
  app.post("/v1/trial/compacted", bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
    const { trial } = trialOf(c.req.header("authorization"));
    if (!service.compactions) return c.json({ error: "this harness keeps no compactions" }, 404);
    const b = z
      .strictObject({
        number: z.number().int().min(1).max(10_000),
        tokens_before: z.number().int().min(0),
        tokens_after: z.number().int().min(0),
        how: z.enum(["summary", "trimmed"]),
        kept: z.boolean(),
        summary: z.string().max(32_000).optional(),
        error: z.string().max(2000).optional(),
      })
      .parse(await c.req.json());
    service.compactions.record(compactionOf(trial), {
      number: b.number,
      tokensBefore: b.tokens_before,
      tokensAfter: b.tokens_after,
      how: b.how,
      harness: "pi",
      summary: b.summary,
      error: b.error,
      kept: b.kept,
    });
    return c.json({ ok: true }, 201);
  });
}
