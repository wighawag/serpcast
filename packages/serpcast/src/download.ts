// A plain GET of one file, for `serpcast install-libcurl` only (src/install.ts
// is its one importer): the library being installed cannot download itself, so
// this uses Node's own http and tls. Egress is the caller's `proxy` and nothing
// else: `http://` (CONNECT tunnel), `socks5://` (host names resolved LOCALLY)
// or `socks5h://` (resolved at the proxy), with optional user:password, as the
// transport accepts. Proxy environment variables are ignored, like the
// transport. Redirects are followed (GitHub release downloads redirect to a
// storage host), never from https to http.

import {lookup} from 'node:dns/promises';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';

export interface DownloadOptions {
	proxy?: string;
	/** Largest body accepted, in bytes. */
	maxBytes: number;
	/** Give up when the connection is silent this long, in ms. */
	idleTimeoutMs: number;
}

interface Proxy {
	scheme: 'http' | 'socks5' | 'socks5h';
	host: string;
	port: number;
	user?: string;
	password?: string;
}

const MAX_REDIRECTS = 10;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** GET `url`; resolves to the body and the final URL after redirects. */
export async function download(
	url: string,
	options: DownloadOptions,
): Promise<{url: string; body: Buffer}> {
	const proxy = options.proxy ? parseProxy(options.proxy) : undefined;
	let current = new URL(url);
	for (let hop = 0; ; hop++) {
		const response = await get(current, proxy, options);
		const location = response.headers.location;
		if (REDIRECTS.has(response.statusCode ?? 0) && location) {
			response.destroy();
			const next = new URL(location, current);
			if (hop >= MAX_REDIRECTS) throw new Error(`too many redirects (${url})`);
			if (next.protocol !== 'https:' && current.protocol === 'https:') {
				throw new Error(`refusing a redirect from ${current} to ${next}`);
			}
			current = next;
			continue;
		}
		if (response.statusCode !== 200) {
			response.destroy();
			throw new Error(`GET ${current}: HTTP ${response.statusCode}`);
		}
		const chunks: Buffer[] = [];
		let size = 0;
		for await (const chunk of response as AsyncIterable<Buffer>) {
			size += chunk.length;
			if (size > options.maxBytes) {
				response.destroy();
				throw new Error(`${current} is larger than ${options.maxBytes} bytes`);
			}
			chunks.push(chunk);
		}
		return {url: current.href, body: Buffer.concat(chunks)};
	}
}

/** The proxy URL without its credentials, for messages. */
export function describeProxy(proxy: string): string {
	const {scheme, host, port} = parseProxy(proxy);
	return `${scheme}://${host.includes(':') ? `[${host}]` : host}:${port}`;
}

function parseProxy(proxy: string): Proxy {
	let parsed: URL;
	try {
		parsed = new URL(proxy);
	} catch {
		throw new Error(`not a proxy URL: ${proxy}`);
	}
	const scheme = parsed.protocol.slice(0, -1);
	if (scheme !== 'http' && scheme !== 'socks5' && scheme !== 'socks5h') {
		throw new Error(
			`unsupported proxy scheme ${parsed.protocol} (use http://, socks5:// or socks5h://)`,
		);
	}
	return {
		scheme,
		host: parsed.hostname.replace(/^\[|\]$/g, ''),
		port: Number(parsed.port) || 1080, // libcurl's default proxy port
		user: parsed.username ? decodeURIComponent(parsed.username) : undefined,
		password: decodeURIComponent(parsed.password),
	};
}

async function get(
	url: URL,
	proxy: Proxy | undefined,
	options: DownloadOptions,
): Promise<http.IncomingMessage> {
	const host = url.hostname.replace(/^\[|\]$/g, '');
	const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
	if (url.protocol !== 'https:' && url.protocol !== 'http:') {
		throw new Error(`not an http(s) URL: ${url}`);
	}
	const raw = await tcp(proxy?.host ?? host, proxy?.port ?? port);
	const idle = (socket: net.Socket) =>
		socket.setTimeout(options.idleTimeoutMs, () =>
			socket.destroy(new Error(`no data for ${options.idleTimeoutMs} ms`)),
		);
	idle(raw);
	try {
		if (proxy?.scheme === 'http') await connectTunnel(raw, host, port, proxy);
		else if (proxy) await socksTunnel(raw, host, port, proxy);
	} catch (error) {
		raw.destroy();
		throw error;
	}
	let socket = raw;
	if (url.protocol === 'https:') {
		raw.setTimeout(0);
		socket = tls.connect({
			socket: raw,
			host,
			...(net.isIP(host) ? {} : {servername: host}),
		});
		idle(socket);
	}
	return new Promise((resolve, reject) => {
		const request = http.request({
			method: 'GET',
			path: url.pathname + url.search,
			createConnection: () => socket,
			headers: {
				host: url.host,
				'user-agent': 'serpcast',
				'accept-encoding': 'identity',
			},
		});
		request.on('response', resolve);
		request.on('error', reject);
		request.end();
	});
}

