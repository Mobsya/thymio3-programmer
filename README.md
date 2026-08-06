# Thymio3 Web Programmer

Browser tool to program Thymio3 over USB from Chrome/Chromium:

1. **STM32 firmware** — WebUSB DFU (`STM32-*.bin`)
2. **ESP32 firmware** — Web Serial + esptool-js (`FULL-ESP32-*.bin`)
3. **Thymio3 ID** — placeholder (later)

## Requirements

- Chrome / Chromium
- HTTPS or `localhost` (secure context for WebUSB / Web Serial)
- On Windows, STM32 DFU may need a WinUSB driver (see Thymio3 programming docs)

## Develop

```bash
npm install
npm run dev
```

Both modes bind to all interfaces (`0.0.0.0`).

| Command | Use when | Open in browser |
|---------|----------|-----------------|
| `npm run dev` | Developing on the **host** | `http://localhost:5173` (`localhost` is already a secure context for WebUSB) |
| `npm run dev:https` | Testing from a **VM** / other machine | `https://<host-lan-ip>:5174` — accept the self-signed certificate warning once |

Stop any previous `npm run dev` before starting HTTPS if you reuse the same terminal; they use different ports (5173 / 5174) so both can run at once. Using `https://` against the HTTP server (or the reverse) produces `ERR_EMPTY_RESPONSE`.

WebUSB / Web Serial need a secure context: `https://…` or `http://localhost`. Plain `http://<lan-ip>` will not expose `navigator.usb`. Pass the USB device into the guest OS for flashing.

## Build

```bash
npm run build
npm run preview
```

## Firmware files

Hosted firmwares live under `public/firmware/` and are listed in `public/firmware/manifest.json`:

```json
{
  "stm32": [{ "name": "STM32-YYYYMMDD-xxxxxxxx.bin", "url": "./firmware/STM32-YYYYMMDD-xxxxxxxx.bin" }],
  "esp32": [{ "name": "FULL-ESP32-YYYYMMDD-xxxxxxxx.bin", "url": "./firmware/FULL-ESP32-YYYYMMDD-xxxxxxxx.bin" }]
}
```

Local `.bin` files can also be chosen in the UI (same naming rules).

Replace `public/assets/HowToEnterDFU.svg` with the final how-to artwork when ready.

## Deploy

Pushing to `main`/`master` builds and deploys `dist/` to GitHub Pages via `.github/workflows/deploy-pages.yml`. Enable GitHub Pages with the **GitHub Actions** source in the repository settings.
