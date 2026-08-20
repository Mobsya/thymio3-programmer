import { appState, canProgram, isOperationLocked, type FirmwareSelection, type TabId } from "./state";
import { mountFirmwarePicker } from "./firmware/picker";
import {
  describeStm32Device,
  requestStm32DfuDevice,
  watchStm32Devices,
  isStm32DfuDevice,
} from "./usb/stm32Detect";
import {
  requestThymio3Port,
  watchEsp32Devices,
  isThymio3ReadyForEspFlash,
} from "./usb/esp32Detect";
import { programStm32Firmware } from "./flash/stm32";
import { programEsp32Firmware } from "./flash/esp32";
import { mountIdPanel, type IdPanelHandle } from "./efuse/panel";
import howToEnterDfuUrl from "./assets/HowToEnterDFU.svg";

type FlashTab = "stm32" | "esp32";

const LOG_BOTTOM_THRESHOLD_PX = 24;

let stm32Device: USBDevice | null = null;
let esp32Port: SerialPort | null = null;
let esp32SerialAuthorized = false;
/** Firmware identity last successfully programmed on ESP32 (while op is done). */
let esp32ProgrammedFirmwareKey: string | null = null;
let idPanel: IdPanelHandle | null = null;
/**
 * Teardown of the eFuse session started by a tab switch. The ESP32 tab shares
 * the same serial port, so it waits for this before opening it.
 */
let idSessionClosing: Promise<void> | null = null;

/** Auto-scroll each console only while the user is at (or returns to) the bottom. */
const logStickToBottom: Record<TabId, boolean> = {
  stm32: true,
  esp32: true,
  id: true,
};

const tabButtons = () =>
  Array.from(document.querySelectorAll<HTMLButtonElement>(".tab"));
const panels = () => Array.from(document.querySelectorAll<HTMLElement>(".panel"));

function isLogNearBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= LOG_BOTTOM_THRESHOLD_PX;
}

function bindLogScroll(tab: TabId): void {
  const el = document.querySelector<HTMLElement>(`#log-${tab}`);
  if (!el || el.dataset.scrollBound === "1") return;
  el.dataset.scrollBound = "1";
  el.addEventListener("scroll", () => {
    logStickToBottom[tab] = isLogNearBottom(el);
  });
}

function appendLog(tab: TabId, line: string): void {
  const state = appState[tab];
  state.log = state.log ? `${state.log}\n${line}` : line;
  const el = document.querySelector<HTMLElement>(`#log-${tab}`);
  if (el) {
    const stick = logStickToBottom[tab];
    el.textContent = state.log;
    if (stick) {
      el.scrollTop = el.scrollHeight;
      logStickToBottom[tab] = true;
    }
  }
}

function clearLog(tab: TabId): void {
  appState[tab].log = "";
  logStickToBottom[tab] = true;
  const el = document.querySelector<HTMLElement>(`#log-${tab}`);
  if (el) {
    el.textContent = "";
    el.scrollTop = 0;
  }
}

function isDummyMode(tab: FlashTab): boolean {
  const el = document.querySelector<HTMLInputElement>(`#${tab}-dummy`);
  return el?.checked ?? false;
}

function firmwareSelectionKey(sel: FirmwareSelection): string | null {
  if (!sel.data) return null;
  return `${sel.source ?? ""}|${sel.name ?? ""}|${sel.displayPath}|${sel.data.byteLength}`;
}

function onEsp32FirmwareChange(sel: FirmwareSelection): void {
  appState.esp32.firmware = sel;
  if (
    appState.esp32.op === "done" &&
    sel.data &&
    firmwareSelectionKey(sel) !== esp32ProgrammedFirmwareKey
  ) {
    appState.esp32.op = "idle";
    appendLog("esp32", "New firmware selected — ready to program again.");
  }
  updateProgramButton("esp32");
}

function updateDummyCheckbox(tab: FlashTab): void {
  const el = document.querySelector<HTMLInputElement>(`#${tab}-dummy`);
  if (!el) return;
  el.disabled = appState[tab].op === "running";
}

function updateProgramButton(tab: FlashTab): void {
  const btn = document.querySelector<HTMLButtonElement>(`#program-${tab}`);
  if (!btn) return;
  const state = appState[tab];

  btn.classList.remove("done");
  if (state.op === "done") {
    btn.disabled = true;
    btn.textContent = "DONE";
    btn.classList.add("done");
    return;
  }
  if (state.op === "running") {
    btn.disabled = true;
    btn.textContent = isDummyMode(tab) ? "Dummy…" : "Programming…";
    return;
  }
  btn.textContent = "Program";
  btn.disabled = !canProgram(tab);
  updateDummyCheckbox(tab);
}

