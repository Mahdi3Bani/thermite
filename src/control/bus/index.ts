/**
 * The message bus as control keeps it: who may use it, each rig's key and control's own two, and
 * the users file control writes for the bus's server (users.ts); each rig's config in the config
 * bucket, sealed to the rig's seal key (config.ts); and its state, for whoever runs control
 * (state.ts).
 */

export {
  CONFIG_WRITE_MS,
  type ConfigBus,
  type ConfigParts,
  ConfigWriter,
  ConfigWritten,
  configState,
  type RigConfig,
  takeRigSealKey,
} from "./config.ts";

export {
  BUS_STATE_TIMEOUT_MS,
  BUS_STREAMS,
  type BusView,
  busState,
  liveState,
  type RigLive,
} from "./state.ts";
export { BUS_USERS_SYNC_MS, BusUsers, busRigs, busUsersFile, takeRigBusKey } from "./users.ts";
