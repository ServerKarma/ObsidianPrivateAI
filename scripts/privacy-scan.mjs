#!/usr/bin/env node
/**
 * Privacy scan of the shipped bundle: fails when main.js gains anything that
 * could send data off the device that nobody reviewed.
 *
 * Run after `npm run build` (which writes main.js and main.meta.json):
 *   node scripts/privacy-scan.mjs
 *
 * It checks the built bundle, not the source, so transitive dependencies and
 * dependency upgrades are covered. Each of these must be in
 * scripts/privacy-allowlist.json, with a reason:
 *   - every npm package that contributes code to main.js
 *   - every module main.js requires at runtime (Node built-ins, obsidian, ...)
 *   - every module that uses a network API (fetch, XMLHttpRequest, WebSocket, ...)
 *   - every host named in a URL anywhere in main.js
 *   - every module that mentions telemetry or analytics services
 * Some things fail no matter what the allowlist says: Node networking modules,
 * child processes, electron, and MCP network transports.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const bundlePath = path.resolve(root, args.find((a) => !a.startsWith('--')) ?? 'main.js');
const metaPath = bundlePath.replace(/\.js$/, '.meta.json');
const allow = JSON.parse(fs.readFileSync(path.join(root, 'scripts/privacy-allowlist.json'), 'utf8'));

const NEVER = [
	/^(node:)?(http|https|http2|net|tls|dgram|dns|child_process|cluster|worker_threads|inspector)$/,
	/^electron$/,
	/^@electron\//,
];
const NEVER_MODULES = /@modelcontextprotocol\/sdk\/dist\/(esm|cjs)\/(client|server)\/(streamableHttp|sse|stdio|websocket)\.js/;
const NETWORK_APIS = {
	fetch: /\bfetch\b/,
	XMLHttpRequest: /\bXMLHttpRequest\b/,
	WebSocket: /\bWebSocket\b/,
	EventSource: /\bEventSource\b/,
	sendBeacon: /\bsendBeacon\b/,
	requestUrl: /\brequestUrl\b/,
	request: /\bimport_obsidian\d*\.request\b/,
	RTCPeerConnection: /\bRTCPeerConnection\b/,
	Worker: /\bnew (Shared)?Worker\b/,
	importScripts: /\bimportScripts\b/,
	serviceWorker: /\bserviceWorker\b/,
	'window.open': /\bwindow\.open\b/,
	openExternal: /\bopenExternal\b/,
	'dynamic import': /(?<![\w$.])import\(\s*(?!["'][^"']+["']\s*\))[^)]/,
};
const TELEMETRY = /\b(telemetry|analytics|sentry|posthog|mixpanel|amplitude|datadog|opentelemetry|bugsnag|rollbar|logrocket|honeycomb|newrelic|segment\.io|google-analytics|googletagmanager|gtag\(|plausible|matomo|heap\.io|hotjar|fullstory)\b/i;
const URL_HOST = /\b(?:https?|wss?|ftp):\/\/([a-zA-Z0-9.-]+|\[[0-9a-fA-F:]+\])(?::\d+)?/g;

const failures = [];
const fail = (msg) => failures.push(msg);

if (!fs.existsSync(bundlePath) || !fs.existsSync(metaPath)) {
	console.error(`Missing ${path.relative(root, bundlePath)} or ${path.relative(root, metaPath)}. Run "npm run build" first.`);
	process.exit(2);
}
const bundle = fs.readFileSync(bundlePath, 'utf8');
const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
const output = Object.values(meta.outputs).find((o) => o.entryPoint || o.inputs);

// 1. Packages that ship code in main.js.
const packageBytes = {};
for (const [file, info] of Object.entries(output.inputs)) {
	if (!info.bytesInOutput) continue;
	const m = file.replace(/\\/g, '/').match(/node_modules\/((?:@[^/]+\/)?[^/]+)/);
	if (m) packageBytes[m[1]] = (packageBytes[m[1]] ?? 0) + info.bytesInOutput;
	if (NEVER_MODULES.test(file)) fail(`${file} is an MCP network transport. The MCP server must stay in-process.`);
}
for (const pkg of Object.keys(packageBytes)) {
	if (!allow.packages[pkg]) fail(`New package in main.js: ${pkg} (${packageBytes[pkg]} bytes). Review it for network access, then add it to scripts/privacy-allowlist.json "packages" with the reason it is safe.`);
}

// 2. Modules main.js loads at runtime.
const externals = new Set((output.imports ?? []).filter((i) => i.external).map((i) => i.path));
// Literal require()/import() calls (not ones inside generated-code strings, which ajv has).
for (const m of bundle.matchAll(/(?<![\w$.'"`])(?:require|import)\(\s*["']([^"']+)["']\s*\)/g)) externals.add(m[1]);
// Constant specifiers that a computed import() can load (pi-ai's env-api-keys does this).
for (const m of bundle.matchAll(/\b\w*SPECIFIER\w*\s*=\s*["']([^"']+)["']/g)) externals.add(m[1]);
for (const ext of externals) {
	if (NEVER.some((re) => re.test(ext))) fail(`main.js loads "${ext}", which can open network connections or run programs. This is never allowed.`);
	else if (!allow.externals[ext]) fail(`main.js loads "${ext}" at runtime. Review it, then add it to "externals" with a reason.`);
}

// Split main.js into modules using esbuild's "// path" markers (main.js is not minified).
const modules = [];
let current = { name: '(bundle header)', lines: [] };
for (const line of bundle.split('\n')) {
	const marker = line.match(/^\/\/ ((?:node_modules|src)\/\S+|[\w-]+-stub:\S+|[\w.-]+\.(?:ts|js|mjs|json|css))$/);
	if (marker) {
		modules.push(current);
		current = { name: marker[1].replace(/\\/g, '/'), lines: [] };
	} else current.lines.push(line);
}
modules.push(current);
if (modules.length < 20) fail('Could not find esbuild module markers in main.js (was it minified?). The scan needs the unminified production build.');

const report = { packages: packageBytes, externals: [...externals], networkApis: {}, hosts: {}, telemetry: {} };
for (const mod of modules) {
	const text = mod.lines.join('\n');
	// 3. Network APIs.
	const apis = Object.entries(NETWORK_APIS).filter(([, re]) => re.test(text)).map(([name]) => name);
	if (apis.length) {
		report.networkApis[mod.name] = apis;
		const allowed = allow.networkApis[mod.name]?.apis ?? [];
		const extra = apis.filter((a) => !allowed.includes(a));
		if (extra.length) fail(`${mod.name} uses ${extra.join(', ')}. Check where it sends data, then add it to "networkApis" with a reason.`);
	}
	// 4. Hosts.
	for (const m of text.matchAll(URL_HOST)) {
		const host = m[1].toLowerCase();
		(report.hosts[host] ??= new Set()).add(mod.name);
	}
	// 5. Telemetry and analytics.
	const t = text.match(TELEMETRY);
	if (t) {
		report.telemetry[mod.name] = t[0];
		if (!allow.telemetry[mod.name]) fail(`${mod.name} mentions "${t[0]}". Telemetry and analytics are not allowed; if this is a false positive, add it to "telemetry" with a reason.`);
	}
}
for (const [host, mods] of Object.entries(report.hosts)) {
	if (!allow.hosts[host]) fail(`New host in main.js: ${host} (in ${[...mods].join(', ')}). Check that nothing is sent there, then add it to "hosts" with a reason.`);
}

// Allowlist entries nothing uses any more, so the list stays honest.
const stale = [
	...Object.keys(allow.packages).filter((p) => !packageBytes[p]).map((p) => `packages.${p}`),
	...Object.keys(allow.hosts).filter((h) => !report.hosts[h]).map((h) => `hosts.${h}`),
	...Object.keys(allow.networkApis).filter((m) => !report.networkApis[m]).map((m) => `networkApis.${m}`),
];

if (args.includes('--report')) {
	const hosts = Object.fromEntries(Object.entries(report.hosts).map(([h, m]) => [h, [...m]]));
	console.log(JSON.stringify({ ...report, hosts }, null, 2));
}
const kb = (bundle.length / 1024).toFixed(0);
console.log(`Privacy scan of ${path.relative(root, bundlePath)} (${kb} KB): ${Object.keys(packageBytes).length} packages, ${externals.size} runtime modules, ${Object.keys(report.networkApis).length} modules with network APIs, ${Object.keys(report.hosts).length} hosts.`);
if (stale.length) console.log(`Allowlist entries no longer needed (remove them): ${stale.join(', ')}`);
if (failures.length) {
	console.error(`\nPrivacy scan FAILED (${failures.length}):`);
	for (const f of failures) console.error(`  - ${f}`);
	process.exit(1);
}
console.log('Privacy scan passed: nothing new in main.js can reach the network.');
