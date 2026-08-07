/// <reference types="vite/client" />

/** Short git commit hash injected at build/dev time. */
declare const __APP_COMMIT__: string;

/** Commit date (YYYY-MM-DD) injected at build/dev time. */
declare const __APP_COMMIT_DATE__: string;

interface File {
  /** Non-standard absolute path (Electron / some Chromium hosts). */
  path?: string;
}

interface OpenFilePickerOptions {
  multiple?: boolean;
  excludeAcceptAllOption?: boolean;
  types?: Array<{
    description?: string;
    accept: Record<string, string[]>;
  }>;
}

interface Window {
  showOpenFilePicker?: (
    options?: OpenFilePickerOptions,
  ) => Promise<FileSystemFileHandle[]>;
}
