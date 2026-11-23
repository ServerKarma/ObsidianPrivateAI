import { browser } from "@wdio/globals";
import * as path from "node:path";
import { startFake, toolResults, question, type FakeServer } from "./fakeServer";
import * as k from "./kit";

const OUT = path.resolve(__dirname, "..", "..", "demo-out");

/**
 * The model's turns are scripted, but the tool results it reads are the real plugin's
 * (list_tags / list_notes run against the demo vault), and the final answer is built
 * from those results, so it only names notes the tag filter really returned.
 */
function reply(body: any) {
    const q = question(body);
    const results = toolResults(body);
    if (/#meeting/i.test(q)) {
        if (results.length === 0) return { toolCalls: [{ name: "list_tags", args: {} }] };
        if (results.length === 1) return { toolCalls: [{ name: "list_notes", args: { tags: "#meeting" } }] };
        if (results.length === 2) return { toolCalls: [{ name: "search_notes", args: { query: "decided owner deadline", tags: "meeting" } }] };
        const listed = [...results[1].matchAll(/^(.+?\.md) {2}\(modified /gm)].map((m) => m[1]);
        return { text: `You have ${listed.length} notes tagged #meeting: ${listed.map((p) => `**${p}**`).join(" and ")}. In Q3 planning you decided to migrate billing to Postgres (owner Priya, due 2024-09-30), retire the legacy reporting dashboard and hire two backend engineers.` };
    }
    if (results.length === 0) return { toolCalls: [{ name: "search_notes", args: { query: "water heater replaced" } }] };
    if (results.length === 1) return { toolCalls: [{ name: "read_note", args: { path: "Home/Water Heater Replacement.md" } }] };
    return { text: "You replaced the water heater on **2024-03-15**; it cost $1,850 installed." };
}

async function showThinking(): Promise<void> {
    const buttons = await browser.$$(`${k.CHAT} .local-llm-message-assistant button`);
    for (const b of [...buttons].reverse()) {
        if ((await b.getText()).trim() === "Show") { await k.click(b, 1500); return; }
    }
}

describe("PR 64 demo: find notes by tag", function () {
    let llm: FakeServer;

    before(async function () {
        llm = await startFake(reply, { delayMs: 80 });
        await k.setupWindow();
        await k.setSettings({ apiEndpoint: llm.url, model: "mock-model", contextNotesVisible: true });
        await browser.executeObsidian(async ({ app }) => {
            await app.workspace.getLeaf(false).openFile(app.vault.getAbstractFileByPath("Work/Q3 Planning Meeting.md") as any);
        });
        await k.openChat();
        await k.startRecording(OUT, "pr64-tag-filters");
    });

    after(async function () {
        await k.stopRecording();
        await llm?.close();
    });

    it("records", async function () {
        await k.caption("PR #64: the agent can now limit its search to notes with a tag", 2600);
        await k.caption("Ask about your #meeting notes. The model's words are scripted; the tag tools run for real on this vault");
        await k.ask("What did we decide in my #meeting notes?");
        await k.caption("Open the thought process: it listed the tags, then only the notes tagged #meeting");
        await showThinking();
        await k.readThinking(5000);
        await browser.pause(1000);
        const answer = await k.lastAnswer();
        if (!/Q3 Planning Meeting/.test(answer) || !/One on One with Marcus/.test(answer)) throw new Error(`tag filter answer was ${answer}`);

        await k.caption("Questions without a tag still search the whole vault as before");
        await k.click(browser.$(`${k.CHAT} .local-llm-new-chat-button`), 800);
        await k.ask("When did I replace the water heater?");
        await browser.pause(2500);
        await k.caption("Done: tag-filtered search, plus normal search unchanged", 2500);
    });
});
