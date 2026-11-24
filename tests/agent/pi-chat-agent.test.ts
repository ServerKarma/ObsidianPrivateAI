// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall, registerFauxProvider, FauxProviderRegistration } from '@mariozechner/pi-ai';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { PiChatAgent, PiChatSettings, ChatAgentEvent, baseUrlFromEndpoint, buildLocalModel, pruneToBudget, FALLBACK_CONTEXT_WINDOW } from '../../src/agent/pi/PiChatAgent';
import { loadMcpTools } from '../../src/agent/pi/mcpTools';
import { createVaultTools, ChangeRequest } from '../../src/agent/tools/vaultTools';
import { createVaultMcpServer } from '../../src/agent/mcp/vaultMcpServer';
import { connectInProcess } from '../../src/agent/mcp/inProcessClient';
import { VaultSearch } from '../../src/agent/search/VaultSearch';
import { InMemoryVault } from '../mocks/InMemoryVault';

const SETTINGS: PiChatSettings = {
	apiEndpoint: 'http://localhost:1234/v1/chat/completions',
	systemPrompt: 'Keep answers short.',
	maxToolRounds: 3,
};

let faux: FauxProviderRegistration;
let client: Client;
let vault: InMemoryVault;
let approve = true;
let asked: ChangeRequest[] = [];
const confirm = async (r: ChangeRequest) => {
	asked.push(r);
	return approve;
};

beforeEach(async () => {
	approve = true;
	asked = [];
	faux = registerFauxProvider({ tokensPerSecond: 100000 });
	vault = new InMemoryVault({
		'Home/Water Heater Replacement.md': 'Replaced the water heater on 2024-03-15 for $1,850.',
		'Home/Dishwasher.md': 'Dishwasher pump fixed.',
	});
	const search = new VaultSearch(vault);
	client = await connectInProcess(createVaultMcpServer(createVaultTools({ vault, search, confirm: (r) => confirm(r) }), { version: 't', allowWrites: () => true }));
});

afterEach(async () => {
	faux.unregister();
	await client.close();
});

function makeAgent(overrides: Partial<PiChatSettings> = {}) {
	return new PiChatAgent({
		settings: () => ({ ...SETTINGS, ...overrides }),
		loadTools: () => loadMcpTools(client),
		resolveModel: async () => ({ id: 'loaded-model' }),
		buildModel: () => faux.getModel(),
		now: () => new Date('2026-11-19T12:00:00Z'),
	});
}

const toolResultsIn = (context: { messages: Array<{ role: string; toolName?: string; content?: unknown }> }) =>
	context.messages.filter((m) => m.role === 'toolResult');

