import { Agent, AgentMessage, AgentTool, StreamFn } from '@mariozechner/pi-agent-core';
import type { Model } from '@mariozechner/pi-ai';
import { buildSystemPrompt } from './systemPrompt';

export interface PiChatSettings {
	/** OpenAI-compatible chat completions URL, e.g. http://localhost:1234/v1/chat/completions */
	apiEndpoint: string;
	apiKey?: string;
	model?: string;
	maxTokens: number;
	temperature: number;
	/** User preferences appended to the system prompt. */
	systemPrompt: string;
	/** Max rounds of tool calls before the agent must answer. */
	maxToolRounds: number;
	contextWindow: number;
}

export type ChatAgentEvent =
	| { type: 'text'; delta: string }
	| { type: 'thinking'; delta: string }
	| { type: 'tool_start'; id: string; name: string; args: unknown }
	| { type: 'tool_end'; id: string; name: string; isError: boolean; resultText: string };

export interface PiChatAgentDeps {
	settings: () => PiChatSettings;
	/** Tools for this run (from the built-in MCP server). Empty array = plain chat. */
	loadTools: () => Promise<AgentTool[]>;
	/** Picks a model id when none is configured (e.g. the model loaded in LM Studio). */
	resolveModelId?: () => Promise<string | undefined>;
	/** Override for tests; defaults to Pi's streamSimple. */
	streamFn?: StreamFn;
	/** Override for tests; defaults to an OpenAI-compatible model built from settings. */
	buildModel?: (settings: PiChatSettings, modelId: string) => Model<any>;
	now?: () => Date;
}

export interface ChatTurnOptions {
	/** Extra context placed ahead of the user's message (e.g. open notes). */
	context?: string;
	/** When false, the agent runs without tools for this turn. */
	useTools?: boolean;
}

export class ChatAgentError extends Error {}

export function baseUrlFromEndpoint(endpoint: string): string {
	return endpoint.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
}

/** An OpenAI-compatible Pi model for a local server (LM Studio, Ollama, llama.cpp, ...). */
export function buildLocalModel(settings: PiChatSettings, modelId: string): Model<'openai-completions'> {
	return {
		id: modelId,
		name: modelId,
		api: 'openai-completions',
		provider: 'local',
		baseUrl: baseUrlFromEndpoint(settings.apiEndpoint),
		reasoning: false,
		input: ['text'],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: settings.contextWindow,
		maxTokens: settings.maxTokens,
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			supportsStrictMode: false,
			maxTokensField: 'max_tokens',
		},
	};
}

function messageChars(m: AgentMessage): number {
	const content = (m as { content?: unknown }).content;
	if (typeof content === 'string') return content.length;
	if (!Array.isArray(content)) return 0;
	let n = 0;
	for (const c of content as Array<Record<string, unknown>>) {
		for (const key of ['text', 'thinking']) if (typeof c[key] === 'string') n += (c[key] as string).length;
		if (c.arguments) n += JSON.stringify(c.arguments).length;
	}
	return n;
}

/**
 * Drops the oldest whole exchanges (cut only at user messages, so tool calls
 * stay paired with their results) until the history fits the context budget.
 */
export function pruneToBudget(messages: AgentMessage[], maxChars: number): AgentMessage[] {
	let total = messages.reduce((n, m) => n + messageChars(m), 0);
	let start = 0;
	while (total > maxChars) {
		let next = -1;
		for (let i = start + 1; i < messages.length; i++) {
			if (messages[i].role === 'user') {
				next = i;
				break;
			}
		}
		if (next < 0) break; // Only the current exchange is left; keep it.
		for (let i = start; i < next; i++) total -= messageChars(messages[i]);
		start = next;
	}
	return start === 0 ? messages : messages.slice(start);
}

/**
 * The chat agent: Pi's agent loop over an OpenAI-compatible local model,
 * with the vault tools from the built-in MCP server. Keeps the conversation
 * between turns; reset() starts a new chat.
 */
export class PiChatAgent {
	private history: AgentMessage[] = [];
	private running: Agent | null = null;

	constructor(private readonly deps: PiChatAgentDeps) {}

	get messages(): readonly AgentMessage[] {
		return this.history;
	}

	reset(): void {
		this.running?.abort();
		this.running = null;
		this.history = [];
	}

