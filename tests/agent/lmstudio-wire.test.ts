// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { PiChatAgent, PiChatSettings } from '../../src/agent/pi/PiChatAgent';
import { loadMcpTools } from '../../src/agent/pi/mcpTools';
import { createVaultTools } from '../../src/agent/tools/vaultTools';
import { createVaultMcpServer } from '../../src/agent/mcp/vaultMcpServer';
import { connectInProcess } from '../../src/agent/mcp/inProcessClient';
import { VaultSearch } from '../../src/agent/search/VaultSearch';
import { InMemoryVault } from '../mocks/InMemoryVault';

/**
 * A fake LM Studio: an OpenAI-compatible /v1/chat/completions endpoint that streams
 * SSE chunks, including tool calls split across chunks the way local servers send them.
 * This exercises Pi's real openai-completions provider end to end, with no mocks.
 */
type Turn = (body: any) => object[];

let server: http.Server;
let requests: any[] = [];
let turns: Turn[] = [];
let endpoint = '';

const chunk = (delta: object, finish: string | null = null) => ({
	id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 0, model: 'qwen3-8b',
	choices: [{ index: 0, delta, finish_reason: finish }],
});

beforeEach(async () => {
	requests = [];
	server = http.createServer((req, res) => {
		let raw = '';
		req.on('data', (c) => (raw += c));
		req.on('end', () => {
			const body = JSON.parse(raw);
			requests.push({ body, auth: req.headers.authorization, url: req.url });
			const turn = turns.shift();
			res.writeHead(200, { 'Content-Type': 'text/event-stream' });
			for (const c of turn ? turn(body) : [chunk({ content: 'no script' }, 'stop')]) res.write(`data: ${JSON.stringify(c)}\n\n`);
			res.end('data: [DONE]\n\n');
		});
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
	endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`;
});

afterEach(async () => {
	await new Promise<void>((r) => server.close(() => r()));
});

describe('Pi agent against an OpenAI-compatible local server', () => {
	let client: Client;
	afterEach(async () => client?.close());

	it('streams tool calls, runs them through MCP and sends results back in OpenAI format', async () => {
		const vault = new InMemoryVault({ 'Home/HVAC Tune-up.md': 'Furnace serviced by Acme on 2025-10-02.' });
		client = await connectInProcess(createVaultMcpServer(createVaultTools({ vault, search: new VaultSearch(vault), confirm: async () => true }), { version: 't', allowWrites: () => true }));

		turns = [
			() => [
				chunk({ role: 'assistant', reasoning_content: 'Search for furnace.' }),
				chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'grep_notes', arguments: '' } }] }),
				chunk({ tool_calls: [{ index: 0, function: { arguments: '{"pattern":' } }] }),
				chunk({ tool_calls: [{ index: 0, function: { arguments: '"furnace"}' } }] }),
				chunk({}, 'tool_calls'),
			],
			() => [chunk({ content: 'Your furnace was serviced ' }), chunk({ content: 'on 2025-10-02.' }), chunk({}, 'stop')],
		];

		const settings: PiChatSettings = {
			apiEndpoint: endpoint, apiKey: 'sk-lm', model: 'qwen3-8b',
			systemPrompt: '', maxToolRounds: 5,
		};
		const thinking: string[] = [];
		const agent = new PiChatAgent({ settings: () => settings, loadTools: () => loadMcpTools(client) });
		const answer = await agent.send('When was the heating system maintained?', (e) => {
			if (e.type === 'thinking') thinking.push(e.delta);
		});

		expect(answer).toBe('Your furnace was serviced on 2025-10-02.');
		expect(thinking.join('')).toBe('Search for furnace.');
		expect(requests).toHaveLength(2);

		const first = requests[0];
		expect(first.url).toBe('/v1/chat/completions');
		expect(first.auth).toBe('Bearer sk-lm');
		expect(first.body).toMatchObject({ model: 'qwen3-8b', stream: true });
		// Reply length and sampling are left to the model's settings in LM Studio.
		expect(first.body).not.toHaveProperty('max_tokens');
		expect(first.body).not.toHaveProperty('max_completion_tokens');
		expect(first.body).not.toHaveProperty('temperature');
		expect(first.body.messages[0].role).toBe('system');
		expect(first.body.tools.map((t: any) => t.function.name)).toContain('grep_notes');

		const second = requests[1].body.messages;
		const toolMsg = second.find((m: any) => m.role === 'tool');
		expect(toolMsg).toMatchObject({ tool_call_id: 'call_1' });
		expect(JSON.stringify(toolMsg.content)).toContain('Home/HVAC Tune-up.md:1: Furnace serviced by Acme on 2025-10-02.');
		const assistantMsg = second.find((m: any) => m.role === 'assistant');
		expect(assistantMsg.tool_calls[0].function).toMatchObject({ name: 'grep_notes', arguments: '{"pattern":"furnace"}' });
	});

	it('reports a server that is not running as a readable error', async () => {
		await new Promise<void>((r) => server.close(() => r()));
		server = http.createServer();
		await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
		const agent = new PiChatAgent({
			settings: () => ({ apiEndpoint: 'http://127.0.0.1:1/v1/chat/completions', model: 'm', systemPrompt: '', maxToolRounds: 1 }),
			loadTools: async () => [],
		});
		await expect(agent.send('hi', () => undefined)).rejects.toThrow();
	});
});