function tcp(host: string, port: number): Promise<net.Socket> {
	return new Promise((resolve, reject) => {
		const socket = net.connect(port, host);
		socket.once('connect', () => {
			socket.off('error', reject);
			resolve(socket);
		});
		socket.once('error', reject);
	});
}

/** Reads a proxy's handshake replies; the proxy sends nothing unasked after them. */
function reader(socket: net.Socket) {
	let buffer = Buffer.alloc(0);
	let wake = () => {};
	let failure: Error | undefined;
	const onData = (chunk: Buffer) => {
		buffer = Buffer.concat([buffer, chunk]);
		wake();
	};
	const onEnd = (error?: Error) => {
		failure = error ?? new Error('the proxy closed the connection');
		wake();
	};
	const onClose = () => onEnd();
	socket.on('data', onData);
	socket.on('error', onEnd);
	socket.on('end', onClose);
	const until = async (enough: () => number): Promise<Buffer> => {
		for (let n = enough(); n < 0 || buffer.length < n; n = enough()) {
			if (failure) throw failure;
			await new Promise<void>((resolve) => (wake = resolve));
		}
		const n = enough();
		const out = buffer.subarray(0, n);
		buffer = buffer.subarray(n);
		return out;
	};
	return {
		take: (n: number) => until(() => n),
		line: () =>
			until(() => {
				const end = buffer.indexOf('\r\n\r\n');
				return end < 0 ? -1 : end + 4;
			}),
		done() {
			socket.off('data', onData).off('error', onEnd).off('end', onClose);
		},
	};
}

async function connectTunnel(
	socket: net.Socket,
	host: string,
	port: number,
	proxy: Proxy,
): Promise<void> {
	const authority = `${host.includes(':') ? `[${host}]` : host}:${port}`;
	const auth = proxy.user
		? `proxy-authorization: Basic ${Buffer.from(`${proxy.user}:${proxy.password}`).toString('base64')}\r\n`
		: '';
	const read = reader(socket);
	socket.write(
		`CONNECT ${authority} HTTP/1.1\r\nhost: ${authority}\r\n${auth}\r\n`,
	);
	const head = (await read.line()).toString('latin1');
	read.done();
	const status = /^HTTP\/\S+ (\d{3})/.exec(head)?.[1];
	if (status !== '200') {
		throw new Error(
			`the proxy refused to connect to ${authority}: ${head.split('\r\n')[0]}`,
		);
	}
}

async function socksTunnel(
	socket: net.Socket,
	host: string,
	port: number,
	proxy: Proxy,
): Promise<void> {
	const read = reader(socket);
	socket.write(Buffer.from(proxy.user ? [5, 2, 0, 2] : [5, 1, 0]));
	const [, method] = await read.take(2);
	if (method === 2 && proxy.user) {
		const user = Buffer.from(proxy.user);
		const password = Buffer.from(proxy.password ?? '');
		socket.write(
			Buffer.concat([
				Buffer.from([1, user.length]),
				user,
				Buffer.from([password.length]),
				password,
			]),
		);
		if ((await read.take(2))[1] !== 0)
			throw new Error('the SOCKS5 proxy rejected the credentials');
	} else if (method !== 0) {
		throw new Error(
			'the SOCKS5 proxy accepts none of the offered authentication methods',
		);
	}
	socket.write(
		Buffer.concat([
			Buffer.from([5, 1, 0]),
			await address(host, proxy),
			Buffer.from([port >> 8, port & 255]),
		]),
	);
	const reply = await read.take(5);
	if (reply[1] !== 0)
		throw new Error(
			`the SOCKS5 proxy refused to connect to ${host}:${port} (reply ${reply[1]})`,
		);
	const rest = reply[3] === 1 ? 4 : reply[3] === 4 ? 16 : reply[4]! + 1;
	await read.take(rest - 1 + 2);
	read.done();
}

/** The SOCKS5 address: a host name for socks5h, a locally resolved IP for socks5. */
async function address(host: string, proxy: Proxy): Promise<Buffer> {
	let ip = net.isIP(host) ? host : undefined;
	if (!ip && proxy.scheme === 'socks5') ip = (await lookup(host)).address;
	if (!ip) {
		const name = Buffer.from(host);
		return Buffer.concat([Buffer.from([3, name.length]), name]);
	}
	if (net.isIPv4(ip)) return Buffer.from([1, ...ip.split('.').map(Number)]);
	return Buffer.concat([Buffer.from([4]), ipv6(ip)]);
}

function ipv6(ip: string): Buffer {
	const [head = '', tail = ''] = ip.split('::');
	const parts = (s: string) => (s ? s.split(':') : []);
	const h = parts(head);
	const t = ip.includes('::') ? parts(tail) : [];
	const groups = [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
	const out = Buffer.alloc(16);
	groups.forEach((g, i) => out.writeUInt16BE(parseInt(g, 16), i * 2));
	return out;
}
