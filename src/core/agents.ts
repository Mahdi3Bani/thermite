/**
 * The agents' words (goal 125, T1): where an agent runs, how hard its model thinks, and the kinds
 * of model provider, one list each for control, the harness and the supervisor.
 */

/**
 * Where a rig's agents run: Pi, OpenCode v2, Claude Code (the only one a Claude subscription
 * allows) or the Codex CLI (a ChatGPT sign-in or an OpenAI-compatible key: OpenAI's Responses API).
 */
export const HARNESSES = ["pi", "opencode", "claude-code", "codex"] as const;
export type Harness = (typeof HARNESSES)[number];

/** How hard an agent's model thinks: Claude Code's levels (other providers take up to high). */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

/**
 * A model provider's kind; "claude" is a Claude subscription (its token from `claude setup-token`),
 * "chatgpt" a ChatGPT subscription (its login from Sign in with ChatGPT, renewed by control).
 */
export const PROVIDER_TYPES = ["openai", "anthropic", "opencode", "claude", "chatgpt"] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

/** The kinds reached with an API key; the others are subscriptions, reached with a sign-in. */
export const KEY_PROVIDER_TYPES: readonly ProviderType[] = ["openai", "anthropic", "opencode"];
export const PLAN_PROVIDER_TYPES: readonly ProviderType[] = ["claude", "chatgpt"];

/** The advisors' roles, as messages, answers and field notes name them (goal 074's names). */
export const ADVISOR_ROLES = ["teachers", "auditor", "review_panel"] as const;
export type AdvisorRole = (typeof ADVISOR_ROLES)[number];
