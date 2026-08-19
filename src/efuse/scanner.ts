/**
 * Keyboard wedge barcode reader capture.
 *
 * The reader is seen by the browser as a keyboard that types the label and then
 * presses Enter. Keys are decoded from `event.code`, never from `event.key`:
 * the reader emits US layout scancodes, so on a Swiss or Italian keyboard the
 * hyphen of `T3-` would otherwise arrive as an apostrophe and the label would
 * never match.
 *
 * Capture is skipped while the focus is inside a form control, so manual edits
 * to the ID fields keep working normally.
 */

const CODE_DIGITS: Record<string, [string, string]> = {
  Digit0: ["0", ")"],
  Digit1: ["1", "!"],
  Digit2: ["2", "@"],
  Digit3: ["3", "#"],
  Digit4: ["4", "$"],
  Digit5: ["5", "%"],
  Digit6: ["6", "^"],
  Digit7: ["7", "&"],
  Digit8: ["8", "*"],
  Digit9: ["9", "("],
};

const CODE_PUNCTUATION: Record<string, [string, string]> = {
  Backquote: ["`", "~"],
  Backslash: ["\\", "|"],
  BracketLeft: ["[", "{"],
  BracketRight: ["]", "}"],
  Comma: [",", "<"],
  Equal: ["=", "+"],
  IntlBackslash: ["\\", "|"],
  Minus: ["-", "_"],
  Period: [".", ">"],
  Quote: ["'", '"'],
  Semicolon: [";", ":"],
  Slash: ["/", "?"],
  Space: [" ", " "],
};

const NUMPAD_CODES: Record<string, string> = {
  Numpad0: "0",
  Numpad1: "1",
  Numpad2: "2",
  Numpad3: "3",
  Numpad4: "4",
  Numpad5: "5",
  Numpad6: "6",
  Numpad7: "7",
  Numpad8: "8",
  Numpad9: "9",
  NumpadAdd: "+",
  NumpadDecimal: ".",
  NumpadDivide: "/",
  NumpadMultiply: "*",
  NumpadSubtract: "-",
};

/** Buffer lifetime: a reader types a whole label in a few ms, a human does not. */
const IDLE_RESET_MS = 200;

export function decodeScannerKey(event: KeyboardEvent): string | null {
  if (event.code.startsWith("Key")) {
    const letter = event.code.slice(3).toLowerCase();
    return event.shiftKey ? letter.toUpperCase() : letter;
  }

  const digit = CODE_DIGITS[event.code];
  if (digit) return digit[event.shiftKey ? 1 : 0];

  const punctuation = CODE_PUNCTUATION[event.code];
  if (punctuation) return punctuation[event.shiftKey ? 1 : 0];

  return NUMPAD_CODES[event.code] ?? null;
}

export interface BarcodeScannerOptions {
  /** Called with the trimmed barcode once Enter terminates the burst. */
  onScan: (value: string) => void;
  /** Called on every buffered character, for a live echo of the scan. */
  onPartial?: (buffer: string) => void;
}

export interface BarcodeScanner {
  enable(): void;
  disable(): void;
}

export function createBarcodeScanner(options: BarcodeScannerOptions): BarcodeScanner {
  let enabled = false;
  let buffer = "";
  let idleTimer: number | null = null;

  const resetBuffer = (): void => {
    buffer = "";
    if (idleTimer !== null) {
      window.clearTimeout(idleTimer);
      idleTimer = null;
    }
    options.onPartial?.("");
  };

  const armIdleTimer = (): void => {
    if (idleTimer !== null) window.clearTimeout(idleTimer);
    idleTimer = window.setTimeout(resetBuffer, IDLE_RESET_MS);
  };

  /** Manual typing in a field must never be swallowed by the scanner. */
  const isFormControl = (target: EventTarget | null): boolean =>
    target instanceof Element && target.closest("input, textarea, select") !== null;

  const onKeyDown = (event: KeyboardEvent): void => {
    if (!enabled || event.ctrlKey || event.metaKey || event.altKey) return;
    if (isFormControl(event.target)) return;

    if (event.code === "Enter" || event.code === "NumpadEnter") {
      const scan = buffer.trim();
      resetBuffer();
      if (scan.length === 0) return; // Let Enter reach a focused button.
      event.preventDefault();
      options.onScan(scan);
      return;
    }

    if (event.code === "Backspace") {
      buffer = buffer.slice(0, -1);
      armIdleTimer();
      options.onPartial?.(buffer);
      event.preventDefault();
      return;
    }

    const character = decodeScannerKey(event);
    if (character === null) return;

    buffer += character;
    armIdleTimer();
    options.onPartial?.(buffer);
    event.preventDefault();
  };

  window.addEventListener("keydown", onKeyDown);

  return {
    enable(): void {
      enabled = true;
    },
    disable(): void {
      enabled = false;
      resetBuffer();
    },
  };
}
