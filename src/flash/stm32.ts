import { dfu } from "../vendor/dfu/dfu.js";
import { dfuse } from "../vendor/dfu/dfuse.js";
import type { DfuDevice, DfuSettings } from "../vendor/dfu/types";
import { isStm32DfuDevice } from "../usb/stm32Detect";

const dfuMod = dfu;
const dfuseMod = dfuse;

export type LogFn = (line: string) => void;

async function fixInterfaceNames(device: USBDevice, interfaces: DfuSettings[]): Promise<void> {
  if (!interfaces.some((intf) => intf.name == null)) return;

  const tempDevice = new dfuMod.Device(device, interfaces[0]!);
  await tempDevice.open();
  const mapping = await tempDevice.readInterfaceNames();
  await tempDevice.close();

  for (const intf of interfaces) {
    if (intf.name === null) {
      const configIndex = intf.configuration.configurationValue;
      const intfNumber = intf.interface.interfaceNumber;
      const alt = intf.alternate.alternateSetting;
      intf.name = mapping[configIndex]?.[intfNumber]?.[alt] ?? null;
    }
  }
}

function pickInternalFlashInterface(interfaces: DfuSettings[]): DfuSettings | null {
  const dfuMode = interfaces.filter((i) => i.alternate.interfaceProtocol === 0x02);
  const byName = dfuMode.find((i) => (i.name || "").toLowerCase().includes("internal flash"));
  if (byName) return byName;
  const alt0 = dfuMode.find((i) => i.alternate.alternateSetting === 0);
  if (alt0) return alt0;
  return dfuMode[0] ?? interfaces[0] ?? null;
}

async function readDfuFunctionalDescriptor(
  device: DfuDevice,
): Promise<{ transferSize: number; manifestationTolerant: boolean }> {
  let transferSize = 2048;
  let manifestationTolerant = true;

  try {
    const result = await device.device_.controlTransferIn(
      {
        requestType: "standard",
        recipient: "interface",
        request: 0x06,
        value: 0x2100,
        index: device.intfNumber,
      },
      9,
    );
    if (result.data && result.data.byteLength >= 9) {
      const view = new DataView(result.data.buffer);
      const attributes = view.getUint8(2);
      manifestationTolerant = (attributes & 0x04) !== 0;
      transferSize = view.getUint16(5, true) || transferSize;
    }
  } catch {
    // keep defaults
  }

  return { transferSize, manifestationTolerant };
}

export async function programStm32Firmware(
  usbDevice: USBDevice,
  firmware: ArrayBuffer,
  log: LogFn,
  options?: { dummy?: boolean },
): Promise<void> {
  const dummy = options?.dummy ?? false;
  if (!isStm32DfuDevice(usbDevice)) {
    throw new Error("Selected USB device is not the expected STM32 DFU bootloader.");
  }

  const interfaces = dfuMod.findDeviceDfuInterfaces(usbDevice);
  if (interfaces.length === 0) {
    throw new Error("The selected device has no USB DFU interfaces.");
  }

  await fixInterfaceNames(usbDevice, interfaces);
  const settings = pickInternalFlashInterface(interfaces);
  if (!settings) {
    throw new Error("Could not find Internal Flash DFU interface.");
  }

  log(`Using interface: ${settings.name || "alt " + settings.alternate.alternateSetting}`);

  // STM32 bootloader uses DfuSe
  const device: DfuDevice = new dfuseMod.Device(usbDevice, settings);
  let lastPct = -1;
  device.logDebug = (m) => log(`[debug] ${m}`);
  device.logInfo = (m) => log(m);
  device.logWarning = (m) => log(`[warn] ${m}`);
  device.logError = (m) => log(`[error] ${m}`);
  device.logProgress = (done, total) => {
    if (total && total > 0) {
      const pct = Math.floor((100 * done) / total);
      if (pct !== lastPct && (pct % 5 === 0 || done === total)) {
        lastPct = pct;
        log(`Progress: ${pct}% (${done}/${total})`);
      }
    }
  };

  try {
    await device.open();
    const desc = await readDfuFunctionalDescriptor(device);

    try {
      const status = await device.getStatus();
      if (status.state === dfuMod.dfuERROR) {
        await device.clearStatus();
      }
    } catch {
      log("[warn] Failed to clear DFU status");
    }

    if (device.memoryInfo?.segments?.[0]) {
      device.startAddress = device.memoryInfo.segments[0].start;
      log(`Memory: ${device.memoryInfo.name}, start 0x${device.startAddress.toString(16)}`);
    }

    if (dummy) {
      const leaveAddress = device.startAddress ?? device.memoryInfo?.segments?.[0]?.start;
      log(
        `Dummy mode: skipping flash of ${firmware.byteLength} bytes (transfer size ${desc.transferSize}); DFU verify only.`,
      );
      log(`Leave: DfuSe :leave at 0x${(leaveAddress ?? 0x08000000).toString(16)}…`);
      await device.do_leave(leaveAddress);
      log("Dummy run complete.");
      return;
    }

    log(`Writing ${firmware.byteLength} bytes (transfer size ${desc.transferSize})…`);
    await device.do_download(desc.transferSize, firmware, desc.manifestationTolerant);
    log("STM32 programming complete.");
  } finally {
    try {
      await device.close();
    } catch {
      // device may already have reset/disconnected
    }
  }
}
