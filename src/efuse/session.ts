import type { LogFn } from "../flash/stm32";
import { findAuthorizedThymio3Ports } from "../usb/esp32Detect";
import {
  BAUD_RATE,
  BURN_TIMEOUT_MS,
  CLOSE_DWELL_MS,
  CLOSE_GUARD_MS,
  CMD_GET_ENTRIES,
  CMD_GET_ID,
  CMD_KILL_ID,
  CMD_REBOOT,
  CMD_SET_ID,
  COMMAND_TIMEOUT_MS,
  DEVICE_POLL_MS,
  MAGIC,
  MAGIC_BURST_MS,
  MAGIC_WINDOW_MS,
  READY_LEN,
  READY_PREFIX,
  READY_TERMINATOR,
  REOPEN_TIMEOUT_MS,
  LINE_EDGE_MS,
  PORT_READY_MS,
  RESP_UNKNOWN,
  RETRY_PAUSE_MS,
  RX_MAX_BYTES,
  SETTLE_MS,
  WRITE_TIMEOUT_MS,
  dumpBytes,
  errMsg,
  formatRx,
  hex8,
  sleep,
} from "./protocol";

export type EfuseSessionState = "closed" | "connecting" | "production";

/**
 * Reset sequence for the Thymio3 USB-CDC bridge, captured from a working manual
 * run. Both lines move in the same control transfer, which is what makes this
 * form shorter than driving them one at a time.
 *
 * The third step repeats the second verbatim. It is kept: what the bridge acts
 * on is the control transfer, not the resulting level, so it must not be
 * optimised away as a no-op.
 */
const RESET_SEQUENCE: ReadonlyArray<{ dataTerminalReady: boolean; requestToSend: boolean }> = [
  { dataTerminalReady: true, requestToSend: true },
  { dataTerminalReady: false, requestToSend: false },
  { dataTerminalReady: false, requestToSend: false },
];

export interface EfuseSessionCallbacks {
  /** Human readable trace, routed to the panel log. */
  log: LogFn;
  /** Session state plus a short label for the status line. */
  onState: (state: EfuseSessionState, text: string) => void;
}

/**
 * One production-mode session over the Thymio3 USB-CDC bridge.
 *
 * The session owns the serial port for its whole lifetime: it opens it, resets
 * the ESP32 over the modem control lines, streams the magic sequence, and keeps
 * the port open for as long as production mode lasts. Nothing else in the app may
 * touch that port meanwhile, which is why the app locks the other tabs while a
 * session is not closed.
 */
export class EfuseSession {
  private readonly callbacks: EfuseSessionCallbacks;

  private port: SerialPort | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private readLoopDone: Promise<void> | null = null;
  /** In flight reset pulse, awaited before tearing the port down. */
  private resetPulse: Promise<void> | null = null;

  private readLoopStop = false;
  /** The USB bridge went away, typically on reset. */
  private deviceLost = false;
  /** The user asked for a connection and did not close it. */
  private sessionActive = false;
  private abortEntry = false;
  private entryRunning = false;
  private inProduction = false;
  private verbose = false;

  /** Bytes received and not yet consumed. */
  private rx: number[] = [];

  constructor(callbacks: EfuseSessionCallbacks) {
    this.callbacks = callbacks;
  }

  get isInProduction(): boolean {
    return this.inProduction;
  }

  /** Mirror every TX/RX chunk into the log. Off by default: boot logs are loud. */
  setVerbose(verbose: boolean): void {
    this.verbose = verbose;
  }

  /**
   * Take ownership of the port and keep resetting the robot until it answers
   * from production mode. Resolves when production mode is reached, or when the
   * session is stopped.
   */
  async start(initialPort: SerialPort): Promise<void> {
    if (this.sessionActive) return;
    this.sessionActive = true;
    this.abortEntry = false;
    this.port = initialPort;
    navigator.serial.addEventListener("disconnect", this.onSerialDisconnect);
    await this.enterProductionLoop();
  }

