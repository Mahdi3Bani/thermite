/**
 * Who may use the message bus: each rig's key and control's own two, and the users file control
 * writes for the bus's server (users.ts).
 */

export { BUS_USERS_SYNC_MS, BusUsers, busUsersFile, takeRigBusKey } from "./users.ts";
