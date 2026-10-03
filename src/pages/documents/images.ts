import { MEDIA_FILE, STORED_FILE } from "../../services/utils";
import { fileToDataUrl } from "../../ui/Photos";

// The pictures on storyboard frames and shot list rows. Every picture is shrunk to a 1280-pixel long edge first. On the
// hosted site the server files it and the frame keeps only its address (/api/file?id=…), as with equipment photos. In
// the desktop app it is written to a media folder in the app's own data folder on that computer, one folder per
// project, and the frame keeps only its path (media:<project>/<file>.jpg). The browser demo, with neither, keeps the
// shrunk picture itself.

const LONG_EDGE = 1280;
const QUALITY = 0.82;

interface DesktopMedia {
  root: string; // the app's data folder
  sep: string;
  toSrc: (absolutePath: string) => string;
  write: (relativePath: string, folder: string, bytes: Uint8Array) => Promise<void>;
}
let desktop: DesktopMedia | null = null;

/** In the desktop app, on its own (no server): pictures go to its media folder from now on. */
export async function enableDesktopMedia(): Promise<void> {
  try {
    const [{ convertFileSrc }, path, fs] = await Promise.all([
      import("@tauri-apps/api/core"),
      import("@tauri-apps/api/path"),
      import("@tauri-apps/plugin-fs"),
    ]);
    desktop = {
      root: (await path.appDataDir()).replace(/[\\/]+$/, ""),
      sep: path.sep(),
      toSrc: convertFileSrc,
      write: async (relativePath, folder, bytes) => {
        await fs.mkdir(folder, { baseDir: fs.BaseDirectory.AppData, recursive: true });
        await fs.writeFile(relativePath, bytes, { baseDir: fs.BaseDirectory.AppData });
      },
    };
  } catch (e) {
    console.warn("Pictures will be kept in the app's own storage: the media folder could not be opened.", e);
    desktop = null;
  }
}

function bytesOf(dataUrl: string): Uint8Array {
  const raw = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9-]/g, "");

/** Shrinks a picture and stores it where this copy of the app keeps pictures. Returns what a frame or row keeps. */
export async function storeImage(file: File, projectId: string): Promise<string> {
  const shrunk = await fileToDataUrl(file, LONG_EDGE, QUALITY);
  if (!desktop) return shrunk;
  const folder = `media/${safe(projectId)}`;
  const name = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.jpg`;
  await desktop.write(`${folder}/${name}`, folder, bytesOf(shrunk));
  return `media:${safe(projectId)}/${name}`;
}

/** Where to show a stored picture from, or null if there is none (or it cannot be shown here). */
export function imageSrc(path: string | null): string | null {
  if (!path) return null;
  if (STORED_FILE.test(path) || path.startsWith("data:image/")) return path;
  if (MEDIA_FILE.test(path)) {
    if (!desktop) return null; // a picture kept on a desktop computer, opened somewhere else
    const rel = path.slice("media:".length).split("/");
    return desktop.toSrc([desktop.root, "media", ...rel].join(desktop.sep));
  }
  return null;
}
