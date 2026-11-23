import { browser } from "@wdio/globals";
import * as path from "node:path";
import { startFake, toolResults, question, type FakeServer } from "./fakeServer";
import * as k from "./kit";

const OUT = path.resolve(__dirname, "..", "..", "demo-out");

function reply(body: any) {
    const q = question(body).trim();
    const results = toolResults(body);
    if (/open task/i.test(q)) return { text: `Received your template text: "${q}" (scripted reply).` };
    if (/Summarize this note/i.test(q)) return { text: `Received: "${q}" (scripted reply).` };
    if (results.length === 0) return { toolCalls: [{ name: "search_notes", args: { query: "water heater replaced" } }] };
    return { text: "You replaced the water heater on **2024-03-15**." };
}

const menuNames = (): Promise<string[]> => browser.execute(
    (chat) => [...document.querySelectorAll(`${chat} .local-llm-template-menu-visible .local-llm-template-name`)].map((e) => e.textContent ?? ""), k.CHAT);

async function keys(text: string): Promise<void> {
    for (const ch of text) { await browser.keys(ch); await browser.pause(180); }
}

describe("PR 65 demo: / prompt templates", function () {
    let llm: FakeServer;

    before(async function () {
        llm = await startFake(reply, { delayMs: 80 });
        await k.setupWindow();
        await k.setSettings({
            apiEndpoint: llm.url, model: "mock-model", contextNotesVisible: true,
            promptTemplates: [{ name: "summarize", prompt: "Summarize this note in five bullet points." }],
        });
        await browser.executeObsidian(async ({ app }) => {
            await app.workspace.getLeaf(false).openFile(app.vault.getAbstractFileByPath("Home/Garden Planting Calendar.md") as any);
        });
        await k.openChat();
        await k.startRecording(OUT, "pr65-prompt-templates");
    });

    after(async function () {
        await k.stopRecording();
        await llm?.close();
    });

    it("records", async function () {
        await k.caption("PR #65: save prompts as templates and pick them by typing / in the chat box", 2600);
        await k.caption("Settings, then Private AI: the new Prompt templates section. Click Add template");
        await k.openPluginSettings();
        const add = browser.$("//button[normalize-space()='Add template']");
        await k.click(add, 1000);
        const names = await browser.$$(".local-llm-template-setting input[type=text]");
        const prompts = await browser.$$(".local-llm-template-setting textarea");
        await k.caption("Give it a name and the prompt text");
        await k.typeInto(names[names.length - 1], "tasks");
        await k.typeInto(prompts[prompts.length - 1], "List every open task in my notes.");
        await browser.pause(800);
        await k.closeSettings();

        await k.caption("Type / in the chat box: your templates pop up");
        await k.click(k.chatInput(), 300);
        await keys("/");
        await browser.waitUntil(async () => (await menuNames()).length === 2, { timeout: 5000, timeoutMsg: "the / menu never opened" });
        await browser.pause(1500);
        await k.caption("Keep typing to narrow the list, then press Enter");
        await keys("ta");
        await browser.waitUntil(async () => (await menuNames()).length === 1, { timeout: 5000 });
        await browser.pause(1000);
        await browser.keys("Enter");
        await k.caption("Enter fills in the text without sending, so you can edit it first");
        if ((await k.chatInput().getValue()) !== "List every open task in my notes.") throw new Error("template text not filled in");
        const sentBefore = llm.requests.length;
        await k.typeInto(k.chatInput(), "");
        await browser.keys("End");
        await keys(" Group by folder.");
        await browser.pause(800);
        if (llm.requests.length !== sentBefore) throw new Error("the template was sent too early");
        await k.caption("Press Enter again (or click Send) to send it");
        await browser.keys("Enter");
        await k.turnOver();
        await browser.pause(1500);

        await k.caption("Templates can also be picked with the mouse");
        await k.click(k.chatInput(), 300);
        await keys("/");
        await browser.waitUntil(async () => (await menuNames()).length === 2, { timeout: 5000 });
        await browser.pause(600);
        const item = browser.$(`//*[contains(@class,'local-llm-template-name')][normalize-space()='/summarize']`);
        await k.click(item, 1200);
        await k.click(k.sendButton(), 200);
        await k.turnOver();

        await k.caption("Normal questions work as before");
        await k.ask("When did I replace the water heater?");
        await browser.pause(1500);
        await k.caption("Done: add a template in settings, pick it with / (keyboard or mouse), edit, send", 3000);
    });
});
