import { browser, expect } from "@wdio/globals";
import { askAndWait, errorDialogText, newChatWelcome, processOneImage, useServer, waitForNotice } from "../support/chat";
import { chatModels, isRunning, LiveModel, LMSTUDIO_CHAT_ENDPOINT, LMSTUDIO_URL, loadedChatModels, loadOnly, restore, unloadAll } from "../support/lmStudio";

/**
 * Manual evals against a real LM Studio: `npm run eval:live`.
 *
 * Needs LM Studio running with its local server on (LMSTUDIO_URL, default
 * http://localhost:1234), at least one downloaded model that can use tools, and
 * "just-in-time model loading" left on in the server settings.
 *
 * The suite loads and unloads models. It puts back whatever was loaded when it
 * started. Two cases need a particular kind of model and are skipped, with a
 * note, when none is downloaded:
 *   - a chat model without tool support   (or name one in LIVE_NO_TOOLS_MODEL)
 *   - a chat model without vision         (or name one in LIVE_NO_VISION_MODEL)
 */
describe("Private AI with a real LM Studio", function () {
    this.timeout(15 * 60 * 1000);
    const LOAD_AND_ANSWER = 8 * 60 * 1000;

    let models: LiveModel[] = [];
    let loadedAtStart: string[] = [];

    /** The model named in an env var, or the smallest one matching the test. */
    function pick(envName: string, matches: (m: LiveModel) => boolean): LiveModel | undefined {
        const named = process.env[envName];
        if (named) {
            const model = models.find((m) => m.key === named);
            if (!model) throw new Error(`${envName}=${named} is not a downloaded chat model. Downloaded: ${models.map((m) => m.key).join(", ")}`);
            return model;
        }
        return models.filter(matches).sort((a, b) => a.sizeBytes - b.sizeBytes)[0];
    }

    before(async function () {
        if (!(await isRunning())) {
            throw new Error(`LM Studio is not answering at ${LMSTUDIO_URL}. Start LM Studio and its local server (Developer tab), then run this suite again.`);
        }
        models = await chatModels();
        if (models.length === 0) throw new Error("LM Studio has no chat model downloaded. Download one (for example Gemma 4 E4B) and run this suite again.");
        loadedAtStart = models.filter((m) => m.loadedInstances.length > 0).map((m) => m.key);
        console.log(`[live] LM Studio at ${LMSTUDIO_URL}: ${models.length} chat models, loaded at start: ${loadedAtStart.join(", ") || "none"}`);
        await useServer(LMSTUDIO_CHAT_ENDPOINT);
    });

    after(async function () {
        if (models.length === 0) return;
        console.log(`[live] restoring loaded models: ${loadedAtStart.join(", ") || "none"}`);
        await restore(loadedAtStart);
    });

    beforeEach(async function () {
        await useServer(LMSTUDIO_CHAT_ENDPOINT);
    });

    it("greets the user when LM Studio is running with a model downloaded", async function () {
        expect(await newChatWelcome()).toBe("What's on your mind?");
        expect(await errorDialogText()).toBe("");
    });

    it("loads a model by itself when none is loaded", async function () {
        const expected = models.filter((m) => m.toolUse !== false).sort((a, b) => a.sizeBytes - b.sizeBytes)[0];
        if (!expected) return this.skip();
        await unloadAll();
        expect((await loadedChatModels()).length).toBe(0);

        await newChatWelcome();
        const reply = await askAndWait("Reply with the single word: ready", LOAD_AND_ANSWER);
        console.log(`[live] with nothing loaded, the reply was: ${JSON.stringify(reply.slice(0, 200))}`);
        expect(reply.length).toBeGreaterThan(0);
        expect(reply).not.toContain("Can't reach LM Studio");
        expect(reply).not.toContain("Download a model first");
        expect(reply).not.toContain("can't use tools");

        // LM Studio loaded the smallest model that can use tools, and nothing else.
        const loaded = (await loadedChatModels()).map((m) => m.key);
        console.log(`[live] loaded afterwards: ${loaded.join(", ")}`);
        expect(loaded).toEqual([expected.key]);
    });

    it("uses the model that is already loaded instead of loading another", async function () {
        const candidates = models.filter((m) => m.toolUse !== false).sort((a, b) => a.sizeBytes - b.sizeBytes);
        // The second smallest, so it differs from what the plugin would pick with nothing loaded.
        const target = candidates[1] ?? candidates[0];
        if (!target) return this.skip();
        await loadOnly(target.key);

        await newChatWelcome();
        const reply = await askAndWait("Reply with the single word: ready", LOAD_AND_ANSWER);
        expect(reply.length).toBeGreaterThan(0);
        expect((await loadedChatModels()).map((m) => m.key)).toEqual([target.key]);
    });

    it("answers a question from the vault with the real model", async function () {
        const target = models.filter((m) => m.toolUse !== false).sort((a, b) => a.sizeBytes - b.sizeBytes)[0];
        if (!target) return this.skip();
        if ((await loadedChatModels()).length === 0) await loadOnly(target.key);

        await newChatWelcome();
        const reply = await askAndWait("Search my notes: on what date did I replace the water heater?", LOAD_AND_ANSWER);
        console.log(`[live] vault answer: ${JSON.stringify(reply.slice(0, 300))}`);
        expect(reply).toMatch(/2024-03-15|March 15(th)?,? 2024|15 March 2024/);
    });

    it("tells the user when the loaded model can't use tools", async function () {
        const model = pick("LIVE_NO_TOOLS_MODEL", (m) => m.toolUse === false);
        if (!model) {
            console.log("[live] SKIPPED: no downloaded chat model lacks tool support. Download one, or set LIVE_NO_TOOLS_MODEL.");
            return this.skip();
        }
        console.log(`[live] no-tools model: ${model.key}`);
        await loadOnly(model.key);

        await newChatWelcome();
        const reply = await askAndWait("When did I replace the water heater?", LOAD_AND_ANSWER);
        expect(reply).toContain("This model can't use tools");
        expect(reply).toContain(model.key);
        expect(reply).toContain("Gemma 4 E4B");
        // It was refused up front: no other model was loaded to answer instead.
        expect((await loadedChatModels()).map((m) => m.key)).toEqual([model.key]);
    });

    it("tells the user when the loaded model can't read images", async function () {
        const model = pick("LIVE_NO_VISION_MODEL", (m) => m.vision === false);
        if (!model) {
            console.log("[live] SKIPPED: every downloaded chat model has vision. Download a text-only chat model, or set LIVE_NO_VISION_MODEL.");
            return this.skip();
        }
        console.log(`[live] no-vision model: ${model.key}`);
        await loadOnly(model.key);

        await processOneImage("Attachments/live-no-vision.png");
        const notice = await waitForNotice(/can't read images/, 60000);
        expect(notice).toContain(model.key);
        expect((await loadedChatModels()).map((m) => m.key)).toEqual([model.key]);
    });

    it("reads text from an image when the loaded model has vision", async function () {
        const model = models.filter((m) => m.vision === true).sort((a, b) => a.sizeBytes - b.sizeBytes)[0];
        if (!model) return this.skip();
        await loadOnly(model.key);

        await processOneImage("Attachments/live-vision.png");
        // A 1x1 image has no text; what matters is that the model was asked and no vision warning appeared.
        const notice = await waitForNotice(/Private AI read text from \d+ image/, LOAD_AND_ANSWER);
        expect(notice).not.toContain("could not be read");
        const warned = await browser.execute(() => Array.from(document.querySelectorAll(".notice")).some((n) => /can't read images|Vision model required/.test(n.textContent ?? "")));
        expect(warned).toBe(false);
    });
});
