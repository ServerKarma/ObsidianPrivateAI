import { ItemView, WorkspaceLeaf, MarkdownRenderer, Notice, TFile, setIcon } from 'obsidian';
import { LLMService, createLLMService, ServerStatus } from '../services/LLMService';
import { setupInstructions, welcomeNoModelsMessage } from '../services/modelGuidance';
import { PiChatAgent, ChatAgentEvent } from '../agent/pi/PiChatAgent';
import { describeToolCall, summarizeToolResult } from '../agent/pi/toolActivity';
import { LoggingUtility } from '../utils/LoggingUtility';
import LocalLLMPlugin from '../main';
import { CHAT_RETENTION_CHOICES, ChatSummary, SavedChat, SavedChatMessage, chatTitle, newChatId } from '../services/ChatHistory';
import type { AgentMessage } from '@mariozechner/pi-agent-core';

export const CHAT_VIEW_TYPE = 'local-llm-chat-view';

interface ChatMessage {
	id: string;
	role: 'user' | 'assistant';
	content: string;
	timestamp: Date;
	isStreaming?: boolean;
	/** Notes the agent read while answering. */
	usedNotes?: UsedNote[];
	thinkingBlocks?: string[];
}

interface UsedNote {
	title: string;
	path: string;
}

interface StreamingThinkingState {
	inThinkBlock: boolean;
	buffer: string;
	blocks: string[];
	rawTranscript: string;
}

interface ThinkingViewState {
	expanded: boolean;
	stickToBottom: boolean;
}

interface ThinkingPanelElements {
	statusEl: HTMLElement;
	metaEl: HTMLElement;
	toggleButton: HTMLButtonElement;
	previewEl: HTMLElement;
}

interface LLMConfig {
	apiEndpoint: string;
	systemPrompt?: string;
	model?: string;
	apiKey?: string;
}

interface ObsidianApp {
	setting?: {
		open: () => void;
		openTabById: (tabId: string) => void;
	};
}

/** How many saved chats are kept; older ones are deleted. */
const MAX_SAVED_CHATS = 100;

/** The hint in the empty message box. A working server gets no greeting message in the chat itself. */
const INPUT_PLACEHOLDER = `What's on your mind?`;

export class ChatView extends ItemView {
	private messages: ChatMessage[] = [];
	private messageContainer: HTMLElement;
	private inputContainer: HTMLElement;
	private inputElement: HTMLTextAreaElement;
	private sendButton: HTMLButtonElement;
	private stopButton: HTMLButtonElement;
	private llmService: LLMService;
	private chatAgent: PiChatAgent;
	private isStreaming: boolean = false;
	private currentAbortController: AbortController | null = null;
	private plugin: LocalLLMPlugin;
	private streamingThinkingState = new Map<string, StreamingThinkingState>();
	private thinkingViewState = new Map<string, ThinkingViewState>();
	private streamingRenderInFlight = new Set<string>();
	private pendingStreamingRender = new Map<string, ChatMessage>();
	/** The saved chat this conversation is written to; null until the first answer. */
	private chatId: string | null = null;
	private chatCreatedAt: string | null = null;
	private historyPanel: HTMLElement;
	/** Resolves when the last save finished. For tests. */
	historySaved: Promise<void> = Promise.resolve();

	constructor(leaf: WorkspaceLeaf, plugin: LocalLLMPlugin) {
		super(leaf);
		this.plugin = plugin;
		// The Pi agent; it reaches the vault through the plugin's built-in MCP server.
		this.chatAgent = plugin.createChatAgent();
		// Initialize with plugin settings
		this.updateLLMServiceFromSettings();
	}

	getViewType(): string {
		return CHAT_VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'Private AI';
	}

	getIcon(): string {
		return 'sparkles';
	}

