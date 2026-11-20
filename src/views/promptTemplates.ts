/** A saved prompt the user can drop into the chat box by typing "/" (settings: promptTemplates). */
export interface PromptTemplate {
	/** Short name shown in the "/" menu and typed after the slash, e.g. "summarize". */
	name: string;
	/** The text that replaces what was typed. */
	prompt: string;
}

/**
 * The text after a leading "/" while the user is still typing a template name, or null
 * when the "/" menu should be closed: the box must start with "/" and hold no space or
 * line break yet, so "/summarize" opens the menu but "/summarize this" does not.
 */
export function slashQuery(input: string): string | null {
	const m = /^\/([^\s]*)$/.exec(input);
	return m ? m[1] : null;
}

/** Templates with a usable name and prompt, trimmed. */
export function cleanTemplates(templates: readonly PromptTemplate[] | undefined): PromptTemplate[] {
	return (templates ?? [])
		.filter((t) => t && typeof t.name === 'string' && typeof t.prompt === 'string')
		.map((t) => ({ name: t.name.trim(), prompt: t.prompt }))
		.filter((t) => t.name.length > 0 && t.prompt.trim().length > 0);
}

/**
 * Templates for the "/" menu, best first: names that start with the query, then names
 * that contain it, then (from three letters on, to keep short queries tidy) templates
 * whose prompt contains it. Case-insensitive.
 */
export function matchTemplates(query: string, templates: readonly PromptTemplate[] | undefined): PromptTemplate[] {
	const q = query.toLowerCase();
	const all = cleanTemplates(templates);
	if (!q) return all;
	const starts: PromptTemplate[] = [];
	const contains: PromptTemplate[] = [];
	const inPrompt: PromptTemplate[] = [];
	for (const t of all) {
		const name = t.name.toLowerCase();
		if (name.startsWith(q)) starts.push(t);
		else if (name.includes(q)) contains.push(t);
		else if (q.length >= 3 && t.prompt.toLowerCase().includes(q)) inPrompt.push(t);
	}
	return [...starts, ...contains, ...inPrompt];
}

/** One line of a template's prompt for the menu, cut to fit. */
export function previewPrompt(prompt: string, max = 80): string {
	const oneLine = prompt.replace(/\s+/g, ' ').trim();
	return oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine;
}
