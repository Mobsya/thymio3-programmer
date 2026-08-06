import { formatUsbIds, usbBcdDevice } from "./bcd";

export const THYMIO3_VID = 0xffff;
export const THYMIO3_PID = 0xffff;
export const THYMIO3_BCD = 0x0200;
export const THYMIO3_MANUFACTURER = "Mobsya";

export function isThymio3UsbDevice(device: USBDevice): boolean {
  return (
    device.vendorId === THYMIO3_VID &&
    device.productId === THYMIO3_PID &&
    usbBcdDevice(device) === THYMIO3_BCD &&
    (device.manufacturerName || "") === THYMIO3_MANUFACTURER
  );
}

export async function findAuthorizedThymio3UsbDevices(): Promise<USBDevice[]> {
  if (!navigator.usb) return [];
  const devices = await navigator.usb.getDevices();
  return devices.filter(isThymio3UsbDevice);
}

export async function requestThymio3UsbDevice(): Promise<USBDevice | null> {
  if (!navigator.usb) {
    throw new Error("WebUSB is not available in this browser.");
  }
  try {
    const device = await navigator.usb.requestDevice({
      filters: [{ vendorId: THYMIO3_VID, productId: THYMIO3_PID }],
    });
    if (!isThymio3UsbDevice(device)) {
      return null;
    }
    return device;
  } catch (err) {
    if (err instanceof DOMException && err.name === "NotFoundError") {
      return null;
    }
    throw err;
  }
}

export function serialFilters(): SerialPortFilter[] {
  return [{ usbVendorId: THYMIO3_VID, usbProductId: THYMIO3_PID }];
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

/**
 * Thymio3 is ready for ESP programming when WebUSB identity matches
 * (Mobsya + bcd 0x0200) and a serial port with FFFF:FFFF is authorized.
 */
export async function isThymio3ReadyForEspFlash(): Promise<{
  present: boolean;
  label: string;
  port: SerialPort | null;
  usb: USBDevice | null;
}> {
  const usbDevices = await findAuthorizedThymio3UsbDevices();
  const ports = await findAuthorizedThymio3Ports();
  const usb = usbDevices[0] ?? null;
  const port = ports[0] ?? null;

  if (usb && port) {
    return {
      present: true,
      label: `${usb.productName || "Thymio3"} (${formatUsbIds(usb)}, ${usb.manufacturerName})`,
      port,
      usb,
    };
  }

  if (usb && !port) {
    return {
      present: false,
      label: `USB OK (${formatUsbIds(usb)}) — authorize serial port`,
      port: null,
      usb,
    };
  }

  if (!usb && port) {
    return {
      present: false,
      label: "Serial port authorized — authorize WebUSB for Mobsya identity check",
      port,
      usb: null,
    };
  }

  return {
    present: false,
    label: "No Thymio3 device (FFFF:FFFF, Mobsya, bcd 0x0200)",
    port: null,
    usb: null,
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

  const onUsb = () => {
    void refresh();
  };
  const onSerialConnect = () => {
    void refresh();
  };
  const onSerialDisconnect = () => {
    void refresh();
  };

  navigator.usb?.addEventListener("connect", onUsb);
  navigator.usb?.addEventListener("disconnect", onUsb);
  navigator.serial?.addEventListener("connect", onSerialConnect);
  navigator.serial?.addEventListener("disconnect", onSerialDisconnect);

  void refresh();
  const interval = window.setInterval(() => {
    void refresh();
  }, 2000);

  return () => {
    navigator.usb?.removeEventListener("connect", onUsb);
    navigator.usb?.removeEventListener("disconnect", onUsb);
    navigator.serial?.removeEventListener("connect", onSerialConnect);
    navigator.serial?.removeEventListener("disconnect", onSerialDisconnect);
    window.clearInterval(interval);
  };
}
