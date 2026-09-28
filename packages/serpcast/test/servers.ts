// Local servers for the transport tests: an HTTP/2 TLS server that also keeps
// the raw client bytes (to read the HEADERS frame flags), an HTTP CONNECT proxy
// and a SOCKS5 proxy that record what they were asked for.

import {readFileSync} from 'node:fs';
import http2 from 'node:http2';
import net from 'node:net';
import {Duplex} from 'node:stream';
import tls from 'node:tls';
import {fileURLToPath} from 'node:url';

const fixture = (name: string) =>
	fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
/** The self-signed certificate (CN and SAN `localhost`) the test server uses; pass as `caPath`. */
export const CA_PATH = fixture('localhost-cert.pem');

export interface H2Server {
	port: number;
	/** Every TCP connection accepted. */
	connections: number;
	/** The raw bytes each connection's client sent (decrypted). */
	received: Buffer[][];
	close(): Promise<void>;
}

export async function startH2Server(
	handler: (
		req: http2.Http2ServerRequest,
		res: http2.Http2ServerResponse,
	) => void,
): Promise<H2Server> {
	const h2 = http2.createServer();
	h2.on('request', handler);
	const sockets = new Set<net.Socket>();
	const server: H2Server = {
		port: 0,
		connections: 0,
		received: [],
		close: async () => {},
	};
	const tlsServer = tls.createServer(
		{
			key: readFileSync(fixture('localhost-key.pem')),
			cert: readFileSync(CA_PATH),
			ALPNProtocols: ['h2'],
		},
		(socket) => {
			const bytes: Buffer[] = [];
			server.received.push(bytes);
			const tee = new Duplex({
				read() {},
				write(chunk, _encoding, callback) {
					socket.write(chunk, callback);
				},
				final(callback) {
					socket.end();
					callback();
				},
			});
			socket.on('data', (chunk: Buffer) => {
				bytes.push(chunk);
				tee.push(chunk);
			});
			socket.on('end', () => tee.push(null));
			socket.on('error', () => tee.destroy());
			tee.on('error', () => socket.destroy());
			h2.emit('connection', tee);
		},
	);
	tlsServer.on('connection', (socket) => {
		server.connections++;
		sockets.add(socket);
		socket.on('close', () => sockets.delete(socket));
	});
	await new Promise<void>((resolve) => tlsServer.listen(0, resolve));
	server.port = (tlsServer.address() as net.AddressInfo).port;
	server.close = () =>
		new Promise((resolve) => {
			for (const socket of sockets) socket.destroy();
			tlsServer.close(() => resolve());
		});
	return server;
}

/** The first HTTP/2 HEADERS frame a client sent: flags and priority fields. */
export function firstHeadersFrame(bytes: Buffer[]) {
	const data = Buffer.concat(bytes);
	let offset = 24; // client connection preface
	while (offset + 9 <= data.length) {
		const length = data.readUIntBE(offset, 3);
		const type = data[offset + 3];
		const flags = data[offset + 4]!;
		if (type === 1) {
			let p = offset + 9;
			if (flags & 0x8) p += 1; // PADDED
			const priority = flags & 0x20;
			return {
				flags,
				length,
				exclusive: priority ? data[p]! >> 7 === 1 : undefined,
				weight: priority ? data[p + 4]! + 1 : undefined,
			};
		}
		offset += 9 + length;
	}
	return undefined;
}

export interface RecordingProxy {
	port: number;
	/** What each client asked to reach: CONNECT authority, or SOCKS address type and host. */
	requests: {atyp?: number; host: string; port: number}[];
	close(): Promise<void>;
}

function tunnel(
	client: net.Socket,
	host: string,
	port: number,
	onOpen: () => void,
) {
	const upstream = net.connect(
		port,
		host === 'localhost' ? '127.0.0.1' : host,
		() => {
			onOpen();
			client.pipe(upstream).pipe(client);
		},
	);
	upstream.on('error', () => client.destroy());
	client.on('error', () => upstream.destroy());
}

async function listen(
	server: net.Server,
	proxy: RecordingProxy,
): Promise<RecordingProxy> {
	const sockets = new Set<net.Socket>();
	server.on('connection', (socket) => {
		sockets.add(socket);
		socket.on('close', () => sockets.delete(socket));
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	proxy.port = (server.address() as net.AddressInfo).port;
	proxy.close = () =>
		new Promise((resolve) => {
			for (const socket of sockets) socket.destroy();
			server.close(() => resolve());
		});
	return proxy;
}

/** An HTTP proxy that only tunnels (CONNECT). */
export function startConnectProxy(): Promise<RecordingProxy> {
	const proxy: RecordingProxy = {port: 0, requests: [], close: async () => {}};
	const server = net.createServer((client) => {
		let head = '';
		const onData = (chunk: Buffer) => {
			head += chunk.toString('latin1');
			const end = head.indexOf('\r\n\r\n');
			if (end < 0) return;
			client.off('data', onData);
			const [, host = '', port = '0'] =
				/^CONNECT \[?([^\]\s]+?)\]?:(\d+) /.exec(head) ?? [];
			proxy.requests.push({host, port: Number(port)});
			tunnel(client, host, Number(port), () =>
				client.write('HTTP/1.1 200 Connection established\r\n\r\n'),
			);
		};
		client.on('data', onData);
	});
	return listen(server, proxy);
}

/** A SOCKS5 proxy (no auth, CONNECT only). */
export function startSocksProxy(): Promise<RecordingProxy> {
	const proxy: RecordingProxy = {port: 0, requests: [], close: async () => {}};
	const server = net.createServer((client) => {
		let buffer = Buffer.alloc(0);
		let stage = 0;
		const onData = (chunk: Buffer) => {
			buffer = Buffer.concat([buffer, chunk]);
			if (
				stage === 0 &&
				buffer.length >= 2 &&
				buffer.length >= 2 + buffer[1]!
			) {
				buffer = buffer.subarray(2 + buffer[1]!);
				stage = 1;
				client.write(Buffer.from([5, 0]));
			}
			if (stage !== 1 || buffer.length < 5) return;
			const atyp = buffer[3]!;
			const addrLength = atyp === 1 ? 4 : atyp === 4 ? 16 : 1 + buffer[4]!;
			if (buffer.length < 4 + addrLength + 2) return;
			const addr = buffer.subarray(4, 4 + addrLength);
			const host =
				atyp === 3
					? addr.subarray(1).toString()
					: atyp === 1
						? [...addr].join('.')
						: (addr.toString('hex').match(/.{4}/g) ?? []).join(':');
			const port = buffer.readUInt16BE(4 + addrLength);
			stage = 2;
			client.off('data', onData);
			proxy.requests.push({atyp, host, port});
			tunnel(client, atyp === 4 ? '::1' : host, port, () =>
				client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])),
			);
		};
		client.on('data', onData);
	});
	return listen(server, proxy);
}