  /** Release the port. Never blocks, even on a device that is already gone. */
  async stop(): Promise<void> {
    this.abortEntry = true;
    this.sessionActive = false;
    navigator.serial.removeEventListener("disconnect", this.onSerialDisconnect);
    await this.closePort();
    this.port = null;
    this.setState("closed", "port closed");
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  async readId(): Promise<number> {
    const payload = await this.command([CMD_GET_ID], 5);
    return (
      (((payload[0] ?? 0) << 24) |
        ((payload[1] ?? 0) << 16) |
        ((payload[2] ?? 0) << 8) |
        (payload[3] ?? 0)) >>>
      0
    );
  }

  /** @returns the int8 status, 0 on success. */
  async writeId(id: number): Promise<number> {
    const payload = await this.command(
      [CMD_SET_ID, (id >>> 24) & 0xff, (id >>> 16) & 0xff, (id >>> 8) & 0xff, id & 0xff],
      2,
      BURN_TIMEOUT_MS,
    );
    return ((payload[0] ?? 0) << 24) >> 24;
  }

  /** Burn the current slot to 0xFFFFFFFF. @returns the int8 status, 0 on success. */
  async killSlot(): Promise<number> {
    const payload = await this.command([CMD_KILL_ID], 2, BURN_TIMEOUT_MS);
    return ((payload[0] ?? 0) << 24) >> 24;
  }

  async readEntriesLeft(): Promise<number> {
    const payload = await this.command([CMD_GET_ENTRIES], 2);
    return payload[0] ?? 0;
  }

  /** Reboot the robot: production mode is left behind, the session goes idle. */
  async reboot(): Promise<void> {
    await this.command([CMD_REBOOT], 2);
    this.inProduction = false;
    this.setState("connecting", "robot rebooting");
  }

  // -------------------------------------------------------------------------
  // Production mode
  // -------------------------------------------------------------------------

  /** Keep resetting the robot until it answers from production mode. */
  private async enterProductionLoop(): Promise<void> {
    if (this.entryRunning) return;
    this.entryRunning = true;
    this.abortEntry = false;

    let attempt = 0;
    try {
      while (this.sessionActive && !this.abortEntry && !this.inProduction) {
        attempt++;
        this.setState("connecting", `waiting for robot \u00b7 try ${attempt}`);
        this.log(
          `Attempt ${attempt}: closing the port to reset, then streaming ${dumpBytes(MAGIC)}`,
        );

        let frame: number[] | null = null;
        try {
          frame = await this.tryEnterProduction();
        } catch (err) {
          this.log(`Attempt failed: ${errMsg(err)}`);
        }

        if (!frame) {
          if (this.abortEntry || !this.sessionActive) break;
          this.log("No answer, retrying.");
          await sleep(RETRY_PAUSE_MS);
          continue;
        }

        this.log(`READY, protocol v${frame[6] ?? 0}`);
        // Let the robot flush the magic bytes still in flight.
        await sleep(SETTLE_MS);
        this.rx = [];
        this.inProduction = true;
        this.setState("production", "production mode");
      }
    } finally {
      this.entryRunning = false;
      if (!this.inProduction && this.sessionActive) {
        this.setState("connecting", "idle, not in production");
      }
    }
  }

  /**
   * Close the port the way the Close button does, and let the reset land.
   *
   * On Windows the robot reboots when the port is closed, not when it is
   * opened: the CDC stack drops the control lines on close. The loop was not
   * getting that reset for two reasons. On the first attempt nothing had been
   * opened yet, so `close()` threw InvalidStateError straight into `guard()`
   * and the robot never moved. On later attempts the port was reopened within
   * a few tens of milliseconds, too fast for the reset to play out.
   *
   * So: make sure there is really something open to close, close it through the
   * exact same path the button uses, and then stay closed for a while. The
   * button leaves the port closed for as long as the operator takes, which is
   * why its reset is always visible.
   */
  private async closeLikeButton(): Promise<void> {
    if (this.port && !this.writer) {
      // Nothing open yet: open so the close below is a real close.
      try {
        await this.openPort();
      } catch (err) {
        this.log(`Pre-close open failed: ${errMsg(err)}`);
      }
    }

    await this.closePort();
    this.port = null;
    await sleep(CLOSE_DWELL_MS);
  }

  /**
   * One reset plus one magic streaming window.
   *
   * The reset is the open() itself: Chrome asserts DTR and RTS as part of
   * open() with no way to suppress it, and on this board RTS drives EN. So
   * every attempt closes the port, waits for the device, reopens it (chip goes
   * into reset), then releases the lines (chip boots) with the reader already
   * running. One reset per attempt, not two.
   *
   * @returns the READY frame, or null on timeout.
   */
  private async tryEnterProduction(): Promise<number[] | null> {
    await this.closeLikeButton();

    const found = await this.waitForDevice(REOPEN_TIMEOUT_MS);
    if (!found) {
      this.log(`Device did not show up within ${REOPEN_TIMEOUT_MS} ms.`);
      return null;
    }
    this.port = found;

    try {
      await this.openPort();
    } catch (err) {
      this.log(`Open failed: ${errMsg(err)}`);
      this.port = null;
      return null;
    }
    this.log("Chip released from reset, streaming the magic sequence.");

    const started = performance.now();
    while (performance.now() - started < MAGIC_WINDOW_MS) {
      if (this.abortEntry || !this.sessionActive || !this.port) {
        this.log("Entry aborted.");
        return null;
      }
      if (this.deviceLost || !this.port.readable) {
        this.log(
          `Bridge dropped during the boot burst after ${Math.round(performance.now() - started)} ms.`,
        );
        return null;
      }
      try {
        await this.write(MAGIC);
      } catch (err) {
        this.log(errMsg(err));
        return null;
      }
      await sleep(MAGIC_BURST_MS);
      const frame = this.takeReadyFrame();
      if (frame) return frame;
    }
    return null;
  }

  /**
   * Wait for the bridge to be present on the bus and hand back its port.
   *
   * Two sources, whichever fires first: the connect event and a poll of
   * getPorts(), which covers the case where the device never left. The bridge
   * reports ffff:ffff with no serial number, so only one robot at a time can be
   * on the bench.
   */
  private waitForDevice(timeoutMs: number): Promise<SerialPort | null> {
    return new Promise<SerialPort | null>((resolve) => {
      let settled = false;

      const finish = (result: SerialPort | null): void => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        window.clearInterval(poll);
        navigator.serial.removeEventListener("connect", onConnect);
        resolve(result);
      };

      const check = async (): Promise<void> => {
        if (!this.sessionActive || this.abortEntry) {
          finish(null);
          return;
        }
        const ports = await findAuthorizedThymio3Ports();
        const match = ports[0] ?? null;
        if (match) finish(match);
      };

      const onConnect = (): void => {
        void check();
      };

      const timer = window.setTimeout(() => finish(null), timeoutMs);
      const poll = window.setInterval(() => {
        void check();
      }, DEVICE_POLL_MS);
      navigator.serial.addEventListener("connect", onConnect);
      void check();
    });
  }

