/**
 * Obsidian tags read straight from a note's text: the `tags` (or `tag`) list in
 * YAML frontmatter and inline `#tags` in the body. Works on the file contents
 * alone, so it runs the same in Obsidian and in plain Node tests.
 */

/** A tag as Obsidian writes it, minus the "#": letters, digits, _, -, and / for nesting. */
const TAG_BODY = /[\p{L}\p{N}_\-/]+/u;
const INLINE_TAG = /(^|[\s(\[{,;])#([\p{L}\p{N}_\-/]+)/gu;

/** Lowercases a tag and strips a leading "#" and stray slashes, so "#Personal/" and "personal" compare equal. */
export function normalizeTag(tag: string): string {
	return tag.trim().replace(/^#+/, '').replace(/^\/+|\/+$/g, '').toLowerCase();
}

/** Obsidian needs at least one non-digit character, so "#2024" is not a tag. */
function isValidTag(tag: string): boolean {
	return tag.length > 0 && TAG_BODY.test(tag) && !/^[\d/]+$/.test(tag);
}

function frontmatterTags(yaml: string): string[] {
	const out: string[] = [];
	const lines = yaml.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const m = /^(tags?)\s*:\s*(.*)$/i.exec(lines[i]);
		if (!m) continue;
		const rest = m[2].trim();
		if (rest.length > 0) {
			// tags: [a, b]  or  tags: a, b  or  tags: a b
			const inner = rest.replace(/^\[|\]$/g, '');
			for (const part of inner.split(/[,\s]+/)) out.push(part.replace(/^["']|["']$/g, ''));
			continue;
		}
		// tags:\n  - a\n  - b
		for (let j = i + 1; j < lines.length; j++) {
			const item = /^\s*-\s*(.+?)\s*$/.exec(lines[j]);
			if (!item) break;
			out.push(item[1].replace(/^["']|["']$/g, ''));
			i = j;
		}
	}
	return out;
}

/** Splits off YAML frontmatter, if the note starts with one. */
function splitFrontmatter(content: string): { yaml: string; body: string } {
	const text = content.replace(/\r\n/g, '\n');
	if (!text.startsWith('---\n')) return { yaml: '', body: text };
	const end = text.indexOf('\n---', 4);
	if (end < 0) return { yaml: '', body: text };
	const after = text.indexOf('\n', end + 4);
	return { yaml: text.slice(4, end), body: after < 0 ? '' : text.slice(after + 1) };
}

/** Removes fenced and inline code so "#include" in a code sample is not read as a tag. */
function stripCode(body: string): string {
	return body.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '').replace(/`[^`\n]*`/g, '');
}

/** Every tag in a note, normalised (lowercase, no "#"), without duplicates, in first-seen order. */
export function extractTags(content: string): string[] {
	const { yaml, body } = splitFrontmatter(content);
	const found = frontmatterTags(yaml);
	for (const m of stripCode(body).matchAll(INLINE_TAG)) found.push(m[2]);
	const seen = new Set<string>();
	for (const raw of found) {
		const tag = normalizeTag(raw);
		if (isValidTag(tag)) seen.add(tag);
	}
	return [...seen];
}

/**
 * True when the note's tags include every wanted tag. Like Obsidian's tag search,
 * a parent tag matches its nested tags: "project" matches "project/garden".
 */
export function hasAllTags(noteTags: readonly string[], wanted: readonly string[]): boolean {
	return wanted.every((w) => {
		const tag = normalizeTag(w);
		return noteTags.some((t) => t === tag || t.startsWith(tag + '/'));
	});
}

/** Parses a model-supplied tag filter: "personal", "#a, #b" or ["a", "b"]. */
export function parseTagFilter(value: unknown): string[] {
	const parts = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,\s]+/) : [];
	return parts
		.filter((p): p is string => typeof p === 'string')
		.map(normalizeTag)
		.filter((t) => t.length > 0);
}
