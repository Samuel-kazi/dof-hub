import { JSDOM } from "jsdom";
import { setHtmlWindow } from "../src/services/html";

// The server has no document of its own to clean rich text with (src/services/html.ts), so it makes one, once,
// when it starts. Importing this file is enough.
setHtmlWindow(new JSDOM("").window as unknown as Parameters<typeof setHtmlWindow>[0]);