  // -------------------------------------------------------------------------
  // Serial plumbing
  // -------------------------------------------------------------------------

  /**
   * Drive both modem control lines in a single control transfer.
   *
   * Failures are logged instead of swallowed: a setSignals() the bridge ignores
   * is the difference between a robot that reboots and one that never enters
   * production mode.
   */
  private async setLines(signals: SerialOutputSignals, label: string): Promise<void> {
    const port = this.port;
    if (!port) throw new Error("No serial port for signal control.");
    try {
      await port.setSignals(signals);
      if (this.verbose) this.log(`${label}: ${JSON.stringify(signals)}`);
    } catch (err) {
      this.log(`${label}: setSignals failed (${errMsg(err)})`);
      throw err;
    }
  }

  /**
   * Walk the reset sequence, one control transfer per step.
   *
   * The order is the one verified on the bench against a real robot and is
   * reproduced verbatim, repeated steps included.
   *
   * The timings in the captured log were a second apart because the lines were
   * driven by hand; only the order carries meaning, so the steps are spaced by
   * LINE_EDGE_MS.
   */
  private async pulseReset(): Promise<void> {
    try {
      for (const step of RESET_SEQUENCE) {
        await this.setLines(step, "Reset");
        await sleep(LINE_EDGE_MS);
      }
    } catch {
      // Already logged by setLines. The magic stream keeps running: closing and
      // reopening the port resets the robot on its own on Windows.
    }
  }