function updateAuthorizeButtons(): void {
  const stm32Auth = document.getElementById("authorize-stm32");
  if (stm32Auth) {
    // Needed for a new/unrecognized DFU device; hide while a matching one is present.
    stm32Auth.hidden = appState.stm32.devicePresent;
  }

  const espSerial = document.getElementById("authorize-esp32-serial");
  if (espSerial) {
    espSerial.hidden = esp32SerialAuthorized;
  }
}

function updateDeviceStatus(tab: FlashTab): void {
  const el = document.querySelector<HTMLElement>(`#device-${tab}`);
  if (!el) return;
  const state = appState[tab];
  el.textContent = state.deviceLabel;
  el.classList.toggle("ok", state.devicePresent);
  updateProgramButton(tab);
  updateAuthorizeButtons();
}

function updateTabLockUI(): void {
  const locked = isOperationLocked();
  for (const btn of tabButtons()) {
    const id = btn.dataset.tab as TabId;
    if (id === appState.activeTab) {
      btn.disabled = false;
      continue;
    }
    btn.disabled = locked;
  }
}

function setActiveTab(tab: TabId): void {
  if (isOperationLocked() && tab !== appState.activeTab) {
    return;
  }
  if (appState.activeTab === "id" && tab !== "id") {
    // Leaving the ID tab releases the serial port. Fire and forget here (the
    // teardown is guarded and cannot hang), but keep the promise so a flash
    // started right after can wait for the port to be really free.
    idSessionClosing = idPanel?.closeSession() ?? null;
  }
  // The barcode reader types like a keyboard: it must only be listened to while
  // the ID tab is on screen.
  idPanel?.setActive(tab === "id");
  appState.activeTab = tab;
  for (const btn of tabButtons()) {
    const active = btn.dataset.tab === tab;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  }
  for (const panel of panels()) {
    const active = panel.dataset.tab === tab;
    panel.classList.toggle("active", active);
    panel.hidden = !active;
  }
  updateTabLockUI();
}

function renderStm32Panel(root: HTMLElement): void {
  root.innerHTML = `
    <h2>STM32 firmware</h2>
    <p class="lead">
      Put Thymio3 in DFU mode, select an <code>STM32-*.bin</code> firmware, then Program.
    </p>
    <img class="howto" src="${howToEnterDfuUrl}" alt="How to enter STM32 DFU mode on Thymio3" />
    <div id="fw-stm32"></div>
    <div class="device-row">
      <div id="device-stm32" class="device-status">${appState.stm32.deviceLabel}</div>
    </div>
    <div class="actions">
      <button type="button" class="secondary" id="authorize-stm32">Authorize USB</button>
      <label class="dummy-check">
        <input type="checkbox" id="stm32-dummy" />
        Dummy
      </label>
      <button type="button" class="primary" id="program-stm32" disabled>Program</button>
    </div>
    <pre id="log-stm32" class="log" aria-live="polite"></pre>
  `;
}

function renderEsp32Panel(root: HTMLElement): void {
  root.innerHTML = `
    <h2>ESP32 firmware</h2>
    <p class="lead">
      Requires STM32 already programmed (USB-serial bridge). Select a
      <code>FULL-ESP32-*.bin</code> image, authorize the Thymio3 serial port
      (USB <code>0x0617:0x000D</code>), then Program at 115200 baud / address 0x0.
      After flashing, RTS is pulsed to reset the ESP32 via STM32 <code>ESP32_ENABLE</code>.<br/>
      <b>If there are connection troubles, disconnect and reconnect USB cable. </b><br/>
      For faster and robust ESP32 programming use the external flash_download_tool
    </p>
    <div id="fw-esp32"></div>
    <div class="device-row">
      <div id="device-esp32" class="device-status">${appState.esp32.deviceLabel}</div>
    </div>
    <div class="actions">
      <button type="button" class="secondary" id="authorize-esp32-serial">Authorize serial</button>
      <label class="dummy-check">
        <input type="checkbox" id="esp32-dummy" />
        Dummy
      </label>
      <button type="button" class="primary" id="program-esp32" disabled>Program</button>
    </div>
    <pre id="log-esp32" class="log" aria-live="polite"></pre>
  `;
}

function mountIdTab(root: HTMLElement): void {
  idPanel = mountIdPanel({
    container: root,
    log: (line) => appendLog("id", line),
    clearLog: () => clearLog("id"),
    onSessionChange: (session) => {
      appState.id.session = session;
    },
  });
  bindLogScroll("id");
}

function formatDuration(ms: number): string {
  const totalSec = ms / 1000;
  if (totalSec < 60) {
    return `${totalSec.toFixed(1)} s`;
  }
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec - minutes * 60;
  return `${minutes} min ${seconds.toFixed(1)} s`;
}

