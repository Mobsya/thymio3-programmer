import { formatUsbIds, usbBcdDevice } from "./bcd";

export const STM32_VID = 0x0483;
export const STM32_PID = 0xdf11;
export const STM32_BCD = 0x2200;

export function isStm32DfuDevice(device: USBDevice): boolean {
  return (
    device.vendorId === STM32_VID &&
    device.productId === STM32_PID &&
    usbBcdDevice(device) === STM32_BCD
  );
}

export async function findAuthorizedStm32Devices(): Promise<USBDevice[]> {
  if (!navigator.usb) return [];
  const devices = await navigator.usb.getDevices();
  return devices.filter(isStm32DfuDevice);
}

export async function requestStm32DfuDevice(): Promise<USBDevice | null> {
  if (!navigator.usb) {
    throw new Error("WebUSB is not available in this browser.");
  }
  try {
    return await navigator.usb.requestDevice({
      filters: [{ vendorId: STM32_VID, productId: STM32_PID }],
    });
  } catch (err) {
    // User cancelled the chooser
    if (err instanceof DOMException && err.name === "NotFoundError") {
      return null;
    }
    throw err;
  }
}

export function describeStm32Device(device: USBDevice): string {
  const name = device.productName || "STM32 BOOTLOADER";
  return `${name} (${formatUsbIds(device)})`;
}

export type DevicePresenceListener = (present: boolean, label: string, device: USBDevice | null) => void;

export function watchStm32Devices(onChange: DevicePresenceListener): () => void {
  if (!navigator.usb) {
    onChange(false, "WebUSB not available", null);
    return () => undefined;
  }

  let current: USBDevice | null = null;

  const refresh = async () => {
    const matches = await findAuthorizedStm32Devices();
    const next = matches[0] ?? null;
    const present = next !== null;
    const label = present && next ? describeStm32Device(next) : "No STM32 DFU device (0483:DF11 @ 0x2200)";
    if (next !== current || !present) {
      current = next;
      onChange(present, label, next);
    } else {
      onChange(present, label, next);
    }
  };

  const onConnect = () => {
    void refresh();
  };
  const onDisconnect = () => {
    void refresh();
  };

  navigator.usb.addEventListener("connect", onConnect);
  navigator.usb.addEventListener("disconnect", onDisconnect);
  void refresh();

  return () => {
    navigator.usb?.removeEventListener("connect", onConnect);
    navigator.usb?.removeEventListener("disconnect", onDisconnect);
  };
}
