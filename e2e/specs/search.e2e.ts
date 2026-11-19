import { browser, expect } from "@wdio/globals";
import { FakeLmStudio, lastUserText, startFakeLmStudio, toolResults } from "../support/fakeLmStudio";

/**
 * Retrieval evals in real Obsidian over the whole fixture vault (about fifty
 * notes across eight folders, with look-alike notes on purpose): BM25 search
 * must rank the right note first, and grep must return exactly the right notes.
 */
describe("Private AI search over a larger vault", function () {
    /** Runs one of the plugin's vault tools the way the agent does and returns its text result. */
    async function runTool(name: string, args: Record<string, unknown>): Promise<string> {
        return browser.executeObsidian(async ({ app }, toolName, toolArgs) => {
            const plugin = (app as any).plugins.plugins["private-ai"];
            const tool = plugin.agentRuntime.tools.find((t: any) => t.name === toolName);
            if (!tool) throw new Error(`no such tool: ${toolName}`);
            return String(await tool.run(toolArgs));
        }, name, args);
    }

    /** Paths from a search_notes result, best first. */
    const rankedPaths = (result: string): string[] =>
        [...result.matchAll(/^\d+\. (.+?\.md) \(score /gm)].map((m) => m[1]);

    /** Distinct paths from a grep_notes result, sorted. */
    const grepPaths = (result: string): string[] =>
        [...new Set([...result.matchAll(/^(.+?\.md):\d+: /gm)].map((m) => m[1]))].sort();

    it("indexes the whole fixture vault", async function () {
        const counts = await browser.executeObsidian(async ({ app }) => {
            const search = (app as any).plugins.plugins["private-ai"].agentRuntime.search;
            await search.refresh();
            const notes: Array<{ path: string }> = search.notes();
            return { notes: notes.length, indexed: search.indexedCount, folders: new Set(notes.map((n) => n.path.split("/")[0])).size };
        });
        expect(counts.notes).toBeGreaterThanOrEqual(45);
        expect(counts.indexed).toBe(counts.notes);
        expect(counts.folders).toBeGreaterThanOrEqual(8);
    });

    describe("search_notes (BM25) ranks the right note first", function () {
        const cases: Array<{ query: string; expected: string; folder?: string; why?: string }> = [
            { query: "when did I replace the water heater", expected: "Home/Water Heater Replacement.md" },
            { query: "what size is the furnace filter", expected: "Home/Furnace Filter Schedule.md", why: "the Civic log also has a filter" },
            { query: "how much did the new tires cost", expected: "Cars/Subaru Outback Tires.md", why: "the Civic log also mentions tires" },
            { query: "car insurance deductible", expected: "Cars/Car Insurance.md", why: "the home policy also has a deductible" },
            { query: "homeowners policy burst pipes", expected: "Home/Home Insurance Policy.md", why: "the car policy is also a policy" },
            { query: "mortgage interest rate", expected: "Finance/Mortgage Refinance.md", why: "the tax return and rate limiting notes share words" },
            { query: "replacing brake pads", expected: "Cars/Brake Job Notes.md", why: "stemming: replacing/replaced" },
            { query: "roof shingles", expected: "Home/Roof Inspection.md" },
            { query: "am I allergic to penicillin", expected: "Health/Allergy Medications.md" },
            { query: "knee exercises", expected: "Health/Physical Therapy Exercises.md", why: "the running plan also mentions a knee" },
            { query: "half marathon training", expected: "Health/Running Training Plan.md" },
            { query: "TLS certificate outage", expected: "Work/Incident Postmortem - Checkout Outage.md" },
            { query: "requests per minute limit", expected: "Work/API Rate Limiting Design.md" },
            { query: "sourdough hydration", expected: "Recipes/Sourdough Bread.md" },
            { query: "apple pie baking temperature", expected: "Recipes/Grandma's Apple Pie.md", why: "pancakes have baking soda" },
            { query: "cold brew ratio", expected: "Recipes/Cold Brew Coffee.md" },
            { query: "Kyoto ryokan", expected: "Travel/Japan Trip Itinerary.md" },
            { query: "when does my passport expire", expected: "Travel/Passport Renewal.md", why: "the Japan itinerary also mentions a passport" },
            { query: "frequent flyer number for Delta", expected: "Travel/Frequent Flyer Numbers.md" },
            { query: "planting garlic", expected: "Home/Garden Planting Calendar.md", why: "tikka masala has garlic" },
            { query: "filter replaced", folder: "Cars", expected: "Cars/Honda Civic Maintenance Log.md", why: "the folder keeps the furnace note out" },
        ];

        for (const c of cases) {
            it(`"${c.query}"${c.folder ? ` in ${c.folder}` : ""} -> ${c.expected}${c.why ? ` (${c.why})` : ""}`, async function () {
                const result = await runTool("search_notes", { query: c.query, ...(c.folder ? { folder: c.folder } : {}) });
                const paths = rankedPaths(result);
                if (paths[0] !== c.expected) {
                    throw new Error(`expected ${c.expected} first, got:\n${result}`);
                }
                if (c.folder) {
                    for (const p of paths) expect(p.startsWith(`${c.folder}/`)).toBe(true);
                }
            });
        }

        it("reports no matches for words that are in no note", async function () {
            expect(await runTool("search_notes", { query: "zeppelin xylophone quasar" })).toContain("No matching notes");
        });
    });

    describe("grep_notes finds exactly the right notes", function () {
        const cases: Array<{ name: string; args: Record<string, unknown>; expected: string[] }> = [
            { name: "an invoice number", args: { pattern: "INV-20417" }, expected: ["Cars/Brake Job Notes.md"] },
            { name: "a policy number", args: { pattern: "HO-4471-9920" }, expected: ["Home/Home Insurance Policy.md"] },
            { name: "an exact phrase", args: { pattern: "last frost" }, expected: ["Home/Garden Planting Calendar.md"] },
            { name: "a tag", args: { pattern: "#meeting" }, expected: ["Work/One on One with Marcus.md", "Work/Q3 Planning Meeting.md"] },
            { name: "a dollar amount, taken literally", args: { pattern: "$1,274" }, expected: ["Finance/2023 Tax Return.md"] },
            { name: "an IP address, taken literally", args: { pattern: "192.168.50.20" }, expected: ["Home/Wifi Network Setup.md"] },
            { name: "a percentage, taken literally", args: { pattern: "5.875%" }, expected: ["Finance/Mortgage Refinance.md"] },
            {
                name: "a regular expression with alternatives",
                args: { pattern: "Dr\\. (Okafor|Lindqvist)", regex: true },
                expected: ["Health/Dentist Visits.md", "Health/Eye Exam Prescription.md"],
            },
            {
                name: "a date regular expression inside one folder",
                args: { pattern: "\\b\\d{4}-\\d{2}-\\d{2}\\b", regex: true, folder: "Cars" },
                expected: ["Cars/Brake Job Notes.md", "Cars/Honda Civic Maintenance Log.md", "Cars/Subaru Outback Tires.md"],
            },
            { name: "any letter case by default", args: { pattern: "delta skymiles" }, expected: ["Travel/Frequent Flyer Numbers.md"] },
            { name: "the exact case when asked", args: { pattern: "Delta", case_sensitive: true }, expected: ["Travel/Frequent Flyer Numbers.md"] },
            { name: "nothing when the case differs", args: { pattern: "delta", case_sensitive: true }, expected: [] },
            { name: "nothing for text in no note", args: { pattern: "zeppelin-xylophone" }, expected: [] },
        ];

        for (const c of cases) {
            it(`finds ${c.name}: ${JSON.stringify(c.args)}`, async function () {
                const result = await runTool("grep_notes", c.args);
                if (c.expected.length === 0) {
                    expect(result).toBe("No matches.");
                    return;
                }
                expect(grepPaths(result)).toEqual(c.expected);
            });
        }

        it("returns the line number and the matching line", async function () {
            const result = await runTool("grep_notes", { pattern: "INV-20417" });
            expect(result).toBe("Cars/Brake Job Notes.md:6: - Invoice: INV-20417");
        });

        it("stops at the requested number of lines", async function () {
            const result = await runTool("grep_notes", { pattern: "e", limit: 5 });
            expect(result.split("\n").length).toBe(5);
        });
    });

    describe("the agent answers from the larger vault", function () {
        let llm: FakeLmStudio;

        before(async function () {
            llm = await startFakeLmStudio((body) => {
                const question = lastUserText(body).split("User question: ").pop() ?? "";
                const results = toolResults(body);
                if (/invoice/i.test(question)) {
                    if (results.length === 0) return { toolCalls: [{ name: "grep_notes", args: { pattern: "INV-20417" } }] };
                    return { text: `That invoice is in ${results[0].match(/^(.+?\.md):/)?.[1] ?? "no note"}.` };
                }
                if (/checkout/i.test(question)) {
                    if (results.length === 0) return { toolCalls: [{ name: "search_notes", args: { query: "checkout outage downtime" } }] };
                    if (results.length === 1) {
                        return { toolCalls: [{ name: "read_note", args: { path: results[0].match(/1\. (.+?\.md)/)?.[1] ?? "missing" } }] };
                    }
                    return { text: `Checkout was down for ${results[1].match(/down for (\d+ minutes)/)?.[1] ?? "an unknown time"}.` };
                }
                return { text: "Hello from the fake model." };
            });
            await browser.executeObsidian(async ({ app }, url) => {
                const plugin = (app as any).plugins.plugins["private-ai"];
                Object.assign(plugin.settings, { apiEndpoint: url, model: "mock-model" });
                await plugin.saveSettings();
            }, llm.url);
            await browser.executeObsidianCommand("private-ai:open-local-llm-chat");
            await browser.$('[data-type="local-llm-chat-view"] textarea.local-llm-input').waitForExist({ timeout: 10000 });
        });

        after(async function () {
            await llm?.close();
        });

        async function askAndWaitFor(question: string, expected: string): Promise<void> {
            await browser.$('[data-type="local-llm-chat-view"] textarea.local-llm-input').setValue(question);
            await browser.$('[data-type="local-llm-chat-view"] .local-llm-send-button').click();
            const lastReply = () => browser.execute(() => {
                const all = document.querySelectorAll('[data-type="local-llm-chat-view"] .local-llm-message-assistant .local-llm-message-content');
                return (all[all.length - 1]?.textContent ?? "").trim();
            });
            await browser.waitUntil(async () => (await lastReply()).includes(expected), { timeout: 20000 }).catch(async () => {
                throw new Error(`expected a reply containing "${expected}", last reply: "${await lastReply()}"`);
            });
        }

        it("finds an exact string with grep_notes", async function () {
            await askAndWaitFor("Which note has the brake invoice?", "That invoice is in Cars/Brake Job Notes.md.");
        });

        it("finds and reads the right note with search_notes", async function () {
            await askAndWaitFor("How long was checkout down?", "Checkout was down for 47 minutes.");
        });
    });
});