describe('PiChatAgent (Pi harness over the built-in MCP server)', () => {
	it('searches, reads and answers through MCP tools', async () => {
		let systemPrompt = '';
		let toolNames: string[] = [];
		faux.setResponses([
			(context) => {
				systemPrompt = context.systemPrompt ?? '';
				toolNames = (context.tools ?? []).map((t) => t.name);
				return fauxAssistantMessage([fauxThinking('I should search.'), fauxToolCall('search_notes', { query: 'water heater' })], { stopReason: 'toolUse' });
			},
			(context) => {
				const results = toolResultsIn(context as any);
				expect(JSON.stringify(results[0].content)).toContain('Home/Water Heater Replacement.md');
				return fauxAssistantMessage([fauxToolCall('read_note', { path: 'Home/Water Heater Replacement.md' })], { stopReason: 'toolUse' });
			},
			(context) => {
				expect(JSON.stringify(toolResultsIn(context as any)[1].content)).toContain('2024-03-15');
				return fauxAssistantMessage(fauxText('You replaced it on 2024-03-15 ([[Water Heater Replacement]]).'));
			},
		]);

		const events: ChatAgentEvent[] = [];
		const answer = await makeAgent().send('When did I replace the water heater?', (e) => events.push(e));

		expect(answer).toBe('You replaced it on 2024-03-15 ([[Water Heater Replacement]]).');
		expect(toolNames).toContain('search_notes');
		expect(toolNames).toContain('delete_note');
		expect(systemPrompt).toContain('search_notes');
		expect(systemPrompt).toContain('Keep answers short.');
		expect(systemPrompt).toContain('2026-11-19');
		expect(events.filter((e) => e.type === 'tool_start').map((e) => (e as any).name)).toEqual(['search_notes', 'read_note']);
		expect(events.some((e) => e.type === 'thinking')).toBe(true);
		expect(events.filter((e) => e.type === 'text').map((e) => (e as any).delta).join('')).toBe(answer);
	});

	it('keeps the conversation between turns and forgets it on reset', async () => {
		const agent = makeAgent();
		faux.setResponses([fauxAssistantMessage(fauxText('Hi Gabe.'))]);
		await agent.send('My name is Gabe', () => undefined);
		let seen = 0;
		faux.setResponses([(context) => {
			seen = context.messages.length;
			return fauxAssistantMessage(fauxText('Your name is Gabe.'));
		}]);
		await agent.send('What is my name?', () => undefined);
		expect(seen).toBe(3);
		agent.reset();
		expect(agent.messages).toHaveLength(0);
	});

	it('runs without tools when asked (context mode "None")', async () => {
		let toolCount = -1;
		faux.setResponses([(context) => {
			toolCount = (context.tools ?? []).length;
			return fauxAssistantMessage(fauxText('ok'));
		}]);
		await makeAgent().send('hello', () => undefined, undefined, { useTools: false });
		expect(toolCount).toBe(0);
	});

	it('puts supplied context ahead of the question', async () => {
		let userText = '';
		faux.setResponses([(context) => {
			userText = JSON.stringify(context.messages[0]);
			return fauxAssistantMessage(fauxText('ok'));
		}]);
		await makeAgent().send('Summarize this', () => undefined, undefined, { context: 'NOTE: Dishwasher pump fixed.' });
		expect(userText).toContain('NOTE: Dishwasher pump fixed.');
		expect(userText).toContain('User question: Summarize this');
	});

	it('blocks tools after the round limit so the model must answer', async () => {
		const loop = () => fauxAssistantMessage([fauxToolCall('list_notes', {})], { stopReason: 'toolUse' });
		let lastResult = '';
		faux.setResponses([loop, loop, (ctx) => {
			lastResult = JSON.stringify(toolResultsIn(ctx as any).pop());
			return fauxAssistantMessage(fauxText('Done.'));
		}]);
		const answer = await makeAgent({ maxToolRounds: 1 }).send('loop', () => undefined);
		expect(answer).toBe('Done.');
		expect(lastResult).toContain('Tool limit reached');
	});

	it('stops a model that never stops calling tools', async () => {
		const loop = () => fauxAssistantMessage([fauxToolCall('list_notes', {})], { stopReason: 'toolUse' });
		faux.setResponses(Array.from({ length: 10 }, () => loop));
		await expect(makeAgent({ maxToolRounds: 1 }).send('loop forever', () => undefined)).rejects.toThrow(/kept calling tools/);
	});

	it('returns tool errors to the model instead of failing the turn', async () => {
		let errorText = '';
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall('read_note', { path: 'Nope.md' })], { stopReason: 'toolUse' }),
			(ctx) => {
				const r = toolResultsIn(ctx as any)[0] as any;
				errorText = r.isError ? JSON.stringify(r.content) : '';
				return fauxAssistantMessage(fauxText('That note does not exist.'));
			},
		]);
		const answer = await makeAgent().send('read Nope', () => undefined);
		expect(answer).toBe('That note does not exist.');
		expect(errorText).toContain('Note not found');
	});

	it('edits the vault when the model asks to', async () => {
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall('create_note', { path: 'Todo', content: '- call plumber' })], { stopReason: 'toolUse' }),
			fauxAssistantMessage(fauxText('Created Todo.md.')),
		]);
		await makeAgent().send('Make a todo note', () => undefined);
		expect(asked).toEqual([expect.objectContaining({ action: 'create', path: 'Todo.md', content: '- call plumber' })]);
		expect(await vault.read('Todo.md')).toBe('- call plumber');
	});

	it('changes nothing when the user denies the change, and tells the model', async () => {
		approve = false;
		let toolResult = '';
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall('delete_note', { path: 'Home/Dishwasher.md' })], { stopReason: 'toolUse' }),
			(ctx) => {
				toolResult = JSON.stringify(toolResultsIn(ctx as any)[0]);
				return fauxAssistantMessage(fauxText('OK, I left it.'));
			},
		]);
		await makeAgent().send('Delete the dishwasher note', () => undefined);
		expect(asked).toHaveLength(1);
		expect(toolResult).toContain('declined');
		expect(vault.getFile('Home/Dishwasher.md')).not.toBeNull();
		expect(vault.trashed).toEqual([]);
	});

	it('surfaces provider errors and leaves history unchanged', async () => {
		const agent = makeAgent();
		faux.setResponses([fauxAssistantMessage([], { stopReason: 'error', errorMessage: 'Connection refused' })]);
		await expect(agent.send('hi', () => undefined)).rejects.toThrow('Connection refused');
		expect(agent.messages).toHaveLength(0);
	});

	it('fails clearly when no model is available', async () => {
		const agent = new PiChatAgent({ settings: () => SETTINGS, loadTools: async () => [], resolveModel: async () => undefined });
		await expect(agent.send('hi', () => undefined)).rejects.toThrow(/No model is loaded/);
	});

	it('stops on abort', async () => {
		const controller = new AbortController();
		faux.setResponses([() => {
			controller.abort();
			return fauxAssistantMessage(fauxText('partial'));
		}]);
		await expect(makeAgent().send('hi', () => undefined, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
	});
});

