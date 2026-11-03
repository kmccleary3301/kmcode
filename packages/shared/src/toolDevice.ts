const TOOL_DEVICE_PATH = /^xd:\/\/([^/?#\s]+)$/u;

/** Tool name mounted at an OMP `xd://<tool>` device path. */
export function parseToolDeviceName(path: string): string | undefined {
  return TOOL_DEVICE_PATH.exec(path)?.[1];
}

/** Device arguments are JSON; while a call streams they may still be partial text. */
export function parseToolDeviceArguments(content: string | undefined): unknown {
  if (content === undefined) return {};
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return content;
  }
}