async function onProgramStm32(): Promise<void> {
  const state = appState.stm32;
  const dummy = isDummyMode("stm32");
  if (!canProgram("stm32") || !state.firmware.data) return;

  let device = stm32Device;
  if (!device || !isStm32DfuDevice(device)) {
    device = await requestStm32DfuDevice();
    if (!device || !isStm32DfuDevice(device)) {
      appendLog("stm32", "No matching STM32 DFU device selected.");
      return;
    }
    stm32Device = device;
    state.devicePresent = true;
    state.deviceLabel = describeStm32Device(device);
    updateDeviceStatus("stm32");
  }

  state.op = "running";
  updateProgramButton("stm32");
  updateTabLockUI();
  clearLog("stm32");
  appendLog(
    "stm32",
    dummy ? "Starting STM32 dummy run (DFU connect only)…" : "Starting STM32 DFU programming…",
  );
  const startedAt = performance.now();

  try {
    await programStm32Firmware(device, state.firmware.data, (line) => appendLog("stm32", line), {
      dummy,
    });
    const elapsed = formatDuration(performance.now() - startedAt);
    if (dummy) {
      state.op = "done";
      appendLog("stm32", `Dummy run time: ${elapsed}`);
      appendLog(
        "stm32",
        "DONE — STM32 left DFU (:leave). You can switch to ESP32/ID now; Program stays DONE until a new DFU device is connected.",
      );
    } else {
      state.op = "done";
      appendLog("stm32", `Programming time: ${elapsed}`);
      appendLog(
        "stm32",
        "DONE — STM32 left DFU (:leave). You can switch to ESP32/ID now; Program stays DONE until a new DFU device is connected.",
      );
    }
  } catch (err) {
    const elapsed = formatDuration(performance.now() - startedAt);
    state.op = "idle";
    const message = err instanceof Error ? err.message : String(err);
    appendLog("stm32", `Error after ${elapsed}: ${message}`);
  } finally {
    updateProgramButton("stm32");
    updateTabLockUI();
  }
}

async function onProgramEsp32(): Promise<void> {
  const state = appState.esp32;
  const dummy = isDummyMode("esp32");
  if (!canProgram("esp32") || !state.firmware.data) return;

  if (idSessionClosing) {
    const pending = idSessionClosing;
    idSessionClosing = null;
    appendLog("esp32", "Waiting for the ID tab to release the serial port…");
    await pending;
  }

  let port = esp32Port;
  if (!port) {
    port = await requestThymio3Port();
    if (!port) {
      appendLog("esp32", "No Thymio3 serial port selected.");
      return;
    }
    esp32Port = port;
  }

  state.op = "running";
  updateProgramButton("esp32");
  updateTabLockUI();
  clearLog("esp32");
  appendLog("esp32", dummy ? "Starting ESP32 dummy run (connect + reset only)…" : "Starting ESP32 programming…");
  const startedAt = performance.now();

  try {
    await programEsp32Firmware(
      port,
      state.firmware.data,
      (line) => appendLog("esp32", line),
      { dummy },
    );
    const elapsed = formatDuration(performance.now() - startedAt);
    if (dummy) {
      state.op = "done";
      esp32ProgrammedFirmwareKey = firmwareSelectionKey(state.firmware);
      appendLog("esp32", `Dummy run time: ${elapsed}`);
    } else {
      state.op = "done";
      esp32ProgrammedFirmwareKey = firmwareSelectionKey(state.firmware);
      appendLog("esp32", `Programming time: ${elapsed}`);
      appendLog(
        "esp32",
        "DONE — select another firmware or wait until the device disappears before programming again.",
      );
    }
  } catch (err) {
    const elapsed = formatDuration(performance.now() - startedAt);
    state.op = "idle";
    const message = err instanceof Error ? err.message : String(err);
    appendLog("esp32", `Error after ${elapsed}: ${message}`);
  } finally {
    updateProgramButton("esp32");
    updateTabLockUI();
  }
}

async function refreshEsp32Presence(): Promise<void> {
  const status = await isThymio3ReadyForEspFlash();
  const prev = appState.esp32.devicePresent;
  esp32SerialAuthorized = status.port !== null;
  esp32Port = status.port;
  appState.esp32.devicePresent = status.present;
  appState.esp32.deviceLabel = status.label;
  if (appState.esp32.op === "done" && prev && !status.present) {
    appState.esp32.op = "idle";
    appendLog("esp32", "Device disappeared — ready for a new operation.");
  }
  updateDeviceStatus("esp32");
}

