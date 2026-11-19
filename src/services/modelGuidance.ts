/**
 * What the plugin tells the user when the local server or the model can't do what
 * was asked. Kept in one place so the chat, the notices and the tests agree.
 */

export interface RecommendedModel {
	/** Name to search for in LM Studio. */
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

const recommendedList = (indent = ''): string =>
	RECOMMENDED_MODELS.map((m) => `${indent}* \`${m.name}\` (${m.fits})`).join('\n');

const DOWNLOAD_STEPS = `1. In LM Studio, click **Discover** (the magnifying glass on the left).
2. Search for one of these models and click **Download**:
${recommendedList('   ')}
3. When the download finishes, come back here and send your message again. Private AI loads the model for you.`;

function serverAddress(endpoint: string): string {
	try {
		return new URL(endpoint).origin;
	} catch {
		return endpoint;
	}
}

/** Nothing answered at the endpoint: LM Studio is closed or its server is stopped. */
export function serverOfflineMessage(endpoint: string): string {
	return `## ⚠️ Can't reach LM Studio

Nothing is answering at \`${serverAddress(endpoint)}\`, so LM Studio is either not running or its local server is stopped.

1. Open **LM Studio** (get it from [lmstudio.ai](https://lmstudio.ai) if it isn't installed).
2. Click the **Developer** tab on the left and switch the server **Status** to running.
3. Check that the port there matches the API endpoint in the Private AI settings (the default is 1234).

Then send your message again.`;
}

/** The server is up, but there is no chat model on disk to load. */
export function noModelsMessage(): string {
	return `## 📥 Download a model first

LM Studio is running, but it has no chat model downloaded yet, so there is nothing to load.

${DOWNLOAD_STEPS}`;
}

/** The model in use was not trained to call tools, which the agent depends on. */
export function noToolSupportMessage(modelId: string): string {
	return `## ⚠️ This model can't use tools

\`${modelId}\` doesn't support tool use. Private AI needs a model that can call tools to search, read and change your notes.

Load a model that supports tool use in LM Studio, or pick one under **Model** in the Private AI settings. These work well:
${recommendedList()}`;
}

/** Notice text: the model in use has no vision input, so image text can't be read. */
export function noVisionMessage(modelId: string): string {
	return `${modelId} can't read images, so no image text was read. Load a vision model such as ${RECOMMENDED_MODELS[0].name} in LM Studio and try again.`;
}

/** Notice text for image processing when the server can't be used at all. */
export function imagesUnavailableMessage(reason: 'offline' | 'no-models'): string {
	return reason === 'offline'
		? `Can't read image text: LM Studio isn't running, or its local server is stopped.`
		: `Can't read image text: LM Studio has no model downloaded. Download a vision model such as ${RECOMMENDED_MODELS[0].name} first.`;
}

/** First-run instructions shown in the chat when the server can't be reached. */
export function setupInstructions(): string {
	return `## 🚀 Welcome to Private AI!

It looks like your local LLM server isn't running yet. Here's how to get started:

### Getting Started

1. **Download and install LM Studio** from [lmstudio.ai](https://lmstudio.ai)
2. **Download a model** from the Discover tab. We recommend:
${recommendedList('   ')}
3. **Start the local server**:
   * Click the **Developer** tab on the left
   * In the Status box in the top left, switch the server on
   * In the server settings, make sure CORS is enabled and the port is 1234

You don't need to load the model yourself: Private AI uses the model that is loaded, or loads one when you send your first message.

Once your server is running, click the test connection button below.`;
}

/** Shown in place of the greeting when the server is up but has no chat model. */
export function welcomeNoModelsMessage(): string {
	return `## 🚀 Welcome to Private AI!

LM Studio is running, but it has no chat model downloaded yet.

${DOWNLOAD_STEPS}

Once a model is downloaded, click the test connection button below.`;
}
