// Saving a file for the person. In the desktop app, and when Tauri's dialog and file plugins are
// installed, this opens a normal save dialog. Otherwise it hands the file to the web view to download.

export interface Saved { how: "saved" | "started"; where: string }

interface TauriGlobal {
  dialog?: { save: (o: { defaultPath?: string; filters?: { name: string; extensions: string[] }[] }) => Promise<string | null> };
  fs?: { writeFile: (path: string, data: Uint8Array) => Promise<void> };
}

export const MIME: Record<string, string> = { pdf: "application/pdf", ics: "text/calendar", txt: "text/plain" };

export async function saveFile(filename: string, data: Uint8Array | string): Promise<Saved | null> {
  const ext = filename.split(".").pop() ?? "";
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const tauri = (globalThis as { __TAURI__?: TauriGlobal }).__TAURI__;
  if (tauri?.dialog?.save && tauri?.fs?.writeFile) {
    const path = await tauri.dialog.save({ defaultPath: filename, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
    if (!path) return null; // the person cancelled
    await tauri.fs.writeFile(path, bytes);
    return { how: "saved", where: path };
  }
  const blob = new Blob([bytes as BlobPart], { type: MIME[ext] ?? "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return { how: "started", where: filename };
}