  /**
   * Open the port and kick off the reset, without waiting for it.
   *
   * The magic sequence must start flowing immediately. Two things can reset the
   * robot here and we do not control which one fires: the RTS pulse below, and
   * the close/reopen of the port that precedes every attempt, which is itself a
   * reset on Windows because the CDC stack drops the lines on close. Blocking
   * the first magic burst behind the pulse meant that when the close had already
   * rebooted the robot, its boot window was over before we said a word.
   *
   * Streaming magic into a chip that is still held in reset costs nothing: the
   * burst repeats every MAGIC_BURST_MS for the whole window.
   */
  private async openPort(): Promise<void> {
    const port = this.port;
    if (!port) throw new Error("No serial port to open.");

    await port.open({
      baudRate: BAUD_RATE,
      dataBits: 8,
      stopBits: 1,
      parity: "none",
      flowControl: "none",
      bufferSize: 4096,
    });

    const writable = port.writable;
    if (!writable) throw new Error("Port opened without a writable stream.");
    this.writer = writable.getWriter();
    this.rx = [];
    this.deviceLost = false;
    this.startReadLoop();

    // Let the freshly opened endpoint settle: Windows can lose a control
    // transfer issued in the same breath as the open.
    await sleep(PORT_READY_MS);
    this.resetPulse = this.pulseReset();
  }

  /**
   * Read forever, dropping and re-taking the reader across recoverable errors.
   *
   * A null readable is the only reliable proof that the port object is
   * finished. The exception name is not: Chrome reports a lost device, a driver
   * level failure and a plain framing error (the ROM banner at 115200 baud is a
   * reliable source of those) all as NetworkError, and only some of them are
   * survivable. So the loop reacts to port.readable, never to err.name.
   */
  private startReadLoop(): void {
    this.readLoopStop = false;
    this.readLoopDone = (async () => {
      while (!this.readLoopStop && this.port) {
        const port = this.port;
        if (!port.readable) {
          this.deviceLost = true;
          this.log("Readable stream is gone, the port has to be reopened.");
          break;
        }

        let localReader: ReadableStreamDefaultReader<Uint8Array>;
        try {
          localReader = port.readable.getReader();
        } catch (err) {
          this.deviceLost = true;
          this.log(`Cannot take a reader: ${errMsg(err)}`);
          break;
        }
        this.reader = localReader;

        try {
          for (;;) {
            const { value, done } = await localReader.read();
            if (done) break;
            if (value && value.length > 0) this.pushRx(value);
          }
        } catch (err) {
          if (!this.readLoopStop) this.log(`Stream error: ${errMsg(err)}`);
        } finally {
          try {
            localReader.releaseLock();
          } catch {
            // already released
          }
          this.reader = null;
        }

        if (this.readLoopStop) break;
        // Next turn decides: a fresh readable, or give up.
        await sleep(5);
      }
    })();
  }

  private pushRx(chunk: Uint8Array): void {
    for (const b of chunk) this.rx.push(b);
    // Boot noise can pour in for a while: keep only a tail long enough to still
    // hold a READY frame split across two reads.
    if (this.rx.length > RX_MAX_BYTES) this.rx.splice(0, this.rx.length - RX_MAX_BYTES);
    if (this.verbose) this.log(`RX  ${formatRx(chunk)}`);
  }

  /** Tear the port down without ever blocking, even on a device that is gone. */
  private async closePort(): Promise<void> {
    if (this.resetPulse) {
      await guard(this.resetPulse);
      this.resetPulse = null;
    }
    this.readLoopStop = true;
    if (this.reader) await guard(this.reader.cancel());
    if (this.readLoopDone) {
      await guard(this.readLoopDone);
      this.readLoopDone = null;
    }
    this.reader = null;

    if (this.writer) {
      await guard(this.writer.abort());
      try {
        this.writer.releaseLock();
      } catch {
        // already released
      }
      this.writer = null;
    }

    if (this.port) await guard(this.port.close());
    this.inProduction = false;
  }

