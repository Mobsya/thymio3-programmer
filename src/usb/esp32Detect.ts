export const THYMIO3_VID = 0x0617;
export const THYMIO3_PID = 0xffff;

export function serialFilters(): SerialPortFilter[] {
  return [{ usbVendorId: THYMIO3_VID, usbProductId: THYMIO3_PID }];
}

export function describeThymio3Port(port: SerialPort): string {
  const info = port.getInfo();
  const vid = (info.usbVendorId ?? 0).toString(16).padStart(4, "0");
  const pid = (info.usbProductId ?? 0).toString(16).padStart(4, "0");
  return `Thymio3 serial (0x${vid}:0x${pid})`;
}

export async function findAuthorizedThymio3Ports(): Promise<SerialPort[]> {
  if (!navigator.serial) return [];
  const ports = await navigator.serial.getPorts();
  return ports.filter((port) => {
    const info = port.getInfo();
    return info.usbVendorId === THYMIO3_VID && info.usbProductId === THYMIO3_PID;
  });
}

export async function requestThymio3Port(): Promise<SerialPort | null> {
  if (!navigator.serial) {
    throw new Error("Web Serial is not available in this browser.");
  }
  try {
    return await navigator.serial.requestPort({ filters: serialFilters() });
  } catch (err) {
    if (err instanceof DOMException && err.name === "NotFoundError") {
      return null;
    }
    throw err;
  }
}

/** Thymio3 is ready for ESP programming when a FFFF:FFFF serial port is authorized. */
export async function isThymio3ReadyForEspFlash(): Promise<{
  present: boolean;
  label: string;
  port: SerialPort | null;
}> {
  const ports = await findAuthorizedThymio3Ports();
  const port = ports[0] ?? null;
  if (port) {
    return {
      present: true,
      label: describeThymio3Port(port),
      port,
    };
  }
  return {
    present: false,
    label: "No Thymio3 serial device (USB 0x0617:0xFFFF)",
    port: null,
  };
}

export type EspPresenceListener = (
  present: boolean,
  label: string,
  port: SerialPort | null,
) => void;

export function watchEsp32Devices(onChange: EspPresenceListener): () => void {
  const refresh = async () => {
    const status = await isThymio3ReadyForEspFlash();
    onChange(status.present, status.label, status.port);
  };

  const onSerialConnect = () => {
    void refresh();
  };
  const onSerialDisconnect = () => {
    void refresh();
  };

  navigator.serial?.addEventListener("connect", onSerialConnect);
  navigator.serial?.addEventListener("disconnect", onSerialDisconnect);

  void refresh();
  const interval = window.setInterval(() => {
    void refresh();
  }, 2000);

  return () => {
    navigator.serial?.removeEventListener("connect", onSerialConnect);
    navigator.serial?.removeEventListener("disconnect", onSerialDisconnect);
    window.clearInterval(interval);
  };
}
