import { LoggingUtility } from '../utils/LoggingUtility';
import { requestUrl } from 'obsidian';

export interface LLMConfig {
	apiEndpoint: string;
	maxTokens?: number;
	temperature?: number;
	systemPrompt?: string;
	model?: string;
	apiKey?: string;
}

// Centralized error message function
function getLLMErrorMessage(error: Error, endpoint?: string): string {
	// Check if it's a network/connection error
	if (error.message.includes('Failed to fetch') ||
		error.message.includes('NetworkError') ||
		error.message.includes('ERR_NETWORK') ||
		error.message.includes('ERR_CONNECTION_REFUSED') ||
		error.message.includes('ERR_EMPTY_RESPONSE')) {
		return `It appears your local LLM server is not running.
* Check that LM Studio is running and a model is loaded
* Check that you started local server
* Check that Cross-Origin-Resource-Sharing CORS is enabled		
`;
	}

	// Check if it's a timeout error
	if (error.name === 'AbortError' && error.message.includes('timeout')) {
		return 'Request cancelled';
	}

	// Check if it's a server error (5xx)
	if (error.message.includes('500') || error.message.includes('502') ||
		error.message.includes('503') || error.message.includes('504')) {
		return 'Is your LLM server running? 500 error';
	}

	// For other errors, return a generic message
	return `## ⚠️ Connection Error

It appears your local LLM server is not running.

### Troubleshooting Steps
* Check that LM Studio is running and a model is loaded
* **In LM Studio, click the Local Server tab on the left hand side:**
    * Verify that the server is running
    * Verify that Cross-Origin-Resource-Sharing CORS is enabled
    * Verify that the port number matches that in the settings page of this plugin
`;
}

export interface ChatMessage {
	role: 'user' | 'assistant' | 'system';
	content: string | Array<{
		type: 'text' | 'image_url';
		text?: string;
		image_url?: {
			url: string;
			detail?: 'low' | 'high' | 'auto';
		};
	}>;
}

export interface ChatRequest {
	messages: ChatMessage[];
	max_tokens?: number;
	temperature?: number;
	stream?: boolean;
	model?: string;
}

export interface ChatResponse {
	choices: Array<{
		message: {
			content: string;
			role: string;
		};
		finish_reason: string;
	}>;
	usage?: {
		prompt_tokens: number;
		completion_tokens: number;
		total_tokens: number;
	};
}

export interface ModelData {
	id: string;
	object: string;
	created?: number;
	owned_by?: string;
}

export interface ModelsResponse {
	data: ModelData[];
	object: string;
}

export interface LMStudioRestModel {
	type?: 'llm' | 'embedding';
	key?: string;
	id?: string;
	display_name?: string;
	loaded_instances?: Array<{ id?: string }>;
	size_bytes?: number;
	capabilities?: { vision?: boolean; trained_for_tool_use?: boolean } | null;
}

/** A model the server lists; `loaded` is only known when LM Studio's REST API reports it. */
interface ListedModel {
	id: string;
	/** The model's catalog key, when it differs from a loaded instance's id. */
	key?: string;
	type?: 'llm' | 'embedding';
	loaded?: boolean;
	vision?: boolean;
	toolUse?: boolean;
	sizeBytes?: number;
}

/** A chat model the server offers. Capabilities are undefined when the server doesn't report them. */
export interface ChatModelInfo {
	id: string;
	loaded: boolean;
	vision?: boolean;
	toolUse?: boolean;
}

/**
 * What the local server can do right now:
 * - offline: nothing answers at the endpoint (LM Studio closed or its server stopped)
 * - no-models: it answers, but has no chat model downloaded
 * - unknown: it answers, but can't list its models (not LM Studio or OpenAI-compatible there)
 * - ready: `model` is the one a request would use
 */
export type ServerStatus =
	| { state: 'offline' }
	| { state: 'no-models' }
	| { state: 'unknown' }
	| { state: 'ready'; model: ChatModelInfo };

const isChatModel = (m: ListedModel): boolean => m.type !== 'embedding' && !m.id.toLowerCase().includes('embed');

/**
 * The model to use when the user hasn't picked one: a loaded model if there is one (so the
 * server isn't made to load another), otherwise the smallest downloaded model that can do
 * what is needed, which is the one most likely to fit in memory.
 */
