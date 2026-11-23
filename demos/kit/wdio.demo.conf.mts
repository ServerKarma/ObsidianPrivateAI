import * as path from "path";
import { fileURLToPath } from "url";
import { config as base } from "../wdio.conf.mts";

const demoDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Records a short demo of a change in the real plugin in real Obsidian.
 *   DEMO=pr76 xvfb-run -a -s "-screen 0 1280x800x24" npx wdio run e2e/demo/wdio.demo.conf.mts
 */
export const config: WebdriverIO.Config = {
    ...base,
    specs: [path.join(demoDir, `${process.env.DEMO ?? "*"}.capture.ts`)],
    mochaOpts: { ...base.mochaOpts, timeout: 600000 },
};
