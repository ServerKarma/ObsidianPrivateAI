import * as path from "path";
import { fileURLToPath } from "url";
import { config as base } from "./wdio.conf.mts";

const e2eDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Captures the README screenshots and GIF from the real plugin in real Obsidian,
 * using the demo notes in e2e/vault and a scripted model (no LM Studio needed).
 * Run on Linux with: xvfb-run -a -s "-screen 0 1280x800x24" npm run screenshots
 */
export const config: WebdriverIO.Config = {
    ...base,
    specs: [path.join(e2eDir, "readme", "*.capture.ts")],
    mochaOpts: { ...base.mochaOpts, timeout: 300000 },
};
