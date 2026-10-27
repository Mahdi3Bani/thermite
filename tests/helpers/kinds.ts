import type { EventKind } from "../../src/core/events/kinds.ts";

/** A kind outside Thermite's list, which a test records on purpose: an older or newer rig's. */
export const otherKind = (kind: string): EventKind => kind as EventKind;
