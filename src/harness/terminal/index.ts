/**
 * The terminal host (goal 169): an agent program's own terminal UI, held in a pseudo-terminal by a
 * small program of Thermite's that runs as the lane's user (main.ts, host.ts), with the screen
 * kept by a headless terminal emulator (screen.ts), the program's session log copied where the
 * harness may read it (mirror.ts), and a socket the harness asks it on (server.ts, protocol.ts).
 * The harness starts it and asks it through client.ts. This file is only the folder's interface.
 */

export {
  READY_MS,
  startTerminal,
  TERMINAL_HOST,
  Terminal,
  type TerminalEnded,
  type TerminalRun,
} from "./client.ts";
export {
  DEFAULT_COLS,
  DEFAULT_ROWS,
  DEFAULT_SCROLLBACK,
  type ProgramExit,
  type ScreenSnapshot,
  type ScreenText,
  TERMINAL_SOCKET,
  type TerminalStartInput,
  type TerminalStatus,
} from "./protocol.ts";
