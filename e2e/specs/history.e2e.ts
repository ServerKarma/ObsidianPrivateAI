import { browser, expect } from "@wdio/globals";
import { FakeLmStudio, lastUserText, startFakeLmStudio } from "../support/fakeLmStudio";

/** Saved chats: the History button lists them and reopens one with its messages, in real Obsidian. */
describe("Private AI chat history", function () {
    let llm: FakeLmStudio;
    const view = '[data-type="local-llm-chat-view"]';
    const question = "Remember the history-eval-marker please";

    before(async function () {
        llm = await startFakeLmStudio((body) => {
            const asked = (lastUserText(body).split("User question: ").pop() ?? "").trim();
            // The second turn of a reopened chat must still see the first question.
            const all = JSON.stringify(body.messages ?? []);
            if (/what did I ask/i.test(asked)) return { text: all.includes("history-eval-marker") ? "You asked about history-eval-marker." : "I don't know." };
            return { text: `Noted: ${asked}` };
        });
        await browser.executeObsidian(async ({ app }, url) => {
            const plugin = (app as any).plugins.plugins["private-ai"];
            Object.assign(plugin.settings, { apiEndpoint: url, model: "mock-model", saveChatHistory: true });
            await plugin.saveSettings();
        }, llm.url);
        await browser.executeObsidianCommand("private-ai:open-local-llm-chat");
        await browser.$(`${view} textarea.local-llm-input`).waitForExist({ timeout: 10000 });
    });

    after(async function () {
        await llm?.close();
    });

    const lastAssistantText = (): Promise<string> =>
        browser.execute((sel) => {
            const all = document.querySelectorAll(`${sel} .local-llm-message-assistant .local-llm-message-content`);
            return (all[all.length - 1]?.textContent ?? "").trim();
        }, view);

    async function ask(text: string, expected: string): Promise<void> {
        await browser.$(`${view} textarea.local-llm-input`).setValue(text);
        await browser.$(`${view} .local-llm-send-button`).click();
        await browser.waitUntil(async () => (await lastAssistantText()).includes(expected), {
            timeout: 20000,
            timeoutMsg: `no reply containing "${expected}"`,
        }).catch(async (e) => {
            throw new Error(`${e.message}. Last reply: "${await lastAssistantText()}"`);
        });
    }

    it("saves a chat in the plugin folder, not as a note", async function () {
        await ask(question, "Noted:");
        const where = await browser.executeObsidian(async ({ app }) => {
            const plugin = (app as any).plugins.plugins["private-ai"];
            await new Promise((r) => setTimeout(r, 300));
            const chats = await plugin.chatHistory.list();
            return {
                titles: chats.map((c: any) => c.title),
                notesNamedLikeChats: app.vault.getMarkdownFiles().filter((f: any) => f.path.includes("chats/")).length,
                folder: `${plugin.manifest.dir}/chats`,
                folderExists: await app.vault.adapter.exists(`${plugin.manifest.dir}/chats`),
            };
        });
        expect(where.titles).toContain(question);
        expect(where.folderExists).toBe(true);
        expect(where.notesNamedLikeChats).toBe(0);
    });

    it("reopens the chat from History after New chat, and the agent remembers it", async function () {
        await browser.$(`${view} .local-llm-new-chat-button`).click();
        await browser.waitUntil(async () => (await browser.$$(`${view} .local-llm-message-user`).length) === 0, { timeout: 5000 });

        await browser.$(`${view} .local-llm-history-button`).click();
        // The saved chat's row, found by its title (the first question).
        const openButton = async () =>
            (await browser.$$(`${view} .local-llm-history-item .local-llm-history-open`).filter(async (b) => (await b.getText()).includes(question)))[0];
        await browser.waitUntil(async () => !!(await openButton()), { timeout: 5000, timeoutMsg: "the saved chat is not in History" });
        await (await openButton()).click();

        await browser.waitUntil(
            async () => (await browser.execute((sel) => document.querySelector(`${sel} .local-llm-messages`)?.textContent ?? "", view)).includes(question),
            { timeout: 5000, timeoutMsg: "the saved messages were not shown" },
        );
        await ask("What did I ask before?", "You asked about history-eval-marker.");
    });
});
