export interface ManifestEntry {
  name: string;
  url: string;
}

export interface FirmwareManifest {
  stm32: ManifestEntry[];
  esp32: ManifestEntry[];
}

export type FirmwareKind = "stm32" | "esp32";

const NAME_PATTERNS: Record<FirmwareKind, RegExp> = {
  stm32: /^STM32-.*\.bin$/i,
  esp32: /^FULL-ESP32-.*\.bin$/i,
};

export function matchesFirmwareName(kind: FirmwareKind, name: string): boolean {
  return NAME_PATTERNS[kind].test(name);
}

export function firmwarePatternHint(kind: FirmwareKind): string {
  return kind === "stm32" ? "STM32-*.bin" : "FULL-ESP32-*.bin";
}

export async function loadManifest(): Promise<FirmwareManifest> {
  try {
    const res = await fetch(new URL("firmware/manifest.json", document.baseURI));
    if (!res.ok) {
      return { stm32: [], esp32: [] };
    }
    const data = (await res.json()) as FirmwareManifest;
    return {
      stm32: (data.stm32 || []).filter((e) => matchesFirmwareName("stm32", e.name)),
      esp32: (data.esp32 || []).filter((e) => matchesFirmwareName("esp32", e.name)),
    };
  } catch {
    return { stm32: [], esp32: [] };
  }
}

export async function fetchFirmware(url: string): Promise<ArrayBuffer> {
  const absolute = new URL(url, document.baseURI).href;
  const res = await fetch(absolute);
  if (!res.ok) {
    throw new Error(`Failed to download firmware (${res.status})`);
  }
  return res.arrayBuffer();
}

export function readLocalFirmware(file: File): Promise<ArrayBuffer> {
  return file.arrayBuffer();
}

export function resolveDisplayPath(entry: ManifestEntry): string {
  return new URL(entry.url, document.baseURI).href;
}

export interface FirmwarePickerOptions {
  kind: FirmwareKind;
  container: HTMLElement;
  initialDisplayPath?: string;
  onChange: (selection: {
    displayPath: string;
    data: ArrayBuffer | null;
    source: "server" | "local" | null;
    name: string | null;
  }) => void;
}

export async function mountFirmwarePicker(options: FirmwarePickerOptions): Promise<void> {
  const { kind, container, onChange } = options;
  const manifest = await loadManifest();
  const entries = manifest[kind];

  container.innerHTML = `
    <div class="firmware-picker">
      <label class="field-label">Firmware file (${firmwarePatternHint(kind)})</label>
      <div class="firmware-row">
        <select class="fw-server" aria-label="Server firmware">
          <option value="">— Select from server —</option>
          ${entries
            .map(
              (e, i) =>
                `<option value="${i}">${escapeHtml(e.name)}</option>`,
            )
            .join("")}
        </select>
        <label class="file-btn">
          Local file
          <input type="file" class="fw-local" accept=".bin,application/octet-stream" hidden />
        </label>
      </div>
      <label class="field-label" for="fw-path-${kind}">Selected path</label>
      <input id="fw-path-${kind}" class="fw-path" type="text" readonly placeholder="No firmware selected" value="${escapeHtml(options.initialDisplayPath || "")}" />
      <p class="hint fw-error" hidden></p>
    </div>
  `;

  const serverSelect = container.querySelector<HTMLSelectElement>(".fw-server")!;
  const localInput = container.querySelector<HTMLInputElement>(".fw-local")!;
  const pathField = container.querySelector<HTMLInputElement>(".fw-path")!;
  const errorEl = container.querySelector<HTMLElement>(".fw-error")!;

  const showError = (msg: string | null) => {
    if (!msg) {
      errorEl.hidden = true;
      errorEl.textContent = "";
      return;
    }
    errorEl.hidden = false;
    errorEl.textContent = msg;
  };

  serverSelect.addEventListener("change", async () => {
    const idx = serverSelect.value;
    if (idx === "") {
      pathField.value = "";
      onChange({ displayPath: "", data: null, source: null, name: null });
      showError(null);
      return;
    }
    const entry = entries[Number(idx)];
    if (!entry) return;
    try {
      showError(null);
      const data = await fetchFirmware(entry.url);
      const displayPath = resolveDisplayPath(entry);
      pathField.value = displayPath;
      localInput.value = "";
      onChange({ displayPath, data, source: "server", name: entry.name });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showError(message);
      pathField.value = "";
      onChange({ displayPath: "", data: null, source: null, name: null });
    }
  });

  localInput.addEventListener("change", async () => {
    const file = localInput.files?.[0];
    if (!file) return;
    if (!matchesFirmwareName(kind, file.name)) {
      showError(`Invalid file name. Expected ${firmwarePatternHint(kind)}.`);
      localInput.value = "";
      return;
    }
    try {
      showError(null);
      const data = await readLocalFirmware(file);
      // Browsers do not expose absolute filesystem paths.
      const displayPath = file.name;
      pathField.value = displayPath;
      serverSelect.value = "";
      onChange({ displayPath, data, source: "local", name: file.name });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showError(message);
      onChange({ displayPath: "", data: null, source: null, name: null });
    }
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
