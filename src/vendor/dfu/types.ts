/** Minimal typing for vendored DFU / DfuSe helpers. */

export interface DfuSettings {
  configuration: USBConfiguration;
  interface: USBInterface;
  alternate: USBAlternateInterface;
  name: string | null;
}

export interface DfuDevice {
  device_: USBDevice;
  settings: DfuSettings;
  intfNumber: number;
  disconnected?: boolean;
  properties?: Record<string, unknown>;
  memoryInfo?: {
    name: string;
    segments: Array<{
      start: number;
      end: number;
      readable: boolean;
      erasable: boolean;
      writable: boolean;
    }>;
  };
  startAddress?: number;
  logDebug: (msg: string) => void;
  logInfo: (msg: string) => void;
  logWarning: (msg: string) => void;
  logError: (msg: string) => void;
  logProgress: (done: number, total?: number) => void;
  open: () => Promise<void>;
  close: () => Promise<void>;
  getStatus: () => Promise<{ state: number; status: number }>;
  clearStatus: () => Promise<void>;
  readInterfaceNames: () => Promise<
    Record<number, Record<number, Record<number, string | null>>>
  >;
  do_download: (
    xferSize: number,
    data: ArrayBuffer,
    manifestationTolerant: boolean,
  ) => Promise<void>;
  waitDisconnected: (timeoutMs: number) => Promise<USBDevice>;
}

export interface DfuModule {
  dfuIDLE: number;
  dfuERROR: number;
  Device: new (device: USBDevice, settings: DfuSettings) => DfuDevice;
  findDeviceDfuInterfaces: (device: USBDevice) => DfuSettings[];
}

export interface DfuseModule {
  Device: new (device: USBDevice, settings: DfuSettings) => DfuDevice;
}
