import { config as base } from "./wdio.conf.mts";

/**
 * Manual evals that need a real LM Studio running: `npm run eval:live`.
 * They load and unload models, so they are slow and are not part of `npm run eval`.
 * The stubbed server-state evals run here too, so one command covers every case.
 */
export const config: WebdriverIO.Config = {
    ...base,
    specs: ["./live/**/*.live.ts", "./specs/server-states.e2e.ts"],
    mochaOpts: {
        ui: "bdd",
        timeout: 15 * 60 * 1000,
    },
};
