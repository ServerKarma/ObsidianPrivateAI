/**
 * The local AI servers Private AI knows how to talk to. All of them serve an
 * OpenAI-compatible /v1/chat/completions on this computer; what differs is the
 * default port, how they list models and report capabilities, and what the user
 * clicks or types to start one or download a model.
 *
 * Only servers the user runs and points the plugin at are ever contacted.
 */

export type ServerType = 'lmstudio' | 'ollama' | 'llamacpp' | 'jan' | 'openai';

export interface ServerProfile {
	type: ServerType;
	/** Shown in settings and messages, e.g. "LM Studio". */
	name: string;
	/** Where to get it. Empty for the generic option. */
	homepage: string;
	defaultEndpoint: string;
	/** Help under the API key setting. */
	apiKeyHelp: string;
	/** Steps to start the server, as a Markdown numbered list body (no trailing newline). */
	startSteps: string[];
	/** Steps to get a chat model, given the recommended-model bullets for this server. */
	downloadSteps: (recommended: string) => string[];
	/** How the user switches model on this server, for the "can't use tools" message. */
	switchModelHint: string;
	/** What to say about loading a model, after the steps. */
	loadNote: string;
	/** How a model is named on this server (search term or tag), per recommended model. */
	modelName: (lmStudioName: string) => string;
}

const OLLAMA_TAGS: Record<string, string> = {
	'Gemma 4 E4B': 'gemma4:e4b',
	'Gemma 4 E2B': 'gemma4:e2b',
};

const LM_STUDIO: ServerProfile = {
	type: 'lmstudio',
	name: 'LM Studio',
	homepage: 'https://lmstudio.ai',
	defaultEndpoint: 'http://localhost:1234/v1/chat/completions',
	apiKeyHelp: 'Optional API key sent as a Bearer token. To make one in LM Studio, open the Developer tab, then Server Settings, and click Manage Tokens.',
	startSteps: [
		'Open **LM Studio** (get it from [lmstudio.ai](https://lmstudio.ai) if it isn\'t installed).',
		'Click the **Developer** tab on the left and switch the server **Status** to running.',
		'Check that the port there matches the API endpoint in the Private AI settings (the default is 1234).',
	],
	downloadSteps: (recommended) => [
		'In LM Studio, click **Discover** (the magnifying glass on the left).',
		`Search for one of these models and click **Download**:\n${recommended}`,
		'When the download finishes, come back here and send your message again. Private AI loads the model for you.',
	],
	switchModelHint: 'Load a model that supports tool use in LM Studio, or pick one under **Model** in the Private AI settings.',
	loadNote: 'You don\'t need to load the model yourself: Private AI uses the model that is loaded, or loads one when you send your first message.',
	modelName: (name) => name,
};

const OLLAMA: ServerProfile = {
	type: 'ollama',
	name: 'Ollama',
	homepage: 'https://ollama.com',
	defaultEndpoint: 'http://localhost:11434/v1/chat/completions',
	apiKeyHelp: 'Ollama doesn\'t need an API key on this computer. Leave this empty unless you put a proxy that checks a Bearer token in front of it.',
	startSteps: [
		'Open the **Ollama** app (get it from [ollama.com](https://ollama.com) if it isn\'t installed), or run `ollama serve` in a terminal.',
		'Check that the API endpoint in the Private AI settings uses port 11434 (the Ollama default).',
	],
	downloadSteps: (recommended) => [
		`Download one of these models, either from the model picker in the Ollama app or by running \`ollama pull <name>\` in a terminal:\n${recommended}`,
		'When the download finishes, come back here and send your message again. Ollama loads the model for you.',
	],
	switchModelHint: 'Download a model that supports tools with `ollama pull`, then pick it under **Model** in the Private AI settings.',
	loadNote: 'You don\'t need to load the model yourself: Ollama loads it when you send your first message. For longer chats, raise **Context length** in the Ollama app settings (or set `OLLAMA_CONTEXT_LENGTH`) to 32k or more.',
	modelName: (name) => OLLAMA_TAGS[name] ?? name,
};

