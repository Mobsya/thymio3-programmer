export type TabId = "stm32" | "esp32" | "id";
export type OpState = "idle" | "running" | "done";

export interface FirmwareSelection {
  displayPath: string;
  data: ArrayBuffer | null;
  source: "server" | "local" | null;
  name: string | null;
}

export interface TabFlashState {
  op: OpState;
  firmware: FirmwareSelection;
  devicePresent: boolean;
  deviceLabel: string;
  log: string;
}

export interface AppState {
  activeTab: TabId;
  stm32: TabFlashState;
  esp32: TabFlashState;
}

export function emptyFirmware(): FirmwareSelection {
  return {
    displayPath: "",
    data: null,
    source: null,
    name: null,
  };
}

export function emptyTabFlashState(): TabFlashState {
  return {
    op: "idle",
    firmware: emptyFirmware(),
    devicePresent: false,
    deviceLabel: "No matching device",
    log: "",
  };
}

export const appState: AppState = {
  activeTab: "stm32",
  stm32: emptyTabFlashState(),
  esp32: emptyTabFlashState(),
};

/** True while a flash operation is actively running (tabs stay locked). DONE does not lock tabs. */
export function isOperationLocked(): boolean {
  return appState.stm32.op === "running" || appState.esp32.op === "running";
}

export function canProgram(tab: "stm32" | "esp32"): boolean {
  const s = appState[tab];
  return s.op === "idle" && s.devicePresent && s.firmware.data !== null;
}
