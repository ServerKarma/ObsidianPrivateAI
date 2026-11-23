import { browser } from "@wdio/globals";
import * as path from "node:path";
import { startFake, toolResults, question, type FakeServer } from "./fakeServer";
import * as k from "./kit";

const OUT = path.resolve(__dirname, "..", "..", "demo-out");

function answers(server: string) {
    return (body: any) => {
        const q = question(body);
        const results = toolResults(body);
        if (/cost/i.test(q)) return { text: `It cost **$1,850** installed, by Mike's Plumbing. (Answered through ${server}.)` };
        if (results.length === 0) return { toolCalls: [{ name: "grep_notes", args: { pattern: "water heater" } }] };
        if (results.length === 1) return { toolCalls: [{ name: "read_note", args: { path: "Home/Water Heater Replacement.md" } }] };
        return { text: `You replaced the water heater on **2024-03-15** with a Rheem 50 gallon tank. (Answered through ${server}.)` };
    };
}

describe("PR 76 demo: pick a local server", function () {
    let lmstudio: FakeServer;
    let ollama: FakeServer;

    before(async function () {
        lmstudio = await startFake(answers("LM Studio"), { kind: "lmstudio", port: 1234, delayMs: 80 });
        ollama = await startFake(answers("Ollama"), {
            kind: "ollama", port: 11434, delayMs: 80, ollamaModels: [
                { name: "gemma4:e2b", size: 5_000, capabilities: ["completion", "tools", "vision"] },
                { name: "qwen3:8b", size: 7_000, capabilities: ["completion", "tools"] },
                { name: "nomic-embed-text:latest", size: 100, capabilities: ["embedding"] },
            ],
        });
        await k.setupWindow();
        await k.setSettings({ serverType: "lmstudio", apiEndpoint: "http://localhost:1234/v1/chat/completions", model: undefined, contextNotesVisible: true });
        await browser.executeObsidian(async ({ app }) => {
            await app.workspace.getLeaf(false).openFile(app.vault.getAbstractFileByPath("Home/Water Heater Replacement.md") as any);
        });
        await k.openChat();
        await k.startRecording(OUT, "pr76-local-servers");
    });

    after(async function () {
        await k.stopRecording();
        await lmstudio?.close();
        await ollama?.close();
    });

    it("records", async function () {
        await k.caption("PR #76: Private AI can now use Ollama, llama.cpp or Jan, not only LM Studio", 2600);
        await k.caption("Open Settings, then Private AI. The new \"Local server\" setting is at the top");
        await k.openPluginSettings();
        await k.pointAt(k.settingControl("Local server"));
        await browser.pause(800);

        await k.caption("Pick Ollama: the endpoint switches to Ollama's usual address (port 11434)");
        await k.pick("Local server", "Ollama");
        await k.pointAt(k.settingControl("API endpoint", "input"));
        await browser.pause(1500);

        await k.caption("The Model list now comes from Ollama (embedding models are left out)");
        await browser.waitUntil(async () => (await (await k.settingControl("Model")).$$("option")).length >= 3, { timeout: 10000 });
        await k.pick("Model", "gemma4:e2b");
        await browser.pause(1000);
        await k.closeSettings();

        await k.caption("Ask a question: the agent searches the vault and answers through Ollama");
        ollama.load("gemma4:e2b", 32768);
        await k.click(browser.$(`${k.CHAT} .local-llm-new-chat-button`), 800);
        await k.ask("When did I replace the water heater?");
        await browser.pause(2000);

        await k.caption("If Ollama loaded the model with a small (4k) context, a notice says how to raise it");
        ollama.load("gemma4:e2b", 4096);
        await k.ask("And what did it cost?");
        await browser.waitUntil(async () => browser.execute(() => !!document.querySelector(".notice")), { timeout: 15000 });
        await browser.pause(3500);

        await k.caption("Switch back to LM Studio: the chat works exactly as before");
        await k.openPluginSettings();
        await k.pick("Local server", "LM Studio");
        await k.pointAt(k.settingControl("API endpoint", "input"));
        await browser.pause(1200);
        await k.closeSettings();
        await k.click(browser.$(`${k.CHAT} .local-llm-new-chat-button`), 800);
        await k.ask("When did I replace the water heater?");
        await browser.pause(1500);
        await k.caption("Done: server picker, Ollama models, small-context notice, and LM Studio unchanged", 3000);
        if (!(await k.lastAnswer()).includes("LM Studio")) throw new Error("the last answer did not come from LM Studio");
        if (ollama.requests.length < 3) throw new Error("Ollama got too few requests");
    });
});