function pickDefaultModel(chatModels: ListedModel[], need: 'tools' | 'vision'): ListedModel | undefined {
	const able = (m: ListedModel) => (need === 'vision' ? m.vision : m.toolUse) !== false;
	const loaded = chatModels.filter((m) => m.loaded);
	if (loaded.length > 0) return loaded.find(able) ?? loaded[0];
	const candidates = chatModels.some(able) ? chatModels.filter(able) : chatModels;
	return candidates.reduce<ListedModel | undefined>(
		(best, m) => (!best || (m.sizeBytes ?? Infinity) < (best.sizeBytes ?? Infinity) ? m : best),
		undefined,
	);
}

export interface LMStudioRestModelsResponse {
	models: LMStudioRestModel[];
}

export class LLMService {
	private config: LLMConfig;

	constructor(config: LLMConfig) {
		this.config = config;
	}

	private buildHeaders(): Record<string, string> {
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
		};

		if (this.config.apiKey && this.config.apiKey.trim().length > 0) {
			headers.Authorization = `Bearer ${this.config.apiKey.trim()}`;
		}

		return headers;
	}

	async sendMessage(message: string, conversationHistory: ChatMessage[] = []): Promise<string> {
		try {
			const messages: ChatMessage[] = [];

			// Add system prompt if configured
			if (this.config.systemPrompt && this.config.systemPrompt.trim()) {
				messages.push({ role: 'system', content: this.config.systemPrompt });
			}

			// Add conversation history and current message
			messages.push(...conversationHistory, { role: 'user', content: message });

			const request: ChatRequest = {
				messages,
				max_tokens: this.config.maxTokens || 1000,
				temperature: this.config.temperature || 0.7,
				stream: false
			};

			// Add model to request if specified
			if (this.config.model) {
				request.model = this.config.model;
			}

			LoggingUtility.log('Sending request to:', this.config.apiEndpoint);
			LoggingUtility.log('Request payload:', JSON.stringify(request, null, 2));

			const response = await this.makeAPIRequest(request);
			return response.choices[0]?.message?.content || 'No response content';
		} catch (error) {
			LoggingUtility.error('Error sending message to LLM:', error);
			throw error;
		}
	}

	/**
	 * Send a vision message with image and text
	 */
	async sendVisionMessage(text: string, imageBase64: string, conversationHistory: ChatMessage[] = []): Promise<string> {
		try {
			const messages: ChatMessage[] = [];

			// Add system prompt if configured
			if (this.config.systemPrompt && this.config.systemPrompt.trim()) {
				messages.push({ role: 'system', content: this.config.systemPrompt });
			}

			// Add conversation history
			messages.push(...conversationHistory);

			// Create vision message with image and text
			const visionMessage: ChatMessage = {
				role: 'user',
				content: [
					{
						type: 'text',
						text: text
					},
					{
						type: 'image_url',
						image_url: {
							url: imageBase64,
							detail: 'high'
						}
					}
				]
			};

			messages.push(visionMessage);

			const request: ChatRequest = {
				messages,
				max_tokens: this.config.maxTokens || 1000,
				temperature: this.config.temperature || 0.7,
				stream: false
			};

			if (this.config.model) {
				request.model = this.config.model;
			}

			LoggingUtility.log('Sending vision request to:', this.config.apiEndpoint);
			LoggingUtility.log('Vision request payload:', JSON.stringify(request, null, 2));

			const response = await this.makeAPIRequest(request);
			LoggingUtility.log('Raw vision response:', JSON.stringify(response.choices[0]?.message?.content, null, 2));
			return response.choices[0]?.message?.content || 'No response content';
		} catch (error) {
			LoggingUtility.error('Error sending vision message to LLM:', error);
			throw error;
		}
	}

	private async makeAPIRequest(request: ChatRequest): Promise<ChatResponse> {
		const headers = this.buildHeaders();

		LoggingUtility.log('Making API request to:', this.config.apiEndpoint);
		LoggingUtility.log('Headers:', headers);

		try {
			const response = await requestUrl({
				url: this.config.apiEndpoint,
				method: 'POST',
				headers,
				body: JSON.stringify(request)
			});

			LoggingUtility.log('Response status:', response.status);
			LoggingUtility.log('Response headers:', response.headers);

			if (response.status >= 400) {
				const errorText = response.text;
				LoggingUtility.error('API Error Response:', errorText);
				throw new Error(`API request failed: ${response.status} - ${errorText}`);
			}

			const responseData = response.json;
			LoggingUtility.log('Response data:', responseData);
			return responseData;
		} catch (error) {
			LoggingUtility.error('Fetch error details:', error);
			throw new Error(getLLMErrorMessage(error, this.config.apiEndpoint));
		}
	}

	async testConnection(): Promise<{ success: boolean; error?: string }> {
		try {
			LoggingUtility.log('Testing connection to:', this.config.apiEndpoint);

			// Create a simple test request asking for a smiley face
			const testRequest: ChatRequest = {
				messages: [{ role: 'user', content: 'Return a smiley face' }],
				max_tokens: 10,
				temperature: 0.1,
				stream: false
			};

			// Add model to test request if specified
			if (this.config.model) {
				testRequest.model = this.config.model;
			}

			const response = await this.makeAPIRequest(testRequest);

			// Log the actual response structure for debugging
			LoggingUtility.log('Connection test - full response structure:', JSON.stringify(response, null, 2));

			// Verify we got a response with content
			if (!response.choices || response.choices.length === 0) {
				throw new Error(`Invalid response structure from API - no choices array. Response: ${JSON.stringify(response)}`);
			}

			const firstChoice = response.choices[0];
			if (!firstChoice.message) {
				throw new Error(`Invalid response structure from API - no message in choice. Choice: ${JSON.stringify(firstChoice)}`);
			}

			// Some APIs might return empty content, which is still a valid connection
			const content = firstChoice.message.content;
			if (content === null || content === undefined) {
				LoggingUtility.warn('API returned null/undefined content, but connection appears successful');
			}

			LoggingUtility.log('Connection test successful, received response:', content);
			return { success: true };
		} catch (error) {
			LoggingUtility.error('Connection test failed:', error);
			return {
				success: false,
				error: getLLMErrorMessage(error, this.config.apiEndpoint)
			};
		}
	}

	/**
	 * Whether the server can be used, and which model a request would go to: the configured
	 * model, else one already loaded, else the default pick for what is needed.
	 */
	async getServerStatus(need: 'tools' | 'vision' = 'tools'): Promise<ServerStatus> {
		const catalog = await this.fetchModelCatalog();
		if (!catalog.reached) return { state: 'offline' };
		if (!catalog.listed) return { state: 'unknown' };
		const chatModels = catalog.models.filter(isChatModel);
		if (chatModels.length === 0) return { state: 'no-models' };
		const info = (m: ListedModel): ChatModelInfo => ({ id: m.id, loaded: !!m.loaded, vision: m.vision, toolUse: m.toolUse });
		const configured = this.config.model?.trim();
		if (configured) {
			const found = chatModels.find((m) => m.id === configured || m.key === configured);
			return { state: 'ready', model: found ? info(found) : { id: configured, loaded: false } };
		}
		return { state: 'ready', model: info(pickDefaultModel(chatModels, need) as ListedModel) };
	}

	/**
	 * The chat model to use when none is configured: one already loaded in LM Studio if
	 * there is one (so the server is not made to load another), else the smallest one
	 * that can use tools.
	 */
	async getDefaultChatModel(): Promise<string | undefined> {
		try {
			const models = await this.fetchAvailableModels();
			return pickDefaultModel(models.filter(isChatModel), 'tools')?.id;
		} catch (error) {
			LoggingUtility.warn('Could not determine a default chat model:', error);
			return undefined;
		}
	}

	// Method to get supported models (if the API supports it)
	async getAvailableModels(): Promise<string[]> {
		try {
			const models = await this.fetchAvailableModels();
			return models.map((model) => model.id);
		} catch (error) {
			LoggingUtility.error('Failed to fetch available models:', error);
			return [];
		}
	}

	async getAvailableEmbeddingModels(): Promise<string[]> {
		try {
			const models = await this.fetchAvailableModels();

			return models
				.filter(model => {
					if (model.type === 'embedding') {
						return true;
					}

					const id = model.id.toLowerCase();
					return id.includes('embedding') || id.includes('embed');
				})
				.map(model => model.id);
		} catch (error) {
			LoggingUtility.error('Failed to fetch available embedding models:', error);
			return [];
		}
	}

	private async fetchAvailableModels(): Promise<Array<ListedModel>> {
		const catalog = await this.fetchModelCatalog();
		if (catalog.models.length > 0) return catalog.models;
		throw new Error('Failed to fetch models from all known model endpoints');
	}

	/**
	 * Asks the server for its models. `reached` says whether anything answered at all, and
	 * `listed` whether an answer was a model list (possibly empty), so callers can tell a
	 * stopped server from one with nothing downloaded.
	 */
	private async fetchModelCatalog(): Promise<{ reached: boolean; listed: boolean; models: ListedModel[] }> {
		const headers = this.buildHeaders();
		let reached = false;
		let listed = false;

		for (const endpoint of this.getModelListEndpoints()) {
			try {
				LoggingUtility.log('Fetching models from:', endpoint);
				const response = await requestUrl({ url: endpoint, method: 'GET', headers, throw: false });
				reached = true;
				if (response.status >= 400) {
					LoggingUtility.warn(`Failed to fetch models from ${endpoint}: ${response.status}`);
					continue;
				}
				const payload = response.json as Partial<ModelsResponse & LMStudioRestModelsResponse> | null;
				if (!Array.isArray(payload?.data) && !Array.isArray(payload?.models)) continue;
				listed = true;
				const parsed = this.parseModelsResponse(payload);
				if (parsed.length > 0) return { reached, listed, models: parsed };
			} catch (error) {
				// An HTTP error still means a server is there; a network error means it isn't.
				if (typeof (error as { status?: unknown })?.status === 'number') reached = true;
				LoggingUtility.warn(`Failed to fetch models from ${endpoint}:`, error);
			}
		}

		return { reached, listed, models: [] };
	}

	private getModelListEndpoints(): string[] {
		try {
			const parsedUrl = new URL(this.config.apiEndpoint);
			const pathLower = parsedUrl.pathname.toLowerCase();

			const basePath =
				pathLower.includes('/v1/')
					? parsedUrl.pathname.substring(0, pathLower.indexOf('/v1/'))
					: '';

			return [
				`${parsedUrl.origin}${basePath}/api/v1/models`,
				`${parsedUrl.origin}${basePath}/v1/models`
			];
			} catch (error) {
				LoggingUtility.error('Error parsing URL for model endpoint:', error);
			const fallbackBase = this.config.apiEndpoint
				.replace('/chat/completions', '')
				.replace('/embeddings', '')
				.replace('/v1/models', '')
				.replace('/api/v1/models', '');

			return [
				`${fallbackBase}/api/v1/models`,
				`${fallbackBase}/v1/models`
			];
		}
	}

	private parseModelsResponse(payload: unknown): Array<ListedModel> {
		const modelMap = new Map<string, ListedModel>();
		const dataPayload = payload as Partial<ModelsResponse>;
		const lmStudioPayload = payload as Partial<LMStudioRestModelsResponse>;

		if (Array.isArray(dataPayload.data)) {
			dataPayload.data
				.map(model => model?.id)
				.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
				.forEach(id => {
					modelMap.set(id, { id });
				});
		}

		if (Array.isArray(lmStudioPayload.models)) {
			lmStudioPayload.models
				.map(model => {
					const instances = Array.isArray(model?.loaded_instances) ? model.loaded_instances : [];
					return {
						// A loaded instance's id is what the chat endpoint routes to without a reload.
						id: instances[0]?.id || model?.key || model?.id || model?.display_name || '',
						key: model?.key,
						type: model?.type,
						loaded: instances.length > 0,
						vision: model?.capabilities?.vision,
						toolUse: model?.capabilities?.trained_for_tool_use,
						sizeBytes: model?.size_bytes
					};
				})
				.forEach(model => {
					if (typeof model.id === 'string' && model.id.trim().length > 0) {
						modelMap.set(model.id, model);
					}
				});
		}

		return Array.from(modelMap.values());
	}

	// Method to validate configuration
	validateConfig(): { valid: boolean; errors: string[] } {
		const errors: string[] = [];

		if (!this.config.apiEndpoint) {
			errors.push('API endpoint is required');
		}

		// Validate URL format
		try {
			new URL(this.config.apiEndpoint);
			} catch (error) {
				LoggingUtility.error('Invalid API endpoint URL format:', error);
			errors.push('Invalid API endpoint URL format');
		}

		return {
			valid: errors.length === 0,
			errors
		};
	}
}

// Factory function to create LLM service
export function createLLMService(config: Partial<LLMConfig>): LLMService {
	const defaultConfig: LLMConfig = {
		apiEndpoint: 'http://localhost:1234/v1/chat/completions',
		...config,
	};

	return new LLMService(defaultConfig);
} 
