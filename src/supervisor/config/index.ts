/**
 * The rig's configuration from control (goal 168): the agents' model route, the advisors' routes
 * and the MCP servers with their sign-ins. With the message bus, the supervisor watches its rig's
 * keys in the config bucket and applies each change at once (bus.ts); without it, it polls control
 * for them. Either way, it keeps its harness and its advisors on what control gave (keep.ts).
 */

export { ConfigCounts, type ConfigWatch, followConfig, RigConfig, takeConfig } from "./bus.ts";
export { applyConfig, type KeepConfig, keepConfig } from "./keep.ts";
