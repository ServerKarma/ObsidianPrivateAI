import { browser } from "@wdio/globals";
import * as path from "node:path";
import { startFake, toolResults, question, type FakeServer } from "./fakeServer";
import * as k from "./kit";

const OUT = path.resolve(__dirname, "..", "..", "demo-out");

/** Scripted words; the "what did I ask" answer is built from the history the plugin really sent. */
function reply(body: any) {
    const q = question(body);
    const results = toolResults(body);
    if (/what did I ask/i.test(q)) {
        const all = JSON.stringify(body.messages ?? []);
        return { text: all.includes("water heater") ? "Earlier in this chat you asked **when you replaced the water heater** (2024-03-15)." : "I don't see an earlier question in this chat." };
    }
    if (/water heater/i.test(q)) {
        if (results.length === 0) return { toolCalls: [{ name: "search_notes", args: { query: "water heater replaced" } }] };
        return { text: "You replaced the water heater on **2024-03-15**; it cost $1,850." };
    }
    if (/sourdough/i.test(q)) {
        if (results.length === 0) return { toolCalls: [{ name: "search_notes", args: { query: "sourdough hydration" } }] };
        return { text: "Your sourdough recipe uses **75% hydration**." };
    }
    return { text: "OK." };
}

const historyRows = () => browser.$$(`${k.CHAT} .local-llm-history-item`);

describe("PR 66 demo: chat history", function () {
    let llm: FakeServer;

    before(async function () {
        llm = await startFake(reply, { delayMs: 80 });
        await k.setupWindow();
        await k.setSettings({ apiEndpoint: llm.url, model: "mock-model", contextNotesVisible: true, saveChatHistory: true });
        await browser.executeObsidian(async ({ app }) => {
            const plugin = (app as any).plugins.plugins["private-ai"];
            await plugin.chatHistory?.clear?.();
            await app.workspace.getLeaf(false).openFile(app.vault.getAbstractFileByPath("Home/Water Heater Replacement.md") as any);
        });
        await k.openChat();
        await k.startRecording(OUT, "pr66-chat-history");
    });

    after(async function () {
        await k.stopRecording();
        await llm?.close();
    });

    it("records", async function () {
        await k.caption("PR #66: chats are saved, and a History button reopens them", 2600);
        await k.caption("Ask a question as usual. The chat is saved after the answer");
        await k.ask("When did I replace the water heater?");
        await browser.pause(1000);

        await k.caption("New chat starts a separate saved chat");
        await k.click(browser.$(`${k.CHAT} .local-llm-new-chat-button`), 800);
        await k.ask("What hydration is my sourdough?");
        await browser.pause(1000);

        await k.caption("Click History: every saved chat, newest first, with date and message count");
        await k.click(browser.$(`${k.CHAT} .local-llm-history-button`), 2500);
        if ((await historyRows()).length !== 2) throw new Error("expected 2 saved chats");

        await k.caption("Open the earlier chat: its messages come back");
        const open = (await browser.$$(`${k.CHAT} .local-llm-history-open`).filter(async (b) => (await b.getText()).includes("water heater")))[0];
        await k.click(open, 2000);

        await k.caption("Keep going: the agent still remembers what was asked earlier in that chat");
        await k.ask("What did I ask earlier?");
        if (!/water heater/.test(await k.lastAnswer())) throw new Error("reopened chat lost its history");
        await browser.pause(1500);

        await k.caption("Delete a chat from the list with its trash button");
        await k.click(browser.$(`${k.CHAT} .local-llm-history-button`), 1500);
        const del = (await browser.$$(`${k.CHAT} .local-llm-history-item`).filter(async (r) => (await r.getText()).includes("sourdough")))[0].$(".local-llm-history-delete");
        await k.click(del, 1800);
        if ((await historyRows()).length !== 1) throw new Error("delete did not remove the chat");
        await k.click(browser.$(`${k.CHAT} .local-llm-history-back`), 1200);

        await k.caption("Settings, then Private AI: Chat history can be turned off or cleared");
        await k.openPluginSettings();
        await k.pointAt(await k.settingControl("Save chats", ".checkbox-container"));
        await browser.pause(1500);
        await k.pointAt(await k.settingControl("Delete saved chats", "button"));
        await browser.pause(1500);
        await k.closeSettings();
        await k.caption("Done: save, list, reopen and continue, delete; chatting works as before", 3000);
    });
});