	async onOpen() {
		const container = this.containerEl.children[1];
		container.empty();
		container.addClass('local-llm-full-height');

		// Header: chat controls only (the pane's tab already names the view)
		const header = container.createEl('div', { cls: 'local-llm-chat-header' });

		// Create button container for header buttons
		const headerButtons = header.createEl('div', { cls: 'local-llm-header-buttons' });

		// Create settings button
		const settingsButton = headerButtons.createEl('button', {
			cls: 'local-llm-settings-button',
			attr: { 'aria-label': 'Open plugin settings', 'type': 'button' },
			text: '⚙'
		});

		settingsButton.addEventListener('click', () => {
			// Open the settings panel and navigate to Private AI plugin settings
			const settingTab = (this.app as unknown as ObsidianApp).setting;
			if (settingTab) {
				settingTab.open();
				settingTab.openTabById('private-ai');
			}
		});

		const historyButton = headerButtons.createEl('button', {
			cls: 'local-llm-history-button',
			text: 'History',
			attr: { 'aria-label': 'Show saved chats', 'type': 'button' }
		});
		historyButton.addEventListener('click', async () => {
			await this.toggleHistory();
		});

		// New chat sits on the right
		const newChatButton = headerButtons.createEl('button', {
			cls: 'local-llm-new-chat-button',
			text: 'New Chat',
			attr: { 'aria-label': 'Start new chat', 'type': 'button' }
		});
		newChatButton.addEventListener('click', async () => {
			await this.startNewChat();
		});

		// Create main chat container with flexbox layout
		const chatContainer = container.createEl('div', { cls: 'local-llm-chat-container' });

		// Create message container (scrollable area)
		this.messageContainer = chatContainer.createEl('div', {
			cls: 'local-llm-messages'
		});

		// Saved chats, shown in place of the messages when History is open
		this.historyPanel = chatContainer.createEl('div', {
			cls: 'local-llm-history local-llm-history-hidden'
		});

		// Create input container (fixed at bottom)
		this.inputContainer = chatContainer.createEl('div', {
			cls: 'local-llm-input-container'
		});

		// Create input element
		this.inputElement = this.inputContainer.createEl('textarea', {
			attr: { placeholder: INPUT_PLACEHOLDER },
			cls: 'local-llm-input'
		});

		// Create send button
		this.sendButton = this.inputContainer.createEl('button', {
			text: 'Send',
			cls: 'local-llm-send-button'
		});

		// Create stop button
		this.stopButton = this.inputContainer.createEl('button', {
			text: 'Stop',
			cls: 'local-llm-stop-button'
		});

		// Add event listeners
		this.inputElement.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				this.sendMessage();
			}
		});

		this.sendButton.addEventListener('click', () => {
			this.sendMessage();
		});

		this.stopButton.addEventListener('click', () => {
			this.stopStreaming();
		});

		// Obsidian waits for onOpen while it loads the workspace, so the server check must not
		// be awaited here: a slow or hung server would hold up the whole app.
		await this.showWelcome();
	}

	async onClose() {
		// Cleanup if needed
	}

	// Method to update LLM service from plugin settings
	updateLLMServiceFromSettings() {
		const settings = this.plugin.settings;
		LoggingUtility.log('Updating LLM service with settings:', settings);
		this.llmService = createLLMService({
			apiEndpoint: settings.apiEndpoint,
			systemPrompt: settings.systemPrompt,
			model: settings.model,
			apiKey: settings.apiKey
		});
	}

	updateLLMService(config: LLMConfig) {
		LoggingUtility.log('Updating LLM service with config:', config);
		this.llmService = createLLMService({
			apiEndpoint: config.apiEndpoint,
			systemPrompt: config.systemPrompt,
			model: config.model,
			apiKey: config.apiKey
		});
	}

	private async sendMessage() {
		const content = this.inputElement.value.trim();
		if (!content) return;
		if (this.historyOpen) this.hideHistory();

		// If already streaming, queue this message or handle it differently
		if (this.isStreaming) {
			LoggingUtility.log('Already streaming, but allowing new message to be sent');
			// We'll allow sending multiple messages, but we need to handle this properly
		}

		// Update LLM service with current settings before sending
		this.updateLLMServiceFromSettings();

		// Add user message
		const userMessage: ChatMessage = {
			id: Date.now().toString(),
			role: 'user',
			content: content,
			timestamp: new Date()
		};

		await this.addMessage(userMessage);
		this.inputElement.value = '';

		// Create abort controller for this request
		this.currentAbortController = new AbortController();

		// Keep input enabled but disable send button while streaming
		this.setSendButtonEnabled(false);
		this.showStopButton(true);
		this.isStreaming = true;

		// The agent always has the vault tools. It is told which note is active and which are open,
		// and decides itself whether the question is about that note or the rest of the vault.
		let workspace: string | undefined;
		try {
			workspace = this.plugin.agentRuntime?.workspaceContext();
		} catch (contextError) {
			LoggingUtility.error('Error reading the open notes:', contextError);
		}

		const assistantMessage: ChatMessage = {
			id: 'streaming-' + Date.now(),
			role: 'assistant',
			content: '',
			timestamp: new Date(),
			isStreaming: true
		};
		await this.addMessage(assistantMessage);

		// Agent events arrive faster than rendering; apply them strictly in order.
		let renderChain: Promise<void> = Promise.resolve();
		const push = (chunk: string) => {
			renderChain = renderChain
				.then(() => this.updateStreamingMessage(assistantMessage.id, chunk))
				.catch((renderError) => LoggingUtility.error('Error rendering streamed chunk:', renderError));
		};
		let inThinking = false;
		const openThinking = () => {
			if (!inThinking) {
				push('<think>');
				inThinking = true;
			}
		};
		const closeThinking = () => {
			if (inThinking) {
				push('</think>');
				inThinking = false;
			}
		};
		const notesRead = new Map<string, UsedNote>();
		const onEvent = (event: ChatAgentEvent) => {
			// A rendering problem must never break the agent run.
			try {
				switch (event.type) {
					case 'thinking':
						openThinking();
						push(event.delta);
						break;
					case 'tool_start':
						// Tool activity shows in the collapsible thinking panel, not in the answer.
						openThinking();
						push(`\n🔧 ${describeToolCall(event.name, event.args)}\n`);
						if (event.name === 'read_note') this.trackReadNote(event.args, notesRead);
						break;
					case 'tool_end':
						openThinking();
						push(`${event.isError ? '⚠️' : '↳'} ${summarizeToolResult(event.name, event.resultText, event.isError)}\n`);
						break;
					case 'text':
						closeThinking();
						push(event.delta);
						break;
				}
			} catch (renderError) {
				LoggingUtility.error('Error rendering agent event:', renderError);
			}
		};

		const finish = () => {
			this.isStreaming = false;
			this.setSendButtonEnabled(true);
			this.showStopButton(false);
			this.currentAbortController = null;
		};

		try {
			await this.chatAgent.send(content, onEvent, this.currentAbortController.signal, { context: workspace });
			closeThinking();
			await renderChain;
			assistantMessage.usedNotes = notesRead.size > 0 ? [...notesRead.values()] : undefined;
			await this.finalizeStreamingMessage(assistantMessage.id);
			finish();
			this.saveChat();
			if (typeof this.plugin.recordSuccessfulChat === 'function') {
				void this.plugin.recordSuccessfulChat();
			}
		} catch (error) {
			closeThinking();
			await renderChain;
			finish();
			if (error?.name === 'AbortError') {
				const streamingMessage = this.messages.find(m => m.isStreaming);
				if (streamingMessage) {
					streamingMessage.isStreaming = false;
					await this.finalizeStreamingMessage(streamingMessage.id);
				}
				this.saveChat();
			} else {
				this.handleStreamingError(assistantMessage.id, error);
			}
		}
	}

	private trackReadNote(args: unknown, notesRead: Map<string, UsedNote>): void {
		const raw = (args as { path?: unknown } | undefined)?.path;
		if (typeof raw !== 'string') return;
		const candidates = [raw, raw.endsWith('.md') ? raw : `${raw}.md`];
		for (const path of candidates) {
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) {
				notesRead.set(file.path, { title: file.basename, path: file.path });
				return;
			}
		}
	}

	private setInputEnabled(enabled: boolean) {
		this.inputElement.disabled = !enabled;
		this.sendButton.disabled = !enabled;

		if (enabled) {
			this.inputElement.focus();
		}
	}

	private setSendButtonEnabled(enabled: boolean) {
		this.sendButton.disabled = !enabled;

		if (enabled) {
			this.inputElement.focus();
		}
	}

	private showStopButton(show: boolean) {
		if (show) {
			this.stopButton.removeClass('local-llm-stop-button-hidden');
			this.stopButton.addClass('local-llm-stop-button-visible');
			this.sendButton.removeClass('local-llm-send-button-visible');
			this.sendButton.addClass('local-llm-send-button-hidden');
		} else {
			this.stopButton.removeClass('local-llm-stop-button-visible');
			this.stopButton.addClass('local-llm-stop-button-hidden');
			this.sendButton.removeClass('local-llm-send-button-hidden');
			this.sendButton.addClass('local-llm-send-button-visible');
		}
	}

	private async updateStreamingMessage(messageId: string, chunk: string) {
		const message = this.messages.find(m => m.id === messageId);
		if (!message) {
			return;
		}

		const state = this.getOrCreateStreamingThinkingState(messageId);
		const normalizedChunk = this.normalizeStreamingChunk(state, chunk);
		if (!normalizedChunk) {
			return;
		}

		const assistantDelta = this.extractAssistantContentFromChunk(state, normalizedChunk);
		if (assistantDelta.length > 0) {
			message.content += assistantDelta;
		}
		message.thinkingBlocks = state.blocks.length > 0 ? [...state.blocks] : undefined;

		// Update the content directly instead of re-rendering the full message shell.
		await this.updateStreamingContent(messageId, message);
	}

	private async updateStreamingContent(messageId: string, message: ChatMessage) {
		this.pendingStreamingRender.set(messageId, message);
		if (this.streamingRenderInFlight.has(messageId)) {
			return;
		}

		this.streamingRenderInFlight.add(messageId);
		try {
			while (true) {
				const nextMessage = this.pendingStreamingRender.get(messageId);
				if (!nextMessage) {
					break;
				}
				this.pendingStreamingRender.delete(messageId);

				const messageElement = this.messageContainer.querySelector(`[data-message-id="${messageId}"]`);
				if (!messageElement) {
					break;
				}

				const contentEl = messageElement.querySelector('.local-llm-message-content') as HTMLElement | null;
				if (!contentEl) {
					break;
				}

				await this.renderAssistantMessageContent(contentEl, nextMessage);
				this.messageContainer.scrollTop = this.messageContainer.scrollHeight;
			}
		} finally {
			this.streamingRenderInFlight.delete(messageId);
		}
	}

	private async finalizeStreamingMessage(messageId: string) {
		const message = this.messages.find(m => m.id === messageId);
		if (message) {
			this.flushStreamingThinkingState(message);
			message.isStreaming = false;
			const viewState = this.getOrCreateThinkingViewState(message);
			viewState.expanded = false;
			// Remove the existing message element and re-render with markdown
			const messageElement = this.messageContainer.querySelector(`[data-message-id="${messageId}"]`);
			if (messageElement) {
				messageElement.remove();
			}
			await this.renderMessage(message);
		}
	}

	private getOrCreateStreamingThinkingState(messageId: string): StreamingThinkingState {
		const existing = this.streamingThinkingState.get(messageId);
		if (existing) {
			return existing;
		}

		const created: StreamingThinkingState = {
			inThinkBlock: false,
			buffer: '',
			blocks: [],
			rawTranscript: ''
		};
		this.streamingThinkingState.set(messageId, created);
		return created;
	}

	/**
	 * Some providers send cumulative chunks instead of deltas.
	 * Normalize to true delta text so we don't duplicate thinking/output.
	 */
	private normalizeStreamingChunk(state: StreamingThinkingState, chunk: string): string {
		if (!chunk) {
			return '';
		}

		if (state.rawTranscript && chunk.length > state.rawTranscript.length && chunk.startsWith(state.rawTranscript)) {
			const delta = chunk.slice(state.rawTranscript.length);
			state.rawTranscript = chunk;
			return delta;
		}

		state.rawTranscript += chunk;
		return chunk;
	}

	private extractAssistantContentFromChunk(state: StreamingThinkingState, chunk: string): string {
		if (!chunk) {
			return '';
		}

		const openTag = '<think>';
		const closeTag = '</think>';
		const assistantParts: string[] = [];
		let input = state.buffer + chunk;
		state.buffer = '';

		while (input.length > 0) {
			if (!state.inThinkBlock) {
				const openIndex = input.toLowerCase().indexOf(openTag);
				if (openIndex === -1) {
					const carry = this.getTrailingTagPrefix(input, openTag);
					const safeLength = input.length - carry.length;
					if (safeLength > 0) {
						assistantParts.push(input.slice(0, safeLength));
					}
					state.buffer = carry;
					break;
				}

				if (openIndex > 0) {
					assistantParts.push(input.slice(0, openIndex));
				}

				state.inThinkBlock = true;
				state.blocks.push('');
				input = input.slice(openIndex + openTag.length);
				continue;
			}

			const closeIndex = input.toLowerCase().indexOf(closeTag);
			if (closeIndex === -1) {
				const carry = this.getTrailingTagPrefix(input, closeTag);
				const safeLength = input.length - carry.length;
				if (safeLength > 0) {
					this.appendToThinkingBlock(state, input.slice(0, safeLength));
				}
				state.buffer = carry;
				break;
			}

			if (closeIndex > 0) {
				this.appendToThinkingBlock(state, input.slice(0, closeIndex));
			}

			state.inThinkBlock = false;
			input = input.slice(closeIndex + closeTag.length);
		}

		return assistantParts.join('');
	}

	private flushStreamingThinkingState(message: ChatMessage): void {
		const state = this.streamingThinkingState.get(message.id);
		if (!state) {
			return;
		}

		if (state.buffer.length > 0) {
			if (state.inThinkBlock) {
				this.appendToThinkingBlock(state, state.buffer);
			} else {
				message.content += state.buffer;
			}
		}

		state.buffer = '';
		state.inThinkBlock = false;
		message.thinkingBlocks = state.blocks.length > 0 ? [...state.blocks] : undefined;
		this.streamingThinkingState.delete(message.id);
	}

	private appendToThinkingBlock(state: StreamingThinkingState, value: string): void {
		if (!value) {
			return;
		}

		if (state.blocks.length === 0) {
			state.blocks.push(value);
			return;
		}

		const lastIndex = state.blocks.length - 1;
		state.blocks[lastIndex] = `${state.blocks[lastIndex]}${value}`;
	}

	private getTrailingTagPrefix(value: string, tag: string): string {
		const maxLength = Math.min(value.length, tag.length - 1);
		const valueLower = value.toLowerCase();
		const tagLower = tag.toLowerCase();

		for (let prefixLength = maxLength; prefixLength > 0; prefixLength--) {
			if (valueLower.endsWith(tagLower.slice(0, prefixLength))) {
				return value.slice(value.length - prefixLength);
			}
		}

		return '';
	}

	private async renderAssistantMessageContent(contentEl: HTMLElement, message: ChatMessage): Promise<void> {
		await this.renderAssistantResponse(contentEl, message);
		await this.renderThinkingSection(contentEl, message);
		contentEl.addClass('local-llm-selectable-content');
	}

	private async renderAssistantResponse(contentEl: HTMLElement, message: ChatMessage): Promise<void> {
		let responseEl = contentEl.querySelector('.local-llm-assistant-response') as HTMLElement | null;
		if (!responseEl) {
			responseEl = contentEl.createEl('div', {
				cls: 'local-llm-assistant-response'
			});
		}

		responseEl.empty();
		await MarkdownRenderer.render(
			this.app,
			message.content,
			responseEl,
			'',
			this
		);

		if (message.isStreaming) {
			responseEl.createEl('span', {
				cls: 'streaming-cursor',
				text: '▋'
			});
		}

		const thinkingContainer = contentEl.querySelector('.local-llm-thinking-container') as HTMLElement | null;
		if (thinkingContainer && responseEl.nextSibling !== thinkingContainer) {
			contentEl.insertBefore(responseEl, thinkingContainer);
		}
	}

	private getOrCreateThinkingViewState(message: ChatMessage): ThinkingViewState {
		const existing = this.thinkingViewState.get(message.id);
		if (existing) {
			return existing;
		}

		const created: ThinkingViewState = {
			expanded: !!message.isStreaming,
			stickToBottom: true
		};
		this.thinkingViewState.set(message.id, created);
		return created;
	}

	private isThinkingPreviewNearBottom(previewEl: HTMLElement): boolean {
		const distanceFromBottom = previewEl.scrollHeight - previewEl.clientHeight - previewEl.scrollTop;
		return distanceFromBottom <= 24;
	}

	private getOrCreateThinkingPanelElements(contentEl: HTMLElement, messageId: string): ThinkingPanelElements {
		let containerEl = contentEl.querySelector('.local-llm-thinking-container') as HTMLElement | null;
		if (!containerEl) {
			containerEl = contentEl.createEl('div', {
				cls: 'local-llm-thinking-container'
			});
		}

		let summaryRow = containerEl.querySelector('.local-llm-thinking-summary') as HTMLElement | null;
		if (!summaryRow) {
			summaryRow = containerEl.createEl('div', {
				cls: 'local-llm-thinking-summary'
			});
		}

		let statusEl = summaryRow.querySelector('.local-llm-thinking-status') as HTMLElement | null;
		if (!statusEl) {
			statusEl = summaryRow.createEl('span', {
				cls: 'local-llm-thinking-status'
			});
		}

		let summaryControls = summaryRow.querySelector('.local-llm-thinking-controls') as HTMLElement | null;
		if (!summaryControls) {
			summaryControls = summaryRow.createEl('div', {
				cls: 'local-llm-thinking-controls'
			});
		}

		let metaEl = summaryControls.querySelector('.local-llm-thinking-meta') as HTMLElement | null;
		if (!metaEl) {
			metaEl = summaryControls.createEl('span', {
				cls: 'local-llm-thinking-meta'
			});
		}

		let toggleButton = summaryControls.querySelector('.local-llm-thinking-toggle') as HTMLButtonElement | null;
		if (!toggleButton) {
			toggleButton = summaryControls.createEl('button', {
				cls: 'local-llm-thinking-toggle',
				attr: { type: 'button' }
			});
		}

		let previewEl = containerEl.querySelector('.local-llm-thinking-preview-markdown') as HTMLElement | null;
		if (!previewEl) {
			previewEl = containerEl.createEl('div', {
				cls: 'local-llm-thinking-preview-markdown'
			});
		}

		if (toggleButton.dataset.boundMessageId !== messageId) {
			toggleButton.dataset.boundMessageId = messageId;
			toggleButton.addEventListener('click', (event) => {
				event.preventDefault();
				event.stopPropagation();
				this.handleThinkingPanelToggle(messageId);
			});
		}

		if (previewEl.dataset.scrollBound !== 'true') {
			previewEl.dataset.scrollBound = 'true';
			previewEl.addEventListener('scroll', () => {
				const message = this.messages.find(m => m.id === messageId);
				if (!message) {
					return;
				}

				const state = this.getOrCreateThinkingViewState(message);
				state.stickToBottom = this.isThinkingPreviewNearBottom(previewEl as HTMLElement);
			});
		}

		return {
			statusEl,
			metaEl,
			toggleButton,
			previewEl
		};
	}

	private setThinkingPanelExpanded(elements: ThinkingPanelElements, expanded: boolean): void {
		elements.toggleButton.textContent = expanded ? 'Hide' : 'Show';
		if (expanded) {
			elements.previewEl.removeClass('local-llm-thinking-preview-hidden');
		} else {
			elements.previewEl.addClass('local-llm-thinking-preview-hidden');
		}
	}

	private handleThinkingPanelToggle(messageId: string): void {
		const message = this.messages.find(m => m.id === messageId);
		if (!message) {
			return;
		}

		const state = this.getOrCreateThinkingViewState(message);
		state.expanded = !state.expanded;

		const messageElement = this.messageContainer.querySelector(`[data-message-id="${messageId}"]`) as HTMLElement | null;
		const contentEl = messageElement?.querySelector('.local-llm-message-content') as HTMLElement | null;
		if (!contentEl) {
			return;
		}

		const panel = this.getOrCreateThinkingPanelElements(contentEl, messageId);
		this.setThinkingPanelExpanded(panel, state.expanded);

		if (state.expanded && state.stickToBottom) {
			panel.previewEl.scrollTop = panel.previewEl.scrollHeight;
		}
	}

	private async renderThinkingSection(contentEl: HTMLElement, message: ChatMessage): Promise<void> {
		const blocks = message.thinkingBlocks || [];
		const streamState = this.streamingThinkingState.get(message.id);
		const isThinkingActive = !!message.isStreaming && !!streamState?.inThinkBlock;
		if (blocks.length === 0 && !isThinkingActive) {
			const existingContainer = contentEl.querySelector('.local-llm-thinking-container') as HTMLElement | null;
			if (existingContainer) {
				existingContainer.remove();
			}
			this.thinkingViewState.delete(message.id);
			return;
		}

		const thinkingLines = this.getThinkingLines(blocks);
		const totalCharacters = blocks.reduce((sum, block) => sum + block.length, 0);
		const state = this.getOrCreateThinkingViewState(message);
		const panel = this.getOrCreateThinkingPanelElements(contentEl, message.id);
		const previousScrollTop = panel.previewEl.scrollTop;

		if (state.expanded) {
			state.stickToBottom = this.isThinkingPreviewNearBottom(panel.previewEl);
		}

		panel.statusEl.textContent = isThinkingActive ? 'Thinking...' : 'Thought process';
		panel.metaEl.textContent = `${totalCharacters.toLocaleString()} chars`;
		this.setThinkingPanelExpanded(panel, state.expanded);

		panel.previewEl.empty();
		for (const line of thinkingLines) {
			const lineEl = panel.previewEl.createEl('div', {
				cls: 'local-llm-thinking-preview-line'
			});
			await MarkdownRenderer.render(
				this.app,
				line,
				lineEl,
				'',
				this
			);
		}

		if (!state.expanded) {
			return;
		}

		if (state.stickToBottom) {
			panel.previewEl.scrollTop = panel.previewEl.scrollHeight;
			return;
		}

		panel.previewEl.scrollTop = Math.min(
			previousScrollTop,
			Math.max(0, panel.previewEl.scrollHeight - panel.previewEl.clientHeight)
		);
	}

	private getThinkingLines(blocks: string[]): string[] {
		if (blocks.length === 0) {
			return ['Analyzing...'];
		}

		const lines = blocks
			.join('\n')
			.replace(/\r/g, '')
			.split('\n')
			.map(line => line.trim())
			.filter(line => line.length > 0);

		if (lines.length === 0) {
			return ['Analyzing...'];
		}

		return lines;
	}

	private handleStreamingError(messageId: string, error: Error) {
		const message = this.messages.find(m => m.id === messageId);
		if (message) {
			message.content = error.message;
			message.isStreaming = false;
			message.thinkingBlocks = undefined;
			this.streamingThinkingState.delete(messageId);
			this.thinkingViewState.delete(messageId);
			this.pendingStreamingRender.delete(messageId);
			this.streamingRenderInFlight.delete(messageId);
			// Remove the existing message element and re-render
			const messageElement = this.messageContainer.querySelector(`[data-message-id="${messageId}"]`);
			if (messageElement) {
				messageElement.remove();
			}
			this.renderMessage(message);
		}
		LoggingUtility.error('Error calling local LLM:', error);
	}

	private async addMessage(message: ChatMessage): Promise<void> {
		this.messages.push(message);
		await this.renderMessage(message);
	}

	private removeMessage(messageId: string) {
		const messageElement = this.messageContainer.querySelector(`[data-message-id="${messageId}"]`);
		if (messageElement) {
			messageElement.remove();
		}
		this.messages = this.messages.filter(m => m.id !== messageId);
		this.streamingThinkingState.delete(messageId);
		this.thinkingViewState.delete(messageId);
		this.pendingStreamingRender.delete(messageId);
		this.streamingRenderInFlight.delete(messageId);
	}

	private async renderMessage(message: ChatMessage) {
		const messageEl = this.messageContainer.createEl('div', {
			cls: `local-llm-message local-llm-message-${message.role}`,
			attr: { 'data-message-id': message.id }
		});

		// Only the user's messages sit in a bubble; assistant replies are inline text.
		const contentParent = message.role === 'user'
			? messageEl.createEl('div', { cls: 'local-llm-message-bubble' })
			: messageEl;
		const contentEl = contentParent.createEl('div', {
			cls: 'local-llm-message-content'
		});

		// Render markdown for assistant messages, plain text for user messages.
		if (message.role === 'assistant') {
			await this.renderAssistantMessageContent(contentEl, message);

			// Add refresh button for installation messages (welcome messages with installation instructions)
			if (!message.isStreaming && message.id === 'welcome' && message.content.includes('Welcome to Private AI!')) {
				const refreshButton = messageEl.createEl('button', {
					cls: 'local-llm-refresh-button',
					text: '🔄 Test connection',
					attr: { 'aria-label': 'Test connection to LLM server', 'type': 'button' }
				});

				refreshButton.addEventListener('click', async () => {
					// Show loading state
					refreshButton.textContent = '🔄 Testing...';
					refreshButton.disabled = true;

					try {
						// Update LLM service with current settings
						this.updateLLMServiceFromSettings();

						// Check again; the instructions change if the problem did (e.g. server now up, but no model).
						const welcomeText = await ChatView.getWelcomeMessage(this.llmService);
						const connected = welcomeText === null;
						const welcomeMessage = this.messages.find(m => m.id === 'welcome');
						if (welcomeMessage && welcomeMessage.content !== welcomeText) {
							this.welcomeCheck++;
							await this.setWelcome(welcomeText);
						} else if (!connected) {
							refreshButton.textContent = '🔄 Test connection';
							refreshButton.disabled = false;
						}
						new Notice(connected
							? '✅ Connection successful! You can now start chatting.'
							: '❌ Not ready yet. Follow the steps in the chat and try again.', 3000);
					} catch (error) {
						LoggingUtility.error('Error testing connection:', error);
						new Notice('❌ Connection failed. Please check your server settings.', 3000);
						refreshButton.textContent = '🔄 Test connection';
						refreshButton.disabled = false;
					}
				});
			}
		} else {
			// Plain text for user messages
			contentEl.setText(message.content);
		}

		// Show used notes information for assistant messages
		if (message.role === 'assistant' && message.usedNotes && message.usedNotes.length > 0) {
			const deduplicatedNotes = this.deduplicateNotesByPath(message.usedNotes);

			const notesInfoEl = messageEl.createEl('div', {
				cls: 'local-llm-used-notes'
			});

			const notesHeader = notesInfoEl.createEl('div', {
				cls: 'local-llm-used-notes-header'
			});

			// Create header text
			const headerText = notesHeader.createEl('span', {
				text: `📚 Read ${deduplicatedNotes.length} note${deduplicatedNotes.length > 1 ? 's' : ''}:`
			});

			// Create toggle link
			const toggleLink = notesHeader.createEl('a', {
				cls: 'local-llm-context-toggle',
				text: this.plugin.settings.contextNotesVisible ? 'Hide' : 'Show'
			});

			// Add click handler for toggle
			toggleLink.addEventListener('click', async (e) => {
				e.preventDefault();
				const currentVisibility = this.plugin.settings.contextNotesVisible;
				const newVisibility = !currentVisibility;

				// Update setting
				this.plugin.settings.contextNotesVisible = newVisibility;
				await this.plugin.saveSettings();

				// Update toggle text
				toggleLink.textContent = newVisibility ? 'Hide' : 'Show';

				// Show/hide notes list
				if (newVisibility) {
					notesList.removeClass('local-llm-used-notes-list-hidden');
				} else {
					notesList.addClass('local-llm-used-notes-list-hidden');
				}
			});

			const notesList = notesInfoEl.createEl('div', {
				cls: `local-llm-used-notes-list ${this.plugin.settings.contextNotesVisible ? '' : 'local-llm-used-notes-list-hidden'}`
			});

			deduplicatedNotes.forEach(note => {
				const noteEl = notesList.createEl('div', {
					cls: 'local-llm-used-note-item'
				});

				const noteTitle = noteEl.createEl('span', {
					cls: 'local-llm-used-note-title',
					text: note.title
				});

				const notePath = noteEl.createEl('span', {
					cls: 'local-llm-used-note-path',
					text: ` (${note.path})`
				});

				// Make the note clickable to open it
				noteEl.addClass('local-llm-note-clickable');
				noteEl.addEventListener('click', () => {
					this.app.workspace.openLinkText(note.path, '', true);
				});
			});
		}

		// Actions row under the message. Its height is always reserved, so showing the
		// user bubble's copy button on hover never shifts the layout.
		const actionsEl = messageEl.createEl('div', {
			cls: 'local-llm-message-actions'
		});

		if (!message.isStreaming) {
			const copyButton = actionsEl.createEl('button', {
				cls: 'clickable-icon local-llm-copy-button',
				attr: { 'aria-label': 'Copy message', 'type': 'button' }
			});
			setIcon(copyButton, 'copy');

			copyButton.addEventListener('click', async () => {
				await navigator.clipboard.writeText(message.content);

				// Brief confirmation, then back to the copy icon.
				setIcon(copyButton, 'check');
				copyButton.classList.add('copied');

				setTimeout(() => {
					setIcon(copyButton, 'copy');
					copyButton.classList.remove('copied');
				}, 1000);
			});
		}

		const timestampEl = actionsEl.createEl('span', {
			cls: 'local-llm-message-timestamp'
		});

		timestampEl.setText(message.timestamp.toLocaleTimeString());

		// Scroll to bottom
		this.messageContainer.scrollTop = this.messageContainer.scrollHeight;
	}

	private deduplicateNotesByPath(notes: UsedNote[]): UsedNote[] {
		const seenPaths = new Set<string>();

		return notes.filter((note) => {
			if (seenPaths.has(note.path)) {
				return false;
			}
			seenPaths.add(note.path);
			return true;
		});
	}

	private stopStreaming() {
		if (this.currentAbortController) {
			this.currentAbortController.abort();
		}
		this.isStreaming = false;
		this.setSendButtonEnabled(true);
		this.showStopButton(false);
		this.currentAbortController = null;

		// Finalize the current streaming message as-is
		const streamingMessage = this.messages.find(m => m.isStreaming);
		if (streamingMessage) {
			streamingMessage.isStreaming = false;
			// Re-render the message to remove the streaming cursor and apply markdown
			this.finalizeStreamingMessage(streamingMessage.id);
		}
	}

	private async startNewChat() {
		// Stop any ongoing streaming
		if (this.isStreaming) {
			this.stopStreaming();
		}

		// Clear all messages and the agent's conversation
		this.chatAgent.reset();
		this.clearChatDisplay();
		this.chatId = null;
		this.chatCreatedAt = null;
		this.hideHistory();

		// Add new welcome message, checking the server the settings point at now
		this.updateLLMServiceFromSettings();
		await this.showWelcome();

		// Clear input field
		this.inputElement.value = '';
		this.inputElement.focus();
	}

	private clearChatDisplay(): void {
		this.messages = [];
		this.messageContainer.empty();
		this.streamingThinkingState.clear();
		this.thinkingViewState.clear();
		this.pendingStreamingRender.clear();
		this.streamingRenderInFlight.clear();
	}

	/** Writes this chat to the history (in the background), when saving is on and something was asked. */
	private saveChat(): void {
		const history = this.plugin.chatHistory;
		if (!history || this.plugin.settings.saveChatHistory === false) return;
		const messages: SavedChatMessage[] = this.messages
			.filter(m => m.id !== 'welcome' && !m.isStreaming)
			.map(m => ({
				id: m.id,
				role: m.role,
				content: m.content,
				timestamp: m.timestamp.toISOString(),
				...(m.usedNotes ? { usedNotes: m.usedNotes } : {}),
				...(m.thinkingBlocks ? { thinkingBlocks: m.thinkingBlocks } : {})
			}));
		if (!messages.some(m => m.role === 'user')) return;
		const now = new Date();
		this.chatId ??= newChatId(now);
		this.chatCreatedAt ??= now.toISOString();
		const chat: SavedChat = {
			version: 1,
			id: this.chatId,
			title: chatTitle(messages),
			createdAt: this.chatCreatedAt,
			updatedAt: now.toISOString(),
			messages,
			agentMessages: [...(this.chatAgent.messages ?? [])]
		};
		this.historySaved = this.historySaved
			.then(async () => {
				await history.save(chat);
				await history.prune(MAX_SAVED_CHATS);
			})
			.catch(error => LoggingUtility.error('Could not save the chat:', error));
	}

	private get historyOpen(): boolean {
		return this.historyPanel.classList.contains('local-llm-history-visible');
	}

	private hideHistory(): void {
		this.historyPanel.empty();
		this.historyPanel.removeClass('local-llm-history-visible');
		this.historyPanel.addClass('local-llm-history-hidden');
		this.messageContainer.removeClass('local-llm-messages-hidden');
	}

	private async toggleHistory(): Promise<void> {
		if (this.historyOpen) {
			this.hideHistory();
			return;
		}
		await this.showHistory();
	}

	/** Lists saved chats in the pane; clicking one reopens it. */
	private async showHistory(): Promise<void> {
		let chats: ChatSummary[] = [];
		try {
			await this.historySaved;
			await this.plugin.applyChatRetention?.();
			chats = (await this.plugin.chatHistory?.list()) ?? [];
		} catch (error) {
			LoggingUtility.error('Could not list saved chats:', error);
		}
		this.historyPanel.empty();
		this.historyPanel.removeClass('local-llm-history-hidden');
		this.historyPanel.addClass('local-llm-history-visible');
		this.messageContainer.addClass('local-llm-messages-hidden');

		const top = this.historyPanel.createEl('div', { cls: 'local-llm-history-top' });
		top.createEl('span', { cls: 'local-llm-history-heading', text: 'Saved chats' });
		const actions = top.createEl('div', { cls: 'local-llm-history-actions' });
		if (chats.length > 0) this.addClearAllButton(actions);
		const back = actions.createEl('button', { cls: 'local-llm-history-back', text: 'Back to chat', attr: { type: 'button' } });
		back.addEventListener('click', () => this.hideHistory());

		const keep = this.historyPanel.createEl('label', { cls: 'local-llm-history-retention' });
		keep.createEl('span', { text: 'Keep chats for' });
		const select = keep.createEl('select', { cls: 'dropdown local-llm-history-retention-select' });
		for (const choice of CHAT_RETENTION_CHOICES) select.createEl('option', { text: choice.label }).value = String(choice.days);
		select.value = String(this.plugin.settings.chatRetentionDays ?? 0);
		select.addEventListener('change', async () => {
			const removed = await this.plugin.setChatRetention(Number(select.value));
			if (removed > 0) new Notice(`Deleted ${removed} saved chat${removed === 1 ? '' : 's'} older than that.`);
			await this.showHistory();
		});

		if (chats.length === 0) {
			this.historyPanel.createEl('div', {
				cls: 'local-llm-history-empty',
				text: this.plugin.settings.saveChatHistory === false
					? 'Saving chats is turned off in settings.'
					: 'No saved chats yet. Chats are saved here after the first answer.'
			});
			return;
		}

		const list = this.historyPanel.createEl('div', { cls: 'local-llm-history-list' });
		for (const chat of chats) {
			const row = list.createEl('div', {
				cls: 'local-llm-history-item' + (chat.id === this.chatId ? ' is-current' : ''),
				attr: { 'data-chat-id': chat.id }
			});
			const open = row.createEl('button', { cls: 'local-llm-history-open', attr: { type: 'button', 'aria-label': `Open chat: ${chat.title}` } });
			open.createEl('div', { cls: 'local-llm-history-title', text: chat.title });
			open.createEl('div', {
				cls: 'local-llm-history-meta',
				text: `${new Date(chat.updatedAt).toLocaleString()} · ${chat.messageCount} message${chat.messageCount === 1 ? '' : 's'}`
			});
			open.addEventListener('click', async () => {
				await this.resumeChat(chat.id);
			});
			const remove = row.createEl('button', { cls: 'local-llm-history-delete', attr: { type: 'button', 'aria-label': 'Delete this chat' } });
			setIcon(remove, 'trash');
			remove.addEventListener('click', async () => {
				try {
					await this.plugin.chatHistory.delete(chat.id);
				} catch (error) {
					LoggingUtility.error('Could not delete the chat:', error);
				}
				if (chat.id === this.chatId) {
					this.chatId = null;
					this.chatCreatedAt = null;
				}
				await this.showHistory();
			});
		}
	}

	/** "Delete all" in the History header. Needs a second click, so one stray click can't wipe the history. */
	private addClearAllButton(parent: HTMLElement): void {
		const clearAll = parent.createEl('button', {
			cls: 'local-llm-history-clear mod-warning',
			text: 'Delete all',
			attr: { type: 'button', 'aria-label': 'Delete all saved chats' }
		});
		let armed = false;
		clearAll.addEventListener('click', async () => {
			if (!armed) {
				armed = true;
				clearAll.setText('Click again to delete');
				window.setTimeout(() => {
					if (!armed) return;
					armed = false;
					clearAll.setText('Delete all');
				}, 4000);
				return;
			}
			armed = false;
			let removed = 0;
			try {
				removed = await this.plugin.chatHistory.clear();
			} catch (error) {
				LoggingUtility.error('Could not delete saved chats:', error);
			}
			// The open chat was one of them, so keep it from being saved again under its old id.
			this.chatId = null;
			this.chatCreatedAt = null;
			new Notice(removed === 0 ? 'No saved chats to delete.' : `Deleted ${removed} saved chat${removed === 1 ? '' : 's'}.`);
			await this.showHistory();
		});
	}

	/** Reopens a saved chat: shows its messages and gives the agent its earlier context. */
	async resumeChat(id: string): Promise<void> {
		const chat = await this.plugin.chatHistory?.load(id);
		if (!chat) {
			new Notice('That chat could not be opened.', 3000);
			await this.showHistory();
			return;
		}
		if (this.isStreaming) this.stopStreaming();
		this.welcomeCheck++;
		this.clearChatDisplay();
		this.chatAgent.restore(chat.agentMessages as AgentMessage[]);
		this.chatId = chat.id;
		this.chatCreatedAt = chat.createdAt;
		this.hideHistory();
		for (const saved of chat.messages) {
			await this.addMessage({
				id: saved.id,
				role: saved.role,
				content: saved.content,
				timestamp: new Date(saved.timestamp),
				...(saved.usedNotes ? { usedNotes: saved.usedNotes } : {}),
				...(saved.thinkingBlocks ? { thinkingBlocks: saved.thinkingBlocks } : {})
			});
		}
		this.inputElement.value = '';
		this.inputElement.focus();
	}

	private copyEntireConversation() {
		// Filter out welcome message and format conversation
		const conversationMessages = this.messages
			.filter(m => m.id !== 'welcome')
			.map(m => {
				const timestamp = m.timestamp.toLocaleString();
				const role = m.role === 'user' ? 'You' : 'Assistant';
				return `[${timestamp}] ${role}:\n${m.content}\n`;
			});

		const conversationText = conversationMessages.join('\n---\n\n');

		// Copy to clipboard
		navigator.clipboard.writeText(conversationText).then(() => {
			new Notice('✅ Conversation copied to clipboard!', 2000);
		});
	}

	/** Resolves when the welcome message reflects the server check. For tests; nothing in the UI waits on it. */
	welcomeReady: Promise<void> = Promise.resolve();
	private welcomeCheck = 0;

	/**
	 * Checks the server in the background. The chat starts empty; a first message appears
	 * only when there is something the user has to do (start LM Studio, download a model).
	 */
	private async showWelcome(): Promise<void> {
		const check = ++this.welcomeCheck;
		this.welcomeReady = (async () => {
			let text: string | null;
			try {
				text = await ChatView.getWelcomeMessage(this.llmService);
			} catch (error) {
				LoggingUtility.warn('Could not build the welcome message:', error);
				text = setupInstructions();
			}
			// A newer chat or check has replaced this one.
			if (check !== this.welcomeCheck) return;
			await this.setWelcome(text);
		})();
	}

	/**
	 * Shows `text` as the first message, above anything already in the chat, or removes
	 * that message when there is nothing to say (null).
	 */
	private async setWelcome(text: string | null): Promise<void> {
		let message = this.messages.find(m => m.id === 'welcome');
		const previous = this.messageContainer.querySelector('[data-message-id="welcome"]');
		if (text === null) {
			this.messages = this.messages.filter(m => m.id !== 'welcome');
			previous?.remove();
			return;
		}
		if (message?.content === text) return;
		if (message) {
			message.content = text;
		} else {
			message = { id: 'welcome', role: 'assistant', content: text, timestamp: new Date() };
			this.messages.unshift(message);
		}
		await this.renderMessage(message);
		const rendered = this.messageContainer.querySelectorAll('[data-message-id="welcome"]');
		const fresh = rendered[rendered.length - 1];
		if (previous && previous !== fresh) previous.remove();
		if (fresh) this.messageContainer.prepend(fresh);
	}

	/**
	 * What to tell the user before they start: nothing (null) when the server is usable,
	 * otherwise what to do (start LM Studio, or download a model).
	 */
	private static async getWelcomeMessage(llmService: LLMService): Promise<string | null> {
		let status: ServerStatus | undefined;
		try {
			status = await llmService.getServerStatus?.();
		} catch (error) {
			LoggingUtility.warn('Could not check the LLM server:', error);
		}
		if (status?.state === 'ready') return null;
		if (status?.state === 'no-models') return welcomeNoModelsMessage();
		if (status?.state === 'offline') return setupInstructions();

		// A server that can't list its models: find out by asking it something.
		const testResult = await llmService.testConnection();
		return testResult.success ? null : setupInstructions();
	}
}