	async send(userText: string, onEvent: (e: ChatAgentEvent) => void, signal?: AbortSignal, options: ChatTurnOptions = {}): Promise<string> {
		const settings = this.deps.settings();
		const modelId = settings.model?.trim() || (await this.deps.resolveModelId?.()) || '';
		if (!modelId) {
			throw new ChatAgentError('No model is loaded. Load a chat model in LM Studio, or pick one in the Private AI settings.');
		}
		const useTools = options.useTools !== false;
		const tools = useTools ? await this.deps.loadTools() : [];
		const model = (this.deps.buildModel ?? buildLocalModel)(settings, modelId);
		const budgetChars = Math.max(8000, (settings.contextWindow - settings.maxTokens) * 3);

		let toolRounds = 0;
		let lastAssistant: unknown = null;
		let runaway = false;
		// Pi has no turn cap: past the soft limit tools are refused, and if the model
		// keeps calling them anyway the run is stopped.
		const hardLimit = settings.maxToolRounds + 2;
		const agent = new Agent({
			initialState: {
				systemPrompt: buildSystemPrompt(settings.systemPrompt, tools.length > 0, this.deps.now?.()),
				model,
				thinkingLevel: 'off',
				tools,
				messages: [...this.history],
			},
			getApiKey: () => settings.apiKey || 'not-needed',
			transformContext: async (messages) => pruneToBudget(messages, budgetChars),
			toolExecution: 'parallel',
			beforeToolCall: async ({ assistantMessage }) => {
				if (assistantMessage !== lastAssistant) {
					lastAssistant = assistantMessage;
					toolRounds++;
				}
				if (toolRounds > hardLimit) {
					runaway = true;
					agent.abort();
					return { block: true, reason: 'Stopped: too many tool calls.' };
				}
				if (toolRounds > settings.maxToolRounds) {
					return { block: true, reason: 'Tool limit reached for this question. Answer now with what you have found.' };
				}
				return undefined;
			},
			...(this.deps.streamFn
				? { streamFn: this.deps.streamFn }
				: {}),
		});
		// Temperature and output length are per-request stream options.
		const baseStream = agent.streamFn;
		agent.streamFn = (m, ctx, opts) => baseStream(m, ctx, { ...opts, temperature: settings.temperature, maxTokens: settings.maxTokens });

		let answer = '';
		let textSinceTurnStart = false;
		// A failing UI callback must not abort the agent run.
		const emit = (e: ChatAgentEvent) => {
			try {
				onEvent(e);
			} catch {
				// ignored
			}
		};
		agent.subscribe((event) => {
			switch (event.type) {
				case 'turn_start':
					textSinceTurnStart = false;
					break;
				case 'message_update': {
					const e = event.assistantMessageEvent;
					if (e.type === 'text_delta') {
						if (!textSinceTurnStart && answer.length > 0) {
							answer += '\n\n';
							emit({ type: 'text', delta: '\n\n' });
						}
						textSinceTurnStart = true;
						answer += e.delta;
						emit({ type: 'text', delta: e.delta });
					} else if (e.type === 'thinking_delta') {
						emit({ type: 'thinking', delta: e.delta });
					}
					break;
				}
				case 'tool_execution_start':
					emit({ type: 'tool_start', id: event.toolCallId, name: event.toolName, args: event.args });
					break;
				case 'tool_execution_end': {
					const content = (event.result?.content ?? []) as Array<{ type: string; text?: string }>;
					const resultText = content.map((c) => c.text ?? '').join('\n');
					emit({ type: 'tool_end', id: event.toolCallId, name: event.toolName, isError: event.isError, resultText });
					break;
				}
			}
		});

		const onAbort = () => agent.abort();
		signal?.addEventListener('abort', onAbort);
		this.running = agent;
		try {
			const content = options.context ? `${options.context}\n\nUser question: ${userText}` : userText;
			await agent.prompt(content);
		} finally {
			signal?.removeEventListener('abort', onAbort);
			if (this.running === agent) this.running = null;
		}

		if (runaway) {
			throw new ChatAgentError('The model kept calling tools without answering, so the request was stopped. Try rephrasing, or use a model with better tool support.');
		}
		if (signal?.aborted) {
			// Keep what was said so far so the conversation can continue.
			this.history = [...agent.state.messages];
			const err = new Error('Aborted');
			err.name = 'AbortError';
			throw err;
		}
		if (agent.state.errorMessage) {
			// Leave history as it was before this failed turn.
			throw new ChatAgentError(agent.state.errorMessage);
		}
		this.history = [...agent.state.messages];
		return answer;
	}
}
