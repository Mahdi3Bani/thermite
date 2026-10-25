import type { z } from "zod";

/**
 * A request that the harness API's schema refused, in words an agent can act on (goal 143): each
 * field and what is wrong with it, such as `quotes[0].quote has 9 characters; it needs at least
 * 20`. Before, every such request got only "invalid request", and agents guessed. `body` is the
 * request's JSON when the caller has it: with it, the words give the length or the value found.
 */

/** The most problems one answer names; the rest are counted. A client cuts what it shows. */
export const REFUSAL_PROBLEMS = 5;
/** The longest value an answer quotes, in characters. */
const VALUE_CHARS = 40;

export function refusalWords(err: z.ZodError, body?: unknown): string {
  const words = err.issues.slice(0, REFUSAL_PROBLEMS).map((issue) => problem(issue, body));
  const more = err.issues.length - words.length;
  return more > 0 ? `${words.join("; ")}; and ${more} more` : words.join("; ");
}

type Issue = z.core.$ZodIssue;
type Path = readonly PropertyKey[];

function problem(issue: Issue, body: unknown): string {
  const at = pathWords(issue.path);
  const value = valueAt(body, issue.path);
  switch (issue.code) {
    case "invalid_type": {
      const want = kindWords(issue.expected);
      return value === undefined
        ? `${at} is missing: it must be ${want}`
        : `${at} is ${valueKind(value)}; it must be ${want}`;
    }
    case "too_small":
      return sizeProblem(at, value, issue.origin, "small", Number(issue.minimum), issue.inclusive);
    case "too_big":
      return sizeProblem(at, value, issue.origin, "big", Number(issue.maximum), issue.inclusive);
    case "invalid_value":
      return `${at} is ${show(value)}; it must be ${either(issue.values.map((v) => show(v)))}`;
    case "unrecognized_keys":
      return `${at} has ${issue.keys.length === 1 ? "a field" : "fields"} it does not take: ${issue.keys.join(", ")}`;
    case "invalid_union": {
      const kinds = issue.errors.flatMap((branch) =>
        branch.flatMap((i) => (i.code === "invalid_type" && !i.path.length ? [i.expected] : [])),
      );
      if (!kinds.length) return `${at} matches none of the forms it can take`;
      return `${at} is ${valueKind(value)}; it must be ${either([...new Set(kinds)].map(kindWords))}`;
    }
    case "invalid_format":
      return `${at} is not a valid ${issue.format}`;
    default:
      return `${at}: ${issue.message}`;
  }
}

/** A field's path as the agent wrote it: `quotes[0].quote`; the whole body is "the request". */
export function pathWords(path: Path): string {
  if (!path.length) return "the request";
  return path
    .map((k, i) => (typeof k === "number" ? `[${k}]` : `${i ? "." : ""}${String(k)}`))
    .join("");
}

function valueAt(body: unknown, path: Path): unknown {
  let v = body;
  for (const k of path) {
    if (v === null || typeof v !== "object") return undefined;
    v = (v as Record<PropertyKey, unknown>)[k];
  }
  return v;
}

function sizeProblem(
  at: string,
  value: unknown,
  origin: string,
  side: "small" | "big",
  limit: number,
  inclusive: boolean | undefined,
): string {
  const n = count(limit);
  if (origin === "string" || origin === "array") {
    const unit = origin === "string" ? "characters" : "items";
    const want = side === "small" ? `needs at least ${n}` : `can have at most ${n}`;
    // With the body, the length found: "has 9 characters; it needs at least 20".
    return typeof value === "string" || Array.isArray(value)
      ? `${at} has ${count(value.length)} ${unit}; it ${want}`
      : `${at} ${want} ${unit}`;
  }
  const bound =
    side === "small"
      ? inclusive === false
        ? `more than ${n}`
        : `at least ${n}`
      : inclusive === false
        ? `less than ${n}`
        : `at most ${n}`;
  return typeof value === "number"
    ? `${at} is ${value}; it must be ${bound}`
    : `${at} must be ${bound}`;
}

/** What a JSON value is, in words: "a string", "a number", "null", "a list". */
function valueKind(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "a list";
  if (typeof v === "object") return "an object";
  return typeof v === "number" && !Number.isInteger(v)
    ? `the number ${v}`
    : `${article(typeof v)} ${typeof v}`;
}

/** What a schema expects, in words: "a whole number", "a list", "an object". */
function kindWords(expected: string): string {
  if (expected === "int") return "a whole number";
  if (expected === "array") return "a list";
  return `${article(expected)} ${expected}`;
}

const article = (word: string) => (/^[aeiou]/.test(word) ? "an" : "a");

function show(v: unknown): string {
  if (v === undefined) return "missing";
  const text = typeof v === "string" ? JSON.stringify(v) : String(JSON.stringify(v));
  return text.length > VALUE_CHARS ? `${text.slice(0, VALUE_CHARS)}…` : text;
}

const either = (words: string[]) =>
  words.length < 2 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} or ${words.at(-1)}`;

const count = (n: number) => n.toLocaleString("en-US");
