import { ESPLoader, Transport, type FlashOptions, type LoaderOptions } from "esptool-js";
import type { LogFn } from "./stm32";

/**
 * Speed used for the whole session, ROM handshake included.
 *
 * esptool-js keeps its ROM speed in a private `romBaudrate` field that defaults
 * to 115200 and cannot be set through LoaderOptions. When it differs from
 * `baudrate`, `main()` calls `changeBaud()` right after uploading the stub, and
 * that closes and reopens the serial port. On Thymio3 a reopen is a reset:
 * Chrome asserts RTS on open and RTS drives ESP32_ENABLE, so the freshly
 * uploaded stub would be wiped before the first flash block. Running the ROM
 * handshake at the target speed instead keeps the port open from start to end.
 */
export const ESP_BAUDRATE = 115200;
export const ESP_FLASH_ADDRESS = 0x0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Pulse RTS to reset the ESP32.
 * On Thymio3, STM32 CDC maps RTS → ESP32_ENABLE (inverted):
 * RTS asserted holds the chip in reset; deassert releases it to run.
 */
async function resetEsp32ViaRts(transport: Transport, log: LogFn): Promise<void> {
  log("Reset: pulsing RTS (ESP32_ENABLE)…");
  await transport.setDTR(false);
  await transport.setRTS(true);
  await sleep(100);
  await transport.setRTS(false);
  await sleep(50);
  log("Reset done.");
}

export async function programEsp32Firmware(
  port: SerialPort,
  firmware: ArrayBuffer,
  log: LogFn,
  options?: { dummy?: boolean },
): Promise<void> {
  const dummy = options?.dummy ?? false;
  const transport = new Transport(port, true);
  const terminal = {
    clean() {
      /* no-op */
    },
    writeLine(data: string) {
      log(data);
    },
    write(data: string) {
      log(data);
    },
  };

  const loaderOptions = {
    transport,
    baudrate: ESP_BAUDRATE,
    terminal,
    debugLogging: false,
  } as LoaderOptions;

  const esploader = new ESPLoader(loaderOptions);
  // Match the private ROM speed to the target speed so esptool-js skips its
  // mid-session close/reopen. See the ESP_BAUDRATE comment for why that matters
  // on this board.
  (esploader as unknown as { romBaudrate: number }).romBaudrate = ESP_BAUDRATE;

  try {
    log(`Connecting at ${ESP_BAUDRATE} baud…`);
    const chip = await esploader.main();
    log(`Connected to ${chip}`);

    if (dummy) {
      log(
        `Dummy mode: skipping flash of ${firmware.byteLength} bytes (esptool-js has no dry-run); reset only.`,
      );
      await esploader.after("no_reset");
      await resetEsp32ViaRts(transport, log);
      log("Dummy run complete.");
      return;
    }

    const data = new Uint8Array(firmware);
    log(`Flashing ${firmware.byteLength} bytes at 0x${ESP_FLASH_ADDRESS.toString(16)}…`);

    let lastPct = -1;
    const flashOptions = {
      fileArray: [{ data, address: ESP_FLASH_ADDRESS }],
      eraseAll: false,
      compress: true,
      flashMode: "keep",
      flashFreq: "keep",
      flashSize: "keep",
      reportProgress: (_fileIndex: number, written: number, total: number) => {
        if (total > 0) {
          const pct = Math.floor((100 * written) / total);
          if (pct !== lastPct && (pct % 5 === 0 || written === total)) {
            lastPct = pct;
            log(`Progress: ${pct}% (${written}/${total})`);
          }
        }
      },
    } as FlashOptions;

    await esploader.writeFlash(flashOptions);
    // Skip esptool hard_reset (only deasserts RTS); do an explicit RTS pulse instead.
    await esploader.after("no_reset");
    await resetEsp32ViaRts(transport, log);
    log("ESP32 programming complete.");
  } finally {
    try {
      await transport.disconnect();
    } catch {
      // port may already be closed
    }
  }
}
