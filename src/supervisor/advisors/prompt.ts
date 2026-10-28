/**
 * An advisor's prompt: its brief or package as JSON, cut to `max` characters. The owner's
 * messages go first and are never cut, so a large diff cannot hide one the supervisor then
 * records as read. `fit`: the most characters that fit the advisor's window (packageFit, goal
 * 070); when it is the lower and the package is longer, the package is cut to it, and the prompt
 * says so in words: "cut to fit the window: N of M characters".
 */
export function advisorPrompt(
  head: string,
  data: unknown,
  max: number,
  fit?: number | undefined,
): string {
  const owner =
    data && typeof data === "object" && !Array.isArray(data) && "owner_messages" in data;
  let json: string;
  let keep = 0;
  if (owner) {
    const { owner_messages, ...rest } = data as Record<string, unknown>;
    json = JSON.stringify({ owner_messages, ...rest });
    keep = JSON.stringify({ owner_messages }).length + 1000;
  } else json = JSON.stringify(data) ?? "";
  const byWindow = fit !== undefined && fit < max;
  const limit = Math.max(byWindow ? fit : max, keep);
  if (json.length <= limit) return `${head}\n${json}`;
  // A cut is always said (goal 117): the end of a package lost without a word misled reviewers.
  return `${head}\n[Cut to fit ${byWindow ? "the window" : "the prompt's limit"}: ${limit.toLocaleString("en-US")} of ${json.length.toLocaleString("en-US")} characters.]\n${json.slice(0, limit)}`;
}

/**
 * A package's prompt with the keys it must answer first, never cut to a fixed size: it may take
 * what the advisor's window allows (200,000 characters at least). A cut is said, with `after`:
 * what comes first and how to read what was cut.
 */
export function orderedPrompt(
  label: string,
  pkg: unknown,
  fit: number | undefined,
  first: string[],
  after: string,
): string {
  const p = pkg as Record<string, unknown>;
  const ordered: Record<string, unknown> = {};
  for (const k of first) if (k in p) ordered[k] = p[k];
  for (const [k, v] of Object.entries(p)) if (!(k in ordered)) ordered[k] = v;
  const limit = Math.max(200_000, fit ?? 0);
  const prompt = advisorPrompt(label, ordered, limit);
  const whole = advisorPrompt(label, ordered, Number.POSITIVE_INFINITY).length;
  return prompt.length < whole
    ? prompt.replace(
        label,
        `${label}\n[Cut to fit: ${limit.toLocaleString("en-US")} of ${whole.toLocaleString("en-US")} characters. ${after}]`,
      )
    : prompt;
}
