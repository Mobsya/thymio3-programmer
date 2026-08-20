import { findAuthorizedThymio3Ports, requestThymio3Port } from "../usb/esp32Detect";
import { EfuseSession, type EfuseSessionState } from "./session";
import { classifyBits, describeVerdict, type BitState } from "./fuseMap";
import { describeLabelError, parseThymio3Label, type ParsedLabel } from "./barcode";
import { createBarcodeScanner } from "./scanner";
import {
  INVALID_ID,
  NO_ID,
  describeId,
  describeSetIdStatus,
  errMsg,
  hex32,
  idToParts,
  parseIdHex,
  partsToId,
} from "./protocol";

export interface IdPanelOptions {
  container: HTMLElement;
  /** Append one line to the tab log (owned by the app). */
  log: (line: string) => void;
  /** Clear the tab log (owned by the app). */
  clearLog: () => void;
  /** Reported on every session transition, so the app can lock the tabs. */
  onSessionChange: (state: EfuseSessionState) => void;
}

export interface IdPanelHandle {
  /** Feed the panel with the serial presence already watched by the app. */
  setDevice(present: boolean, label: string): void;
  /**
   * Release the serial port. Called when the user leaves the ID tab, so the
   * ESP32 tab finds the port free. Resolves once the port is really closed.
   */
  closeSession(): Promise<void>;
  /**
   * Enable barcode capture only while the ID tab is on screen: the reader
   * behaves as a keyboard and must not type into the other tabs.
   */
  setActive(active: boolean): void;
}

const BIT_COUNT = 32;

const SCAN_HINT =
  "Scan the label barcode";