  private async write(bytes: readonly number[]): Promise<void> {
    const writer = this.writer;
    if (!writer) throw new Error("Port not open.");
    const data = new Uint8Array(bytes);
    if (this.verbose) this.log(`TX  ${dumpBytes(data)}`);

    // Without this the whole loop can wedge: if nothing on the robot drains
    // UART0 the bridge stops accepting data and the write never settles.
    let timer: number | undefined;
    const expiry = new Promise<never>((_, reject) => {
      timer = window.setTimeout(
        () => reject(new Error("Write timeout, UART0 is not being drained.")),
        WRITE_TIMEOUT_MS,
      );
    });
    try {
      await Promise.race([writer.write(data), expiry]);
    } finally {
      if (timer !== undefined) window.clearTimeout(timer);
    }
  }

  private readExact(count: number, timeoutMs: number): Promise<number[]> {
    return new Promise<number[]>((resolve, reject) => {
      const started = performance.now();
      const poll = (): void => {
        if (this.rx.length >= count) {
          resolve(this.rx.splice(0, count));
          return;
        }
        if (performance.now() - started > timeoutMs) {
          reject(new Error(`Timeout: expected ${count} bytes, got ${this.rx.length}.`));
          return;
        }
        window.setTimeout(poll, 4);
      };
      poll();
    });
  }

  /** Look for the READY frame in the stream and drop everything up to it. */
  private takeReadyFrame(): number[] | null {
    for (let i = 0; i + READY_LEN <= this.rx.length; i++) {
      let match = true;
      for (let k = 0; k < READY_PREFIX.length; k++) {
        if (this.rx[i + k] !== READY_PREFIX[k]) {
          match = false;
          break;
        }
      }
      if (match && this.rx[i + 7] === READY_TERMINATOR) {
        const frame = this.rx.slice(i, i + READY_LEN);
        this.rx.splice(0, i + READY_LEN);
        return frame;
      }
    }
    return null;
  }

  /**
   * Send one command and collect its answer.
   * @returns the response payload, without the leading echoed command byte.
   */
  private async command(tx: number[], respLen: number, timeoutMs?: number): Promise<number[]> {
    if (!this.inProduction) throw new Error("Robot is not in production mode.");
    const timeout = timeoutMs ?? COMMAND_TIMEOUT_MS;

    this.rx = [];
    await this.write(tx);

    const head = await this.readExact(1, timeout);
    if (head[0] === RESP_UNKNOWN) {
      const bad = await this.readExact(1, 500);
      throw new Error(`Command 0x${hex8(bad[0] ?? 0)} rejected by the robot.`);
    }
    if (head[0] !== tx[0]) {
      throw new Error(`Misaligned answer (0x${hex8(head[0] ?? 0)}).`);
    }
    return this.readExact(respLen - 1, timeout);
  }

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  /**
   * A reset makes the bridge leave the bus and come back a few tens of ms
   * later. The entry loop waits for it instead of dropping the session; only a
   * session already in production mode has to be restarted.
   */
  private readonly onSerialDisconnect = (): void => {
    this.deviceLost = true;
    if (this.sessionActive && this.inProduction) {
      this.inProduction = false;
      this.setState("connecting", "device dropped, re-entering");
      this.log("Bridge left the bus, re-entering production mode.");
      void this.enterProductionLoop();
    }
  };

  private log(line: string): void {
    this.callbacks.log(line);
  }

  private setState(state: EfuseSessionState, text: string): void {
    this.callbacks.onState(state, text);
  }
}

/** Resolve a promise but never hang and never throw. */
function guard(promise: Promise<unknown>, ms = CLOSE_GUARD_MS): Promise<unknown> {
  return Promise.race([Promise.resolve(promise).catch(() => undefined), sleep(ms)]);
}
