/** Reconstruct USB bcdDevice from WebUSB version fields. */
export function usbBcdDevice(device: USBDevice): number {
  return (
    ((device.deviceVersionMajor & 0xff) << 8) |
    ((device.deviceVersionMinor & 0x0f) << 4) |
    (device.deviceVersionSubminor & 0x0f)
  );
}

export function formatUsbIds(device: USBDevice): string {
  const vid = device.vendorId.toString(16).padStart(4, "0");
  const pid = device.productId.toString(16).padStart(4, "0");
  const bcd = usbBcdDevice(device).toString(16).padStart(4, "0");
  return `0x${vid}:0x${pid} bcd=0x${bcd}`;
}
