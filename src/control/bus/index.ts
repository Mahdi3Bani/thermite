/**
 * The message bus as control keeps it: who may use it, each rig's key and control's own two, and
 * the users file control writes for the bus's server (users.ts); and its state, for whoever runs
 * control (state.ts).
 */

export {
  BUS_STATE_TIMEOUT_MS,
  BUS_STREAMS,
  type BusView,
  busState,
  liveState,
  type RigLive,
} from "./state.ts";
export { BUS_USERS_SYNC_MS, BusUsers, busUsersFile, takeRigBusKey } from "./users.ts";