const LLAMA_CPP: ServerProfile = {
	type: 'llamacpp',
	name: 'llama.cpp',
	homepage: 'https://github.com/ggml-org/llama.cpp',
	defaultEndpoint: 'http://localhost:8080/v1/chat/completions',
	apiKeyHelp: 'Optional. Only needed if you started llama-server with --api-key; enter the same key here.',
	startSteps: [
		'Start **llama-server** with a model and tool calling turned on, for example `llama-server -m model.gguf --jinja -c 32768`.',
		'Check that the API endpoint in the Private AI settings uses its port (the default is 8080).',
	],
	downloadSteps: (recommended) => [
		`llama-server runs the one model you start it with. Download a GGUF of one of these models (for example from Hugging Face) and start llama-server with it:\n${recommended}`,
		'Then come back here and send your message again.',
	],
	switchModelHint: 'Restart llama-server with a model that supports tool use, and add `--jinja` so it can call tools.',
	loadNote: 'Start llama-server with `--jinja` so the model can use tools, and `-c 32768` or more for longer chats.',
	modelName: (name) => name,
};

const JAN: ServerProfile = {
	type: 'jan',
	name: 'Jan',
	homepage: 'https://jan.ai',
	defaultEndpoint: 'http://localhost:1337/v1/chat/completions',
	apiKeyHelp: 'If you set an API key in Jan under Settings, Local API Server, enter the same key here.',
	startSteps: [
		'Open **Jan** (get it from [jan.ai](https://jan.ai) if it isn\'t installed).',
		'Go to **Settings**, then **Local API Server**, check that **CORS** is on, and click **Start Server**. If you set an API key there, enter the same key in the Private AI settings.',
		'Check that the port there matches the API endpoint in the Private AI settings (the default is 1337).',
	],
	downloadSteps: (recommended) => [
		`In Jan, open the **Hub**, search for one of these models and click **Download**:\n${recommended}`,
		'Start the model in Jan, then come back here and send your message again.',
	],
	switchModelHint: 'Start a model that supports tool use in Jan, or pick one under **Model** in the Private AI settings.',
	loadNote: 'Start the model in Jan before you chat. Turn on tool use for it in the model settings if Jan asks.',
	modelName: (name) => name,
};

const OPENAI_COMPATIBLE: ServerProfile = {
	type: 'openai',
	name: 'your local server',
	homepage: '',
	defaultEndpoint: 'http://localhost:8000/v1/chat/completions',
	apiKeyHelp: 'Optional API key sent as a Bearer token, if your server asks for one.',
	startSteps: [
		'Start your local AI server and load a chat model that supports tool use.',
		'Check that the API endpoint in the Private AI settings points at its OpenAI-compatible `/v1/chat/completions` address.',
	],
	downloadSteps: (recommended) => [
		`Download one of these models in your server:\n${recommended}`,
		'Then come back here and send your message again.',
	],
	switchModelHint: 'Load a model that supports tool use in your server, or pick one under **Model** in the Private AI settings.',
	loadNote: 'Load a chat model that supports tool use in your server before you chat.',
	modelName: (name) => name,
};

export const SERVER_PROFILES: Record<ServerType, ServerProfile> = {
	lmstudio: LM_STUDIO,
	ollama: OLLAMA,
	llamacpp: LLAMA_CPP,
	jan: JAN,
	openai: OPENAI_COMPATIBLE,
};

/** Labels for the settings dropdown, in display order. */
export const SERVER_CHOICES: Array<{ type: ServerType; label: string }> = [
	{ type: 'lmstudio', label: 'LM Studio' },
	{ type: 'ollama', label: 'Ollama' },
	{ type: 'llamacpp', label: 'llama.cpp (llama-server)' },
	{ type: 'jan', label: 'Jan' },
	{ type: 'openai', label: 'Other OpenAI-compatible server' },
];

export function serverProfile(type: ServerType | undefined): ServerProfile {
	return SERVER_PROFILES[type ?? 'lmstudio'] ?? LM_STUDIO;
}

export function isServerType(value: unknown): value is ServerType {
	return typeof value === 'string' && value in SERVER_PROFILES;
}

/**
 * Best guess at the server behind an endpoint saved before this setting existed,
 * from its port. Anything unrecognised stays LM Studio, the old default.
 */
export function guessServerType(endpoint: string | undefined): ServerType {
	let port = '';
	try {
		port = new URL(endpoint ?? '').port;
	} catch {
		return 'lmstudio';
	}
	if (port === '11434') return 'ollama';
	if (port === '1337') return 'jan';
	if (port === '8080') return 'llamacpp';
	return 'lmstudio';
}

/** Whether the endpoint is still one of the presets, so switching server can replace it. */
export function isPresetEndpoint(endpoint: string | undefined): boolean {
	const trimmed = (endpoint ?? '').trim();
	return trimmed === '' || Object.values(SERVER_PROFILES).some((p) => p.defaultEndpoint === trimmed);
}
