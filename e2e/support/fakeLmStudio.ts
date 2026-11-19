import * as http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A scripted OpenAI-compatible server standing in for LM Studio, for offline
 * evals. `respond` gets the parsed request body and returns either tool calls
 * or a final text answer; the server streams it back as SSE like LM Studio.
 */
export type FakeReply = { toolCalls: Array<{ name: string; args: object }> } | { text: string };

export interface FakeLmStudio {
    url: string;
    requests: any[];
    close(): Promise<void>;
}

const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export interface FakeLmStudioOptions {
    /**
     * The downloaded models to report, in the shape of LM Studio's /api/v1/models
     * (key, type, size_bytes, loaded_instances, capabilities). Left out, the server
     * reports one model called "mock-model" with no capability information.
     */
    restModels?: object[];
}

export async function startFakeLmStudio(respond: (body: any) => FakeReply, options: FakeLmStudioOptions = {}): Promise<FakeLmStudio> {
    const requests: any[] = [];
    let callCounter = 0;
    const server = http.createServer((req, res) => {
        if (req.method === "OPTIONS") {
            res.writeHead(204, cors);
            res.end();
            return;
        }
        if (req.method === "GET") {
            res.writeHead(200, { ...cors, "Content-Type": "application/json" });
            const rest = options.restModels;
            const listing = !rest
                ? { data: [{ id: "mock-model" }] }
                : req.url?.startsWith("/api/v1/models")
                    ? { models: rest }
                    : { data: rest.map((m: any) => ({ id: m.key, object: "model" })) };
            res.end(JSON.stringify(listing));
            return;
        }
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
            const body = raw ? JSON.parse(raw) : {};
            requests.push(body);
            const reply = respond(body);
            const base = { id: "chatcmpl-e2e", object: "chat.completion.chunk", created: 0, model: "mock-model" };
            if (!body.stream) {
                const text = "text" in reply ? reply.text : "";
                res.writeHead(200, { ...cors, "Content-Type": "application/json" });
                res.end(JSON.stringify({ ...base, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }] }));
                return;
            }
            res.writeHead(200, { ...cors, "Content-Type": "text/event-stream" });
            const send = (delta: object, finish: string | null = null) =>
                res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
            if ("toolCalls" in reply) {
                reply.toolCalls.forEach((call, index) => {
                    send({ tool_calls: [{ index, id: `call_${++callCounter}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }] });
                });
                send({}, "tool_calls");
            } else {
                for (const word of reply.text.split(/(?<= )/)) send({ content: word });
                send({}, "stop");
            }
            res.end("data: [DONE]\n\n");
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    return {
        url: `http://127.0.0.1:${port}/v1/chat/completions`,
        requests,
        close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
    };
}

/** Text of the tool results sent since the latest user message (this question only). */
export function toolResults(body: any): string[] {
    const messages: any[] = body.messages ?? [];
    let lastUser = -1;
    messages.forEach((m, i) => { if (m.role === "user") lastUser = i; });
    return messages
        .slice(lastUser + 1)
        .filter((m: any) => m.role === "tool")
        .map((m: any) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
}

/** The latest user message's text. */
export function lastUserText(body: any): string {
    const users = (body.messages ?? []).filter((m: any) => m.role === "user");
    const c = users[users.length - 1]?.content;
    return typeof c === "string" ? c : JSON.stringify(c ?? "");
}