export function mountIdPanel(options: IdPanelOptions): IdPanelHandle {
  renderMarkup(options.container);

  const el = {
    device: must<HTMLElement>("#device-id"),
    session: must<HTMLElement>("#id-session"),
    authorize: must<HTMLButtonElement>("#authorize-id-serial"),
    verbose: must<HTMLInputElement>("#id-verbose"),
    connect: must<HTMLButtonElement>("#id-connect"),
    disconnect: must<HTMLButtonElement>("#id-disconnect"),
    roId: must<HTMLElement>("#id-ro-id"),
    roLot: must<HTMLElement>("#id-ro-lot"),
    roEntries: must<HTMLElement>("#id-ro-entries"),
    fuseMap: must<HTMLElement>("#id-fusemap"),
    verdict: must<HTMLElement>("#id-verdict"),
    read: must<HTMLButtonElement>("#id-read"),
    entries: must<HTMLButtonElement>("#id-entries"),
    barcode: must<HTMLElement>("#id-barcode"),
    manual: must<HTMLInputElement>("#id-manual"),
    scanHint: must<HTMLElement>("#id-scan-hint"),
    scanClear: must<HTMLButtonElement>("#id-scan-clear"),
    inHex: must<HTMLInputElement>("#id-in-hex"),
    inLot: must<HTMLInputElement>("#id-in-lot"),
    inNum: must<HTMLInputElement>("#id-in-num"),
    write: must<HTMLButtonElement>("#id-write"),
    kill: must<HTMLButtonElement>("#id-kill"),
    reboot: must<HTMLButtonElement>("#id-reboot"),
    clear: must<HTMLButtonElement>("#id-clear-log"),
  };

  const bitCells = buildFuseMap(el.fuseMap);

  let session: EfuseSession | null = null;
  let sessionState: EfuseSessionState = "closed";
  let currentId: number | null = null;
  /** Guards the command buttons against re-entrancy on a shared port. */
  let busy = false;
  /** In flight port teardown, so a reconnect never races an unfinished close. */
  let closing: Promise<void> | null = null;
  /** Last label accepted from the barcode reader; drives the write fields. */
  let lastLabel: ParsedLabel | null = null;
  /**
   * Sticky: Web Serial permissions survive the reset, so once a port has been
   * authorized the button is gone for good. Live presence flickers while the
   * bridge re-enumerates and must not bring it back.
   */
  let everAuthorized = false;
  /** Last ID actually burned, to catch a robot swapped without a new scan. */
  let lastWrittenId: number | null = null;

  // -------------------------------------------------------------------------
  // Logging
  // -------------------------------------------------------------------------

  function log(line: string): void {
    const now = new Date();
    const stamp = `${now.toTimeString().slice(0, 8)}.${String(now.getMilliseconds()).padStart(3, "0")}`;
    options.log(`${stamp}  ${line}`);
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  function refreshButtons(): void {
    const closed = sessionState === "closed";
    const ready = sessionState === "production" && !busy;

    el.authorize.hidden = everAuthorized;
    el.connect.disabled = !closed || !everAuthorized || closing !== null;
    el.disconnect.disabled = closed;
    el.verbose.disabled = !closed;

    for (const button of [el.read, el.entries, el.write, el.kill, el.reboot]) {
      button.disabled = !ready;
    }
  }

  function renderId(id: number | null): void {
    currentId = id;
    if (id === null) {
      el.roId.textContent = "\u2014";
      el.roId.classList.add("dim");
      el.roLot.textContent = "\u2014";
      el.roLot.classList.add("dim");
      updateFuseMap();
      return;
    }

    el.roId.textContent = hex32(id);
    el.roId.classList.remove("dim");

    if (id === NO_ID || id === INVALID_ID) {
      el.roLot.textContent = id === NO_ID ? "not programmed" : "slots burned";
      el.roLot.classList.add("dim");
    } else {
      const parts = idToParts(id);
      el.roLot.textContent = `${parts.lot} \u00b7 ${parts.num}`;
      el.roLot.classList.remove("dim");
    }
    updateFuseMap();
  }

  function renderEntries(left: number | null): void {
    if (left === null) {
      el.roEntries.textContent = "\u2014";
      el.roEntries.classList.add("dim");
      return;
    }
    el.roEntries.textContent = `${left} / 3`;
    el.roEntries.classList.remove("dim");
  }

  function updateFuseMap(): void {
    const target = parseIdHex(el.inHex.value);
    const map = classifyBits(currentId, target);

    for (let i = 0; i < BIT_COUNT; i++) {
      const cell = bitCells[i];
      const state = map.bits[i];
      if (cell && state) cell.className = bitClass(state);
    }

    const verdict = describeVerdict(currentId, target, map);
    el.verdict.className = `id-verdict ${verdict.level}`;
    el.verdict.textContent = verdict.text;
  }

  /** The write fields are read-only unless the operator opts in. */
  function applyManualMode(): void {
    const manual = el.manual.checked;
    el.inHex.disabled = !manual;
    el.inLot.disabled = !manual;
    el.inNum.disabled = !manual;
  }

  function syncFromHex(): void {
    const id = parseIdHex(el.inHex.value);
    if (id !== null) {
      const parts = idToParts(id);
      el.inLot.value = parts.lot.replace(/\u00b7/g, "");
      el.inNum.value = String(parts.num);
    }
    updateFuseMap();
  }

  function syncFromParts(): void {
    const lot = el.inLot.value;
    const num = Number.parseInt(el.inNum.value, 10);
    if (lot.length >= 1 && Number.isFinite(num)) {
      el.inHex.value = hex32(partsToId(lot, num));
    }
    updateFuseMap();
  }

  // -------------------------------------------------------------------------
  // Barcode reader
  // -------------------------------------------------------------------------

  function setBarcode(text: string, level: "idle" | "ok" | "error"): void {
    el.barcode.textContent = text;
    el.barcode.classList.toggle("ok", level === "ok");
    el.barcode.classList.toggle("error", level === "error");
    el.barcode.classList.toggle("dim", level === "idle");
  }

  function setHint(text: string, level: "idle" | "ok" | "error"): void {
    el.scanHint.textContent = text;
    el.scanHint.classList.toggle("ok", level === "ok");
    el.scanHint.classList.toggle("error", level === "error");
  }

  /** Warn as soon as a manual edit makes the fields diverge from the label. */
  function refreshLabelHint(): void {
    if (!lastLabel) return;
    const typed = parseIdHex(el.inHex.value);
    if (typed === lastLabel.id) {
      const kind = lastLabel.prototype ? "prototype lot" : "lot";
      setHint(`Label ${lastLabel.raw} \u2192 ${kind} ${lastLabel.lot}, number ${lastLabel.num}.`, "ok");
    } else {
      setHint(
        `Fields no longer match the scanned label ${lastLabel.raw}. Scan again or check them.`,
        "error",
      );
    }
  }

  function clearLabel(hint: string): void {
    lastLabel = null;
    el.barcode.classList.remove("prototype");
    setBarcode("no label scanned", "idle");
    setHint(hint, "idle");
  }

  function applyLabel(label: ParsedLabel): void {
    lastLabel = label;
    el.barcode.classList.toggle("prototype", label.prototype);
    el.inHex.value = hex32(label.id);
    el.inLot.value = label.lot;
    el.inNum.value = String(label.num);
    setBarcode(label.raw, "ok");
    updateFuseMap();
    refreshLabelHint();
    log(
      `Label ${label.raw} \u2192 ${label.prototype ? "prototype lot" : "lot"} ${label.lot}, ` +
        `number ${label.num}, ID ${hex32(label.id)}`,
    );
  }

  function onScan(raw: string): void {
    const result = parseThymio3Label(raw);
    if (!result.label) {
      lastLabel = null;
      setBarcode(raw, "error");
      const reason = describeLabelError(result.error ?? "format");
      setHint(`Barcode not recognised: ${reason}.`, "error");
      log(`Barcode rejected: "${raw}" (${reason})`);
      return;
    }
    applyLabel(result.label);
  }

  const scanner = createBarcodeScanner({
    onScan,
    onPartial: (partial) => {
      if (partial.length > 0) setBarcode(`${partial}\u2026`, "idle");
    },
  });

  // -------------------------------------------------------------------------
  // Session
  // -------------------------------------------------------------------------

  function onSessionState(state: EfuseSessionState, text: string): void {
    const entered = state === "production" && sessionState !== "production";
    sessionState = state;
    el.session.textContent = text;
    el.session.classList.toggle("ok", state === "production");
    refreshButtons();
    options.onSessionChange(state);
    if (entered) void refreshAll();
  }

  async function connect(): Promise<void> {
    // A close started by a tab switch may still be tearing the port down.
    if (closing) await closing;
    if (session) return;
    let port: SerialPort | null = (await findAuthorizedThymio3Ports())[0] ?? null;
    if (!port) {
      try {
        port = await requestThymio3Port();
      } catch (err) {
        log(`Serial authorize failed: ${errMsg(err)}`);
        return;
      }
    }
    if (!port) {
      log("No Thymio3 serial port selected.");
      return;
    }

    options.clearLog();
    log("Opening the port resets the chip (RTS drives ESP32_ENABLE); the magic sequence is then streamed into the boot window.");
    const active = new EfuseSession({ log, onState: onSessionState });
    active.setVerbose(el.verbose.checked);
    session = active;
    try {
      await active.start(port);
    } catch (err) {
      log(`Connection failed: ${errMsg(err)}`);
      await disconnect();
    }
  }

  async function disconnect(): Promise<void> {
    if (closing) {
      await closing;
      return;
    }
    const active = session;
    session = null;
    if (!active && sessionState === "closed") return;

    closing = (async () => {
      if (active) await active.stop();
    })();
    refreshButtons();
    try {
      await closing;
    } finally {
      closing = null;
    }

    sessionState = "closed";
    el.session.textContent = "port closed";
    el.session.classList.remove("ok");
    renderId(null);
    renderEntries(null);
    refreshButtons();
    options.onSessionChange("closed");
    log("Port closed.");
  }

  /** Serialize command buttons: one command at a time on the wire. */
  async function run(action: () => Promise<void>): Promise<void> {
    if (busy || !session || !session.isInProduction) return;
    busy = true;
    refreshButtons();
    try {
      await action();
    } finally {
      busy = false;
      refreshButtons();
    }
  }

  async function readIdOnce(): Promise<void> {
    if (!session) return;
    try {
      const id = await session.readId();
      renderId(id);
      log(`Read ID \u2192 ${hex32(id)}${describeId(id)}`);
    } catch (err) {
      log(`Read ID: ${errMsg(err)}`);
    }
  }

  async function readEntriesOnce(): Promise<void> {
    if (!session) return;
    try {
      const left = await session.readEntriesLeft();
      renderEntries(left);
      log(`Slots left \u2192 ${left}`);
    } catch (err) {
      log(`Count slots: ${errMsg(err)}`);
      renderEntries(null);
    }
  }

  async function refreshAll(): Promise<void> {
    await run(async () => {
      await readIdOnce();
      await readEntriesOnce();
    });
  }

  async function writeId(): Promise<void> {
    const id = parseIdHex(el.inHex.value);
    if (id === null) {
      log("Invalid ID in the write field.");
      return;
    }

    // The one case worth interrupting the operator for: the same ID twice in a
    // row almost always means a new robot went on the bench and nobody scanned
    // its label.
    if (lastWrittenId !== null && id === lastWrittenId) {
      const parts = idToParts(id);
      const confirmed = window.confirm(
        `${hex32(id)} (lot ${parts.lot}, number ${parts.num}) was already written to the previous robot.\n\n` +
          "Scan the label of the new robot, or confirm to write the same ID again.",
      );
      if (!confirmed) return;
    }

    await run(async () => {
      if (!session) return;
      try {
        const status = await session.writeId(id);
        log(`Write ID \u2192 ${describeSetIdStatus(status)}`);
        if (status === 0) {
          lastWrittenId = id;
          setHint(`Written ${hex32(id)}. Scan the label of the next robot.`, "ok");
        }
      } catch (err) {
        log(`Write ID: ${errMsg(err)}`);
      }
      await readIdOnce();
      await readEntriesOnce();
    });
  }

  async function killSlot(): Promise<void> {
    if (
      !window.confirm(
        "Burn the current slot to 0xFFFFFFFF?\n\nOne of the three slots is lost for good.",
      )
    ) {
      return;
    }

    await run(async () => {
      if (!session) return;
      try {
        const status = await session.killSlot();
        log(
          status === 0
            ? "Kill slot \u2192 slot burned"
            : "Kill slot \u2192 failed, no slot left for the next ID",
        );
      } catch (err) {
        log(`Kill slot: ${errMsg(err)}`);
      }
      await readIdOnce();
      await readEntriesOnce();
    });
  }

  async function reboot(): Promise<void> {
    if (!window.confirm("Reboot the robot? Production mode is left behind.")) return;
    await run(async () => {
      if (!session) return;
      try {
        await session.reboot();
        log("Robot rebooting \u2014 close the port or reconnect to re-enter production mode.");
      } catch (err) {
        log(`Reboot: ${errMsg(err)}`);
      }
      renderId(null);
      renderEntries(null);
    });
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  el.authorize.addEventListener("click", () => {
    void (async () => {
      try {
        const port = await requestThymio3Port();
        if (!port) return;
        everAuthorized = true;
        refreshButtons();
        log("Serial port authorized.");
      } catch (err) {
        log(`Serial authorize failed: ${errMsg(err)}`);
      }
    })();
  });

  el.connect.addEventListener("click", () => {
    void connect();
  });
  el.disconnect.addEventListener("click", () => {
    void disconnect();
  });
  el.read.addEventListener("click", () => {
    void run(readIdOnce);
  });
  el.entries.addEventListener("click", () => {
    void run(readEntriesOnce);
  });
  el.write.addEventListener("click", () => {
    void writeId();
  });
  el.kill.addEventListener("click", () => {
    void killSlot();
  });
  el.reboot.addEventListener("click", () => {
    void reboot();
  });
  el.clear.addEventListener("click", () => {
    options.clearLog();
  });

  el.inHex.addEventListener("input", () => {
    syncFromHex();
    refreshLabelHint();
  });
  el.inLot.addEventListener("input", () => {
    syncFromParts();
    refreshLabelHint();
  });
  el.inNum.addEventListener("input", () => {
    syncFromParts();
    refreshLabelHint();
  });

  el.scanClear.addEventListener("click", () => {
    clearLabel(SCAN_HINT);
  });

  el.manual.addEventListener("change", applyManualMode);

  renderId(null);
  renderEntries(null);
  clearLabel(SCAN_HINT);
  applyManualMode();
  refreshButtons();

  // A port authorized in a previous run (or from the ESP32 tab) is still ours.
  void (async () => {
    if ((await findAuthorizedThymio3Ports()).length > 0) {
      everAuthorized = true;
      refreshButtons();
    }
  })();

  return {
    setDevice(present: boolean, label: string): void {
      if (present) everAuthorized = true;
      el.device.textContent = label;
      el.device.classList.toggle("ok", present);
      refreshButtons();
    },
    async closeSession(): Promise<void> {
      if (!session && sessionState === "closed" && !closing) return;
      await disconnect();
    },
    setActive(active: boolean): void {
      if (active) scanner.enable();
      else scanner.disable();
    },
  };
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function must<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`ID panel: missing element ${selector}`);
  return element;
}

function bitClass(state: BitState): string {
  return state === "intact" ? "id-bit" : `id-bit ${state}`;
}

/** Four groups of eight cells, MSB first. @returns the cells indexed by bit. */
function buildFuseMap(container: HTMLElement): HTMLElement[] {
  const cells: HTMLElement[] = new Array<HTMLElement>(BIT_COUNT);
  container.textContent = "";

  for (let group = 0; group < 4; group++) {
    const high = 31 - group * 8;
    const wrapper = document.createElement("div");

    const label = document.createElement("div");
    label.className = "id-byte-label";
    label.textContent = `bit ${high}\u2026${high - 7}`;
    wrapper.appendChild(label);

    const bits = document.createElement("div");
    bits.className = "id-bits";
    for (let k = 0; k < 8; k++) {
      const index = high - k;
      const cell = document.createElement("div");
      cell.className = "id-bit";
      cell.title = `bit ${index}`;
      bits.appendChild(cell);
      cells[index] = cell;
    }
    wrapper.appendChild(bits);
    container.appendChild(wrapper);
  }

  return cells;
}

function renderMarkup(root: HTMLElement): void {
  root.innerHTML = `
    <h2>Thymio3 ID</h2>
    <p class="lead">
      Reads and burns the robot ID stored in ESP32 eFuse BLK3. <br/>
      Requires ESP32 firmware already programmed.
      The label barcode reader fills the ID fields on its own: scan without clicking into any field. <br/> 
      LOT is two letters, or <code>@</code> plus a letter for prototypes.<br/>
      NUMBER is from 0 to 65535. <br/>
    </p>
    <div class="device-row">
      <div id="device-id" class="device-status">No Thymio3 serial device (USB 0x0617:0xFFFF)</div>
      <div id="id-session" class="device-status">port closed</div>
    </div>
    <div class="actions">
      <button type="button" class="secondary" id="authorize-id-serial">Authorize serial</button>
      <button type="button" class="primary" id="id-connect" disabled>Connect robot</button>
      <button type="button" class="secondary" id="id-disconnect" disabled>Close</button>
    </div>

    <div class="id-grid">
      <section class="id-block">
        <h3>Write</h3>
        <div class="id-scan">
          <span class="field-label">Label barcode</span>
          <div class="id-scan-row">
            <output class="id-scan-value dim" id="id-barcode">no label scanned</output>
            <button type="button" class="secondary" id="id-scan-clear">Clear</button>
          </div>
          <p class="id-scan-hint" id="id-scan-hint"></p>
        </div>

        <label class="dummy-check id-manual">
          <input type="checkbox" id="id-manual" />
          Manual setting
        </label>
        <div class="id-fields">
          <label class="id-field">
            <span class="field-label">ID to write (hex)</span>
            <input type="text" id="id-in-hex" value="0x00000000" spellcheck="false" autocomplete="off" disabled />
          </label>
          <label class="id-field short">
            <span class="field-label">Lot</span>
            <input type="text" id="id-in-lot" maxlength="2" placeholder="AA" spellcheck="false" autocomplete="off" disabled />
          </label>
          <label class="id-field short">
            <span class="field-label">Number</span>
            <input type="text" id="id-in-num" placeholder="0" spellcheck="false" autocomplete="off" disabled />
          </label>
        </div>
        <p class="id-note">
        </p>

        <div class="actions">
          <button type="button" class="primary" id="id-write" disabled>Write ID</button>
          <button type="button" class="secondary danger" id="id-kill" disabled>Kill current slot</button>
        </div>
        <p class="id-warning">Write and kill are irreversible operations!</p>
        <p class="id-note">
        </p>
      </section>

      <section class="id-block">
        <h3>eFuse state</h3>
        <div class="id-readouts">
          <div class="id-readout">
            <div class="k">Current ID</div>
            <div class="v dim" id="id-ro-id">&mdash;</div>
          </div>
          <div class="id-readout">
            <div class="k">Lot &middot; number</div>
            <div class="v dim" id="id-ro-lot">&mdash;</div>
          </div>
          <div class="id-readout">
            <div class="k">Slots left</div>
            <div class="v dim" id="id-ro-entries">&mdash;</div>
          </div>
        </div>

        <div class="id-bytes" id="id-fusemap"></div>
        <div class="id-legend">
          <span><i class="id-swatch intact"></i>bit at 0</span>
          <span><i class="id-swatch burned"></i>already burned to 1</span>
          <span><i class="id-swatch toburn"></i>to burn</span>
          <span><i class="id-swatch conflict"></i>impossible (1 &rarr; 0)</span>
        </div>

        <div class="id-verdict neutral" id="id-verdict">Connect the robot to fill the map.</div>

        <div class="actions">
          <button type="button" class="secondary" id="id-read" disabled>Read ID</button>
          <button type="button" class="secondary" id="id-entries" disabled>Count slots</button>
        </div>
      </section>
    </div>

    <pre id="log-id" class="log" aria-live="polite"></pre>
    <div class="actions">
      <button type="button" class="secondary" id="id-clear-log">Clear log</button>
      <button type="button" class="secondary" id="id-reboot" disabled>Reboot robot</button>
      <label class="dummy-check">
        <input type="checkbox" id="id-verbose" />
        Verbose serial log
      </label>
    </div>
  `;
}
