import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CHATGPT_LIMIT_CODE } from "./model.ts";
import {
  afterProgramFailure,
  classifyProviderError,
  durationMs,
  nextStep,
  retryAtFrom,
  statusIn,
  stopsAgents,
} from "./provider-errors.ts";

const NOW = Date.parse("2026-10-22T03:00:00.000Z");
const kind = (text: string, answer?: Parameters<typeof classifyProviderError>[1]) =>
  classifyProviderError(text, answer, NOW).kind;

describe("provider errors by kind (goal 079)", () => {
  test("no credits, a refused key and an unserved model stop the agents", () => {
    // The case the audit found: a 404 that says no credits.
    assert.equal(kind("404 insufficient_credits_for_paid_model"), "credits");
    // OpenAI says no quota with a 429: credits, not a rate limit.
    assert.equal(
      kind("429 You exceeded your current quota, please check your plan and billing details."),
      "credits",
    );
    assert.equal(kind("Your credit balance is too low to access the Anthropic API."), "credits");
    assert.equal(kind("payment needed", { status: 402 }), "credits");
    assert.equal(kind("401 Incorrect API key provided: sk-…"), "auth");
    assert.equal(kind("forbidden", { status: 403 }), "auth");
    assert.equal(
      kind("404 The model `gpt-9` does not exist or you do not have access to it."),
      "route",
    );
    assert.equal(kind("model_not_found"), "route");
    for (const k of ["credits", "auth", "route"] as const) assert.ok(stopsAgents(k));
    for (const k of ["rate_limit", "server", "model", "context"] as const)
      assert.ok(!stopsAgents(k));
  });

  test("rate limits, passing faults, a full context and the model's own errors", () => {
    assert.equal(kind("429 Rate limit reached for requests"), "rate_limit");
    assert.equal(kind("Too Many Requests"), "rate_limit");
    assert.equal(kind("RESOURCE_EXHAUSTED: quota per minute"), "rate_limit");
    assert.equal(kind(`{"error":{"code":"${CHATGPT_LIMIT_CODE}"}}`), "rate_limit");
    assert.equal(kind("503 Service Unavailable"), "server");
    assert.equal(kind("529 overloaded_error"), "server");
    assert.equal(kind("read ECONNRESET"), "server");
    assert.equal(kind("fetch failed"), "server");
    assert.equal(kind("context deadline exceeded"), "server");
    assert.equal(kind("400 This model's maximum context length is 32768 tokens"), "context");
    assert.equal(kind("prompt is too long: 210000 tokens > 200000 maximum"), "context");
    assert.equal(kind("400 Invalid tool call arguments"), "model");
    assert.equal(kind(""), "model");
  });

  test("the status comes from the answer, or from the error's words", () => {
    assert.equal(statusIn("429 Too Many Requests"), 429);
    assert.equal(statusIn("Error: 503 upstream"), 503);
    assert.equal(statusIn("request failed with status code 502"), 502);
    assert.equal(statusIn("HTTP 401"), 401);
    assert.equal(statusIn("in 2026 the model"), undefined);
    assert.equal(classifyProviderError("x", { status: 429 }, NOW).status, 429);
  });

  test("a rate limit's time: Retry-After, the reset headers, or the provider's words", () => {
    const at = (iso: string | undefined) => (iso ? Date.parse(iso) - NOW : undefined);
    assert.equal(at(retryAtFrom("", { "retry-after": "20" }, NOW)), 20_000);
    assert.equal(
      at(retryAtFrom("", { "retry-after": "Thu, 22 Oct 2026 03:01:00 GMT" }, NOW)),
      60_000,
    );
    assert.equal(at(retryAtFrom("", { "retry-after-ms": "1500" }, NOW)), 1500);
    // OpenAI's resets: the later of the two, as the limit that was hit is not said.
    assert.equal(
      at(
        retryAtFrom(
          "",
          { "x-ratelimit-reset-requests": "1s", "x-ratelimit-reset-tokens": "6m0s" },
          NOW,
        ),
      ),
      360_000,
    );
    assert.equal(
      at(retryAtFrom("", { "anthropic-ratelimit-tokens-reset": "2026-10-22T03:00:30Z" }, NOW)),
      30_000,
    );
    assert.equal(at(retryAtFrom("Please try again in 1m30s.", undefined, NOW)), 90_000);
    assert.equal(at(retryAtFrom("retry after 45 seconds", undefined, NOW)), 45_000);
    assert.equal(
      at(retryAtFrom("limit resets at 2026-10-22T04:00:00Z", undefined, NOW)),
      3_600_000,
    );
    assert.equal(retryAtFrom("429 Too Many Requests", undefined, NOW), undefined);
    // A full ChatGPT plan names no time: a fixed wait.
    assert.equal(at(retryAtFrom(CHATGPT_LIMIT_CODE, undefined, NOW)), 15 * 60_000);
    assert.equal(durationMs("250ms"), 250);
    assert.equal(durationMs("1h2m3s"), 3_723_000);
    assert.equal(durationMs("soon"), undefined);
  });

  test("the next step: stop kinds end the trial; others wait and go on, with no limit unless set", () => {
    const count = { failures: 0, rateWaits: 0 };
    const credits = classifyProviderError("402 out of credits", undefined, NOW);
    assert.deepEqual(nextStep(credits, count, undefined, NOW), {
      end: true,
      error: "402 out of credits",
    });
    const server = classifyProviderError("503 down", undefined, NOW);
    const pauses = Array.from({ length: 8 }, () => {
      const s = nextStep(server, count, undefined, NOW);
      assert.equal(s.end, false);
      return s.end ? 0 : s.waitMs;
    });
    assert.deepEqual(pauses, [5000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000, 60_000]);
    // A rate limit never counts as a failure.
    const rate = classifyProviderError("429 slow down", { headers: { "retry-after": "3" } }, NOW);
    const r = nextStep(rate, count, 2, NOW);
    assert.ok(!r.end && r.waitMs === 3000 && r.kind === "rate_limit");
    assert.equal(count.failures, 8);
    // The campaign's limit: the next failure in a row is the last.
    const c2 = { failures: 0, rateWaits: 0 };
    assert.equal(nextStep(server, c2, 2, NOW).end, false);
    const last = nextStep(server, c2, 2, NOW);
    assert.ok(last.end && /failed 2 times in a row/.test(last.error));
    // A rate limit that names no time: 30 s, doubling to 10 minutes.
    const vague = classifyProviderError("429", undefined, NOW);
    const c3 = { failures: 0, rateWaits: 0 };
    const waits = [1, 2, 3, 4, 5, 6].map(() => {
      const s = nextStep(vague, c3, undefined, NOW);
      return s.end ? 0 : s.waitMs;
    });
    assert.deepEqual(waits, [30_000, 60_000, 120_000, 240_000, 480_000, 600_000]);
  });

  test("a program's failed run: the proxy's answer gives the kind; the trial goes on, ends, or stops at its own end", async () => {
    const count = { failures: 0, rateWaits: 0 };
    const told: string[] = [];
    // The program only said "Bad Request"; the proxy saw the provider's 402 and its words.
    const end = await afterProgramFailure({
      error: "Bad Request",
      answer: { status: 402, body: '{"error":"insufficient credits"}' },
      count,
      deadline: Number.POSITIVE_INFINITY,
      waiting: (w) => void told.push(w.kind),
    });
    assert.deepEqual(end, {
      end: { error: 'Bad Request ({"error":"insufficient credits"})', kind: "credits" },
    });
    assert.equal(told.length, 0);
    // A rate limit of one second: it waits, says so, and goes on.
    const started = Date.now();
    const on = await afterProgramFailure({
      error: "rate limited",
      answer: { status: 429, headers: { "retry-after": "1" } },
      count,
      deadline: Number.POSITIVE_INFINITY,
      waiting: (w) => void told.push(w.kind),
    });
    assert.ok("goOn" in on && /Continue where you left off/.test(on.goOn));
    assert.ok(Date.now() - started >= 900);
    assert.deepEqual(told, ["rate_limit"]);
    // A wait past the trial's own end stops at its end.
    const wall = await afterProgramFailure({
      error: "503",
      count,
      deadline: Date.now() + 50,
    });
    assert.deepEqual(wall, { wall: true });
    // A stop meanwhile: interrupted.
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 50);
    const stopped = await afterProgramFailure({
      error: "503",
      count,
      deadline: Number.POSITIVE_INFINITY,
      signal: ctrl.signal,
    });
    assert.deepEqual(stopped, { interrupted: true });
  });
});
