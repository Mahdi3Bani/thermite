/**
 * The model check (goal 166): one short call that shows a rig's agents can reach their model and
 * call a tool, before the agents start and when their route changes. It runs in the harness, on
 * the workers' route and program, and asks for one word back.
 */

/** In Pi, the check calls the echo tool. */
export const MODEL_CHECK_PI_SYSTEM =
  "You are checking a tool-calling route. Answer only by calling the echo tool, once.";

/** What the check asks in Pi, with the word it must get back. */
export const modelCheckPiPrompt = (word: string) => `Call echo with the word ${word}.`;

/** What the check asks an agent program, which runs one command with its shell tool. */
export const modelCheckProgramPrompt = (word: string, shellTool = "shell tool") =>
  `Use your ${shellTool} to run exactly this command: echo ${word}\nThen reply with only the word it printed.`;