describe('local model config', () => {
	it('targets the OpenAI-compatible base URL with local-server compat flags', () => {
		expect(baseUrlFromEndpoint('http://localhost:1234/v1/chat/completions')).toBe('http://localhost:1234/v1');
		expect(baseUrlFromEndpoint('http://host:8080/v1/')).toBe('http://host:8080/v1');
		const model = buildLocalModel(SETTINGS, 'qwen3-8b');
		expect(model).toMatchObject({ id: 'qwen3-8b', api: 'openai-completions', baseUrl: 'http://localhost:1234/v1' });
		expect(model.compat).toMatchObject({ supportsDeveloperRole: false, supportsStore: false, maxTokensField: 'max_tokens' });
	});

	it('refuses an empty or non-http server URL so the OpenAI client never falls back to api.openai.com', () => {
		for (const apiEndpoint of ['', '   ', '/chat/completions', 'localhost:1234/v1']) {
			expect(() => buildLocalModel({ ...SETTINGS, apiEndpoint }, 'm')).toThrow(/server URL/);
		}
	});

	it('uses the context window LM Studio reports and leaves the reply length to the model', () => {
		expect(buildLocalModel(SETTINGS, 'm', 32768)).toMatchObject({ contextWindow: 32768, maxTokens: 0 });
		expect(buildLocalModel(SETTINGS, 'm')).toMatchObject({ contextWindow: FALLBACK_CONTEXT_WINDOW });
	});

	it('passes the reported context window to the model and sends no reply cap or temperature', async () => {
		const seen: number[] = [];
		const sent: Array<{ maxTokens?: number; temperature?: number } | undefined> = [];
		const agent = new PiChatAgent({
			settings: () => SETTINGS,
			loadTools: async () => [],
			resolveModel: async () => ({ id: 'loaded-model', contextWindow: 8192 }),
			buildModel: (_s, _id, contextWindow) => {
				seen.push(contextWindow);
				return faux.getModel();
			},
		});
		faux.setResponses([(_ctx: unknown, opts?: { maxTokens?: number; temperature?: number }) => {
			sent.push(opts);
			return fauxAssistantMessage(fauxText('ok'));
		}]);
		await agent.send('hi', () => undefined);
		expect(seen).toEqual([8192]);
		expect(sent[0]?.temperature).toBeUndefined();
	});

	it('prunes whole old exchanges to fit the context budget', () => {
		const msg = (role: string, text: string) => ({ role, content: text, timestamp: 0 }) as any;
		const history = [msg('user', 'a'.repeat(50)), msg('assistant', 'b'.repeat(50)), msg('user', 'c'.repeat(10)), msg('assistant', 'd'.repeat(10))];
		expect(pruneToBudget(history, 1000)).toHaveLength(4);
		expect(pruneToBudget(history, 30)).toEqual(history.slice(2));
		expect(pruneToBudget(history.slice(2), 5)).toHaveLength(2);
	});
});
