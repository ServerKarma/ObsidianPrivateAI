import { browser, expect } from "@wdio/globals";
import { FakeLmStudio, lastUserText, startFakeLmStudio } from "../support/fakeLmStudio";

/** The "/" prompt template menu of the chat box, in real Obsidian. */
describe("Private AI prompt templates", function () {
    let llm: FakeLmStudio;
    const view = '[data-type="local-llm-chat-view"]';

    before(async function () {
        llm = await startFakeLmStudio((body) => ({ text: `You said: ${(lastUserText(body).split("User question: ").pop() ?? "").trim()}` }));
        await browser.executeObsidian(async ({ app }, url) => {
            const plugin = (app as any).plugins.plugins["private-ai"];
            Object.assign(plugin.settings, {
                apiEndpoint: url,
                model: "mock-model",
                promptTemplates: [
                    { name: "greet", prompt: "Say hello to my vault." },
                    { name: "todo", prompt: "List every open task in my notes." },
                ],
            });
            await plugin.saveSettings();
        }, llm.url);
        await browser.executeObsidianCommand("private-ai:open-local-llm-chat");
        await browser.$(`${view} textarea.local-llm-input`).waitForExist({ timeout: 10000 });
    });

    after(async function () {
        await llm?.close();
    });

    const menuNames = (): Promise<string[]> =>
        browser.execute(
            (sel) => [...document.querySelectorAll(`${sel} .local-llm-template-menu-visible .local-llm-template-name`)].map((e) => e.textContent ?? ""),
            view,
        );

    const lastAssistantText = (): Promise<string> =>
        browser.execute((sel) => {
            const all = document.querySelectorAll(`${sel} .local-llm-message-assistant .local-llm-message-content`);
            return (all[all.length - 1]?.textContent ?? "").trim();
        }, view);

    it("lists templates when you type / and narrows them as you type", async function () {
        const input = browser.$(`${view} textarea.local-llm-input`);
        await input.click();
        await browser.keys("/");
        await browser.waitUntil(async () => (await menuNames()).length === 2, { timeout: 5000, timeoutMsg: "the / menu never opened" });
        expect(await menuNames()).toEqual(["/greet", "/todo"]);
        await browser.keys(["t", "o"]);
        await browser.waitUntil(async () => (await menuNames()).length === 1, { timeout: 5000 });
        expect(await menuNames()).toEqual(["/todo"]);
        await browser.keys("Escape");
        expect(await menuNames()).toEqual([]);
        await input.clearValue();
    });

    it("puts the picked template in the box on Enter, and sends it on the next Enter", async function () {
        const input = browser.$(`${view} textarea.local-llm-input`);
        await input.clearValue();
        await input.click();
        await browser.keys(["/", "g"]);
        await browser.waitUntil(async () => (await menuNames()).length === 1, { timeout: 5000 });
        const requestsBefore = llm.requests.length;
        await browser.keys("Enter");
        expect(await input.getValue()).toBe("Say hello to my vault.");
        expect(llm.requests.length).toBe(requestsBefore);

        await browser.keys("Enter");
        await browser.waitUntil(async () => (await lastAssistantText()).includes("You said: Say hello to my vault."), {
            timeout: 20000,
            timeoutMsg: "the template text was never sent to the model",
        }).catch(async (e) => {
            throw new Error(`${e.message}. Last reply: "${await lastAssistantText()}"`);
        });
    });

    it("adds a template in the Prompt templates window, and the / menu offers it", async function () {
        await browser.executeObsidianCommand("private-ai:manage-prompt-templates");
        const modal = browser.$(".local-llm-templates-modal");
        await modal.waitForExist({ timeout: 5000 });
        const listed = (): Promise<string[]> =>
            browser.execute(() => [...document.querySelectorAll(".local-llm-templates-item-name")].map((e) => e.textContent ?? ""));
        expect(await listed()).toEqual(["/greet", "/todo"]);

        await browser.$(".local-llm-templates-add").click();
        const name = browser.$(".local-llm-templates-name");
        await name.setValue("weekly review");
        await browser.$(".local-llm-templates-prompt").setValue("Summarize what I wrote this week.");
        expect(await name.getValue()).toBe("weekly-review");
        expect(await listed()).toEqual(["/greet", "/todo", "/weekly-review"]);
        await browser.keys("Escape");
        await modal.waitForExist({ reverse: true, timeout: 5000 });

        const saved = await browser.executeObsidian(({ app }) =>
            (app as any).plugins.plugins["private-ai"].settings.promptTemplates.map((t: { name: string }) => t.name));
        expect(saved).toEqual(["greet", "todo", "weekly-review"]);

        const input = browser.$(`${view} textarea.local-llm-input`);
        await input.clearValue();
        await input.click();
        await browser.keys(["/", "w"]);
        await browser.waitUntil(async () => (await menuNames()).length === 1, { timeout: 5000 });
        expect(await menuNames()).toEqual(["/weekly-review"]);
        await browser.keys("Enter");
        expect(await input.getValue()).toBe("Summarize what I wrote this week.");
        await input.clearValue();
    });
});
