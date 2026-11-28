/**
 * What the plugin tells the user when the local server or the model can't do what
 * was asked. Kept in one place so the chat, the notices and the tests agree.
 * Every message names the server the user picked in settings (LM Studio by default).
 */
import { ServerProfile, ServerType, serverProfile } from './localServers';

export interface RecommendedModel {
	/** Name to search for in LM Studio (Ollama uses its own tag, see localServers). */
	name: string;
	/** Which machines it suits. */
	fits: string;
}

/**
 * Models that can use tools and read images, sized for Apple-silicon MacBooks
 * (M1 or later) and similar PCs. The first one is the default suggestion.
 */
export const RECOMMENDED_MODELS: RecommendedModel[] = [
	{ name: 'Gemma 4 E4B', fits: 'recommended; for 16 GB of memory or more' },
	{ name: 'Gemma 4 E2B', fits: 'smaller and faster; for 8 GB of memory, such as a base MacBook Air M1' },
];

type ServerArg = ServerType | ServerProfile | undefined;

const profileOf = (server: ServerArg): ServerProfile =>
	typeof server === 'object' && server ? server : serverProfile(server);

const recommendedList = (server: ServerProfile, indent = ''): string =>
	RECOMMENDED_MODELS.map((m) => `${indent}* \`${server.modelName(m.name)}\` (${m.fits})`).join('\n');

const numbered = (steps: string[]): string => steps.map((s, i) => `${i + 1}. ${s}`).join('\n');

const downloadSteps = (server: ServerProfile): string => numbered(server.downloadSteps(recommendedList(server, '   ')));

function serverAddress(endpoint: string): string {
	try {
		return new URL(endpoint).origin;
	} catch {
		return endpoint;
	}
}

const capitalized = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** Nothing answered at the endpoint: the server app is closed or its server is stopped. */
export function serverOfflineMessage(endpoint: string, server?: ServerArg): string {
	const p = profileOf(server);
	return `## ⚠️ Can't reach ${p.name}

Nothing is answering at \`${serverAddress(endpoint)}\`, so ${p.name} is either not running or its local server is stopped.

${numbered(p.startSteps)}

Then send your message again.`;
}

/** The server is up, but there is no chat model on disk to load. */
export function noModelsMessage(server?: ServerArg): string {
	const p = profileOf(server);
	return `## 📥 Download a model first

${capitalized(p.name)} is running, but it has no chat model downloaded yet, so there is nothing to load.

${downloadSteps(p)}`;
}

/** The model in use was not trained to call tools, which the agent depends on. */
export function noToolSupportMessage(modelId: string, server?: ServerArg): string {
	const p = profileOf(server);
	return `## ⚠️ This model can't use tools

\`${modelId}\` doesn't support tool use. Private AI needs a model that can call tools to search, read and change your notes.

${p.switchModelHint} These work well:
${recommendedList(p)}`;
}

/** Notice text: the model in use has no vision input, so image text can't be read. */
export function noVisionMessage(modelId: string, server?: ServerArg): string {
	const p = profileOf(server);
	return `${modelId} can't read images, so no image text was read. Load a vision model such as ${p.modelName(RECOMMENDED_MODELS[0].name)} in ${p.name} and try again.`;
}

/** Notice text for image processing when the server can't be used at all. */
export function imagesUnavailableMessage(reason: 'offline' | 'no-models', server?: ServerArg): string {
	const p = profileOf(server);
	return reason === 'offline'
		? `Can't read image text: ${p.name} isn't running, or its local server is stopped.`
		: `Can't read image text: ${p.name} has no model downloaded. Download a vision model such as ${p.modelName(RECOMMENDED_MODELS[0].name)} first.`;
}

/**
 * Shown once per server and model when the context it is loaded with is too small for the
 * agent: its instructions and tools alone take a few thousand tokens.
 */
export function smallContextMessage(modelId: string, contextLength: number, server?: ServerArg): string {
	const p = profileOf(server);
	const how = p.type === 'ollama'
		? 'Raise Context length in the Ollama app settings (or set OLLAMA_CONTEXT_LENGTH) to 32k or more'
		: p.type === 'llamacpp'
			? 'Restart llama-server with -c 32768 or more'
			: `Load it with a context length of 32k or more in ${p.name}`;
	return `${modelId} is running with a ${contextLength.toLocaleString('en-US')}-token context, which leaves little room for your notes, so older messages are dropped quickly. ${how}.`;
}

/** First-run instructions shown in the chat when the server can't be reached. */
export function setupInstructions(server?: ServerArg): string {
	const p = profileOf(server);
	if (p.type === 'lmstudio') {
		return `## 🚀 Welcome to Private AI!

It looks like your local LLM server isn't running yet. Here's how to get started:

### Getting Started

1. **Download and install LM Studio** from [lmstudio.ai](https://lmstudio.ai)
2. **Download a model** from the Discover tab. We recommend:
${recommendedList(p, '   ')}
3. **Start the local server**:
   * Click the **Developer** tab on the left
   * In the Status box in the top left, switch the server on
   * In the server settings, make sure CORS is enabled and the port is 1234

${p.loadNote}

Private AI also works with Ollama, llama.cpp and Jan: pick yours under **Local server** in the Private AI settings.

Once your server is running, click the test connection button below.`;
	}
	return `## 🚀 Welcome to Private AI!

It looks like ${p.name} isn't running yet. Here's how to get started:

### Getting Started

${numbered(p.startSteps)}

### Get a model

${downloadSteps(p)}

${p.loadNote}

Once your server is running, click the test connection button below.`;
}

/** Shown in place of the greeting when the server is up but has no chat model. */
export function welcomeNoModelsMessage(server?: ServerArg): string {
	const p = profileOf(server);
	return `## 🚀 Welcome to Private AI!

${capitalized(p.name)} is running, but it has no chat model downloaded yet.

${downloadSteps(p)}

Once a model is downloaded, click the test connection button below.`;
}