export async function initApp(): Promise<void> {
  const buildEl = document.getElementById("appBuild");
  if (buildEl) {
    buildEl.textContent = `App commit ${__APP_COMMIT__} · ${__APP_COMMIT_DATE__}`;
  }

  const warning = document.getElementById("browserWarning");
  if (warning) {
    if (!window.isSecureContext) {
      warning.classList.remove("hidden");
      const httpsUrl = `https://${location.hostname}${location.port ? `:${location.port}` : ""}${location.pathname}`;
      warning.textContent =
        `Not a secure context — WebUSB/Web Serial are disabled. On the host use http://localhost:5173, or from a VM run "npm run dev:https" on the host and open ${httpsUrl} (accept the certificate warning).`;
    } else if (!navigator.usb || !navigator.serial) {
      warning.classList.remove("hidden");
      warning.textContent =
        "This browser does not support WebUSB and/or Web Serial. Use Google Chrome or another Chromium-based browser.";
    }
  }

  renderStm32Panel(document.getElementById("panel-stm32")!);
  renderEsp32Panel(document.getElementById("panel-esp32")!);
  mountIdTab(document.getElementById("panel-id")!);
  bindLogScroll("stm32");
  bindLogScroll("esp32");

  await mountFirmwarePicker({
    kind: "stm32",
    container: document.getElementById("fw-stm32")!,
    initialDisplayPath: appState.stm32.firmware.displayPath,
    onChange: (sel) => {
      appState.stm32.firmware = sel;
      updateProgramButton("stm32");
    },
  });

  await mountFirmwarePicker({
    kind: "esp32",
    container: document.getElementById("fw-esp32")!,
    initialDisplayPath: appState.esp32.firmware.displayPath,
    onChange: onEsp32FirmwareChange,
  });

  for (const btn of tabButtons()) {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab as TabId;
      setActiveTab(tab);
    });
  }

  document.getElementById("authorize-stm32")?.addEventListener("click", async () => {
    try {
      const device = await requestStm32DfuDevice();
      if (!device) return;
      if (!isStm32DfuDevice(device)) {
        appendLog(
          "stm32",
          "Device authorized but product version is not 0x2200 (or IDs mismatch).",
        );
        return;
      }
      stm32Device = device;
      appState.stm32.devicePresent = true;
      appState.stm32.deviceLabel = describeStm32Device(device);
      updateDeviceStatus("stm32");
      appendLog("stm32", `Authorized: ${appState.stm32.deviceLabel}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      appendLog("stm32", `Authorize failed: ${message}`);
    }
  });

  document
    .getElementById("authorize-esp32-serial")
    ?.addEventListener("click", async () => {
      try {
        const port = await requestThymio3Port();
        if (!port) return;
        esp32Port = port;
        appendLog("esp32", "Serial port authorized.");
        await refreshEsp32Presence();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        appendLog("esp32", `Serial authorize failed: ${message}`);
      }
    });

  document.getElementById("program-stm32")?.addEventListener("click", () => {
    void onProgramStm32();
  });
  document.getElementById("program-esp32")?.addEventListener("click", () => {
    void onProgramEsp32();
  });
  for (const tab of ["stm32", "esp32"] as const) {
    document.getElementById(`${tab}-dummy`)?.addEventListener("change", () => {
      updateProgramButton(tab);
    });
  }

  watchStm32Devices((present, label, device) => {
    const prev = appState.stm32.devicePresent;
    stm32Device = device;
    appState.stm32.devicePresent = present;
    appState.stm32.deviceLabel = label;

    if (appState.stm32.op === "done") {
      // After flash the STM32 leaves DFU (USB ID changes). Keep DONE, but unlock
      // other tabs. Only return to idle when a new DFU device is connected.
      if (!prev && present) {
        appState.stm32.op = "idle";
        appendLog("stm32", "New STM32 DFU device connected — ready to program again.");
      } else if (prev && !present) {
        appendLog(
          "stm32",
          "STM32 left DFU mode (auto-reset). DONE — connect another DFU device to program again, or switch tab.",
        );
      }
    }

    updateDeviceStatus("stm32");
    updateTabLockUI();
  });

  watchEsp32Devices((present, label, port) => {
    const prev = appState.esp32.devicePresent;
    esp32SerialAuthorized = port !== null;
    esp32Port = port;
    appState.esp32.devicePresent = present;
    appState.esp32.deviceLabel = label;
    if (appState.esp32.op === "done" && prev && !present) {
      appState.esp32.op = "idle";
      appendLog("esp32", "Device disappeared — ready for a new operation.");
    }
    updateDeviceStatus("esp32");

    // The ID tab drives the same USB-CDC bridge, so it reuses this watcher.
    appState.id.devicePresent = present;
    appState.id.deviceLabel = label;
    idPanel?.setDevice(present, label);
  });

  setActiveTab("stm32");
  updateProgramButton("stm32");
  updateProgramButton("esp32");
  updateAuthorizeButtons();
}
