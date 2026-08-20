/**
 * Binary UART0 production protocol for the Thymio3 robot ID stored in eFuse
 * BLK3. Constants are kept in sync with `prod_serial.h` on the firmware side.
 *
 * This module is pure: no DOM, no I/O, no state. Everything here can be unit
 * tested and reused from any front end.
 */

export const BAUD_RATE = 115200;

/** Boot-time handshake: "\xA5T3PROD\x5A". */
export const MAGIC: readonly number[] = [0xa5, 0x54, 0x33, 0x50, 0x52, 0x4f, 0x44, 0x5a];

/** Answer prefix: "\xA5T3RDY" followed by the protocol version and 0x5A. */
export const READY_PREFIX: readonly number[] = [0xa5, 0x54, 0x33, 0x52, 0x44, 0x59];
export const READY_LEN = 8;
export const READY_TERMINATOR = 0x5a;

export const CMD_GET_ID = 0x00;
export const CMD_SET_ID = 0x01;
export const CMD_KILL_ID = 0x02;
export const CMD_GET_ENTRIES = 0x03;
export const CMD_REBOOT = 0x7f;
export const RESP_UNKNOWN = 0xff;

/** Period at which the magic sequence is repeated during the boot window. */
export const MAGIC_BURST_MS = 100;
/** How long we keep streaming the magic after releasing the reset. */
export const MAGIC_WINDOW_MS = 4000;
/** Pause between two entry attempts. */
export const RETRY_PAUSE_MS = 500;
/** Must be longer than PROD_SETTLE_MS on the robot. */
export const SETTLE_MS = 350;
/** Grace period after open() before the first control transfer goes out. */
export const PORT_READY_MS = 20;
/** Gap between two steps of the reset sequence, so each edge is its own event. */
export const LINE_EDGE_MS = 100;
/** How long we wait for the USB device to come back after a reset. */
export const REOPEN_TIMEOUT_MS = 10000;
/** Polling period while waiting for the device. */
export const DEVICE_POLL_MS = 60;
/**
 * How long the port stays closed before being reopened. The close is what
 * resets the robot on Windows, and the reset needs room to happen.
 */
export const CLOSE_DWELL_MS = 300;
/** Cap on every close step: a lost device never answers. */
export const CLOSE_GUARD_MS = 1500;
/** Receive buffer cap while hunting for the READY frame. */
export const RX_MAX_BYTES = 32768;
/** A write that never resolves means UART0 is not being drained. */
export const WRITE_TIMEOUT_MS = 1500;
/** Default timeout for a command round trip. */
export const COMMAND_TIMEOUT_MS = 3000;
/** Timeout for the two commands that actually burn fuses. */
export const BURN_TIMEOUT_MS = 5000;

/** Status codes returned by CMD_SET_ID / CMD_KILL_ID (int8 on the wire). */
export const SET_ID_STATUS: Readonly<Record<string, string>> = {
  "0": "ID_OK · ID written",
  "-1": "BAD_ID · ID not allowed (0x00000000 or 0xFFFFFFFF)",
  "-2": "REFUSE_THIS_ID · current slot cannot hold this ID, a kill is needed",
  "-3": "NO_AVAILABLE_ID · no slot left",
  "-5": "FAILED_TO_PROGRAM_ID · read back differs from what was written",
  "-10": "ERROR_TO_PROGRAM_ID · unexpected error",
};

export const NO_ID = 0x00000000;
export const INVALID_ID = 0xffffffff;

export function describeSetIdStatus(status: number): string {
  return SET_ID_STATUS[String(status)] ?? `unknown status ${status}`;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

export function hex8(value: number): string {
  return value.toString(16).toUpperCase().padStart(2, "0");
}

export function hex32(value: number): string {
  return `0x${(value >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
}

export function dumpBytes(bytes: ArrayLike<number>): string {
  return Array.from(bytes, hex8).join(" ");
}

export function errMsg(err: unknown): string {
  if (err instanceof Error) {
    return err.name && err.name !== "Error" ? `${err.name}: ${err.message}` : err.message;
  }
  return String(err);
}

/**
 * Render a received chunk.
 *
 * The robot talks two languages on the same wire: ASCII boot logs and binary
 * protocol frames. Hex is unreadable for the former and text is unreadable for
 * the latter, so pick per chunk and strip the ANSI colour codes the IDF logger
 * wraps every line in.
 */
export function formatRx(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";

  let printable = 0;
  for (const b of bytes) {
    if ((b >= 0x20 && b < 0x7f) || b === 0x0a || b === 0x0d || b === 0x09 || b === 0x1b) {
      printable++;
    }
  }
  if (printable / bytes.length < 0.85) return dumpBytes(bytes);

  let text = "";
  for (const b of bytes) text += String.fromCharCode(b);
  return text
    .replace(/\x1B\[[0-9;]*m/g, "")
    .replace(/\r/g, "")
    .replace(/\n+$/, "")
    .replace(/\n/g, " | ");
}

// ---------------------------------------------------------------------------
// ID helpers — layout of the t3_id_t union on the little endian ESP32:
// byte0 = lot[0], byte1 = lot[1], bytes 2..3 = number
// ---------------------------------------------------------------------------

export interface IdParts {
  lot: string;
  num: number;
}

/** Parse the hex field, tolerating an optional 0x prefix. Null when invalid. */
export function parseIdHex(raw: string): number | null {
  const cleaned = raw.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{1,8}$/.test(cleaned)) return null;
  return parseInt(cleaned, 16) >>> 0;
}

export function idToParts(id: number): IdParts {
  const c0 = id & 0xff;
  const c1 = (id >>> 8) & 0xff;
  const printable = (c: number): string =>
    c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : "\u00b7";
  return { lot: printable(c0) + printable(c1), num: (id >>> 16) & 0xffff };
}

export function partsToId(lot: string, num: number): number {
  const c0 = lot.length > 0 ? lot.charCodeAt(0) & 0xff : 0;
  const c1 = lot.length > 1 ? lot.charCodeAt(1) & 0xff : 0;
  return (((num & 0xffff) << 16) | (c1 << 8) | c0) >>> 0;
}

export function describeId(id: number): string {
  if (id === NO_ID) return "  (NO_ID, virgin slot)";
  if (id === INVALID_ID) return "  (INVALID_ID, every slot burned)";
  const parts = idToParts(id);
  return `  lot ${parts.lot}, number ${parts.num}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
