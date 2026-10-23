/**
 * 测试用的最小 WebSocket 服务端（RFC 6455 握手 + 单帧文本收发）。
 * 只实现 mock QQ 网关需要的部分：文本帧、ping/pong、close。
 */

import crypto from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function encodeFrame(opcode, data) {
	const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8");
	const len = payload.length;
	let header;
	if (len < 126) {
		header = Buffer.from([0x80 | opcode, len]);
	} else if (len < 65536) {
		header = Buffer.alloc(4);
		header[0] = 0x80 | opcode;
		header[1] = 126;
		header.writeUInt16BE(len, 2);
	} else {
		header = Buffer.alloc(10);
		header[0] = 0x80 | opcode;
		header[1] = 127;
		header.writeBigUInt64BE(BigInt(len), 2);
	}
	return Buffer.concat([header, payload]);
}

export class WsConnection {
	constructor(socket) {
		this.socket = socket;
		this.buffer = Buffer.alloc(0);
		this.closed = false;
		this.onmessage = () => {};
		this.onclose = () => {};
		socket.on("data", (chunk) => this.#onData(chunk));
		socket.on("close", () => this.#closed());
		socket.on("error", () => this.#closed());
	}

	#closed() {
		if (this.closed) return;
		this.closed = true;
		this.onclose();
	}

	send(text) {
		if (this.closed) return;
		try {
			this.socket.write(encodeFrame(0x1, text));
		} catch {
			this.#closed();
		}
	}

	close() {
		if (this.closed) return;
		try {
			this.socket.write(encodeFrame(0x8, Buffer.alloc(0)));
			this.socket.end();
		} catch {
			// ignore
		}
		this.#closed();
	}

	#readFrame() {
		const buf = this.buffer;
		if (buf.length < 2) return null;
		const opcode = buf[0] & 0x0f;
		const masked = (buf[1] & 0x80) !== 0;
		let len = buf[1] & 0x7f;
		let offset = 2;
		if (len === 126) {
			if (buf.length < 4) return null;
			len = buf.readUInt16BE(2);
			offset = 4;
		} else if (len === 127) {
			if (buf.length < 10) return null;
			len = Number(buf.readBigUInt64BE(2));
			offset = 10;
		}
		const maskOffset = offset;
		if (masked) offset += 4;
		if (buf.length < offset + len) return null;
		let payload = buf.subarray(offset, offset + len);
		if (masked) {
			const mask = buf.subarray(maskOffset, maskOffset + 4);
			payload = Buffer.from(payload);
			for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
		}
		this.buffer = buf.subarray(offset + len);
		return { opcode, payload };
	}

	#onData(chunk) {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		for (;;) {
			const frame = this.#readFrame();
			if (!frame) return;
			if (frame.opcode === 0x1) this.onmessage(frame.payload.toString("utf8"));
			else if (frame.opcode === 0x8) {
				this.close();
				return;
			} else if (frame.opcode === 0x9) {
				try {
					this.socket.write(encodeFrame(0xa, frame.payload));
				} catch {
					// ignore
				}
			}
		}
	}
}

/**
 * 挂到已有 http.Server 上，返回 {path, connections}。
 */
export function attachWsServer(httpServer, { path = "/ws", onConnection } = {}) {
	const connections = new Set();
	httpServer.on("upgrade", (req, socket) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		if (url.pathname !== path) {
			socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
			return;
		}
		const key = req.headers["sec-websocket-key"];
		if (!key) {
			socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
			return;
		}
		const accept = crypto.createHash("sha1").update(key + GUID).digest("base64");
		socket.write(
			[
				"HTTP/1.1 101 Switching Protocols",
				"Upgrade: websocket",
				"Connection: Upgrade",
				`Sec-WebSocket-Accept: ${accept}`,
				"\r\n",
			].join("\r\n"),
		);
		const conn = new WsConnection(socket);
		connections.add(conn);
		conn.onclose = () => connections.delete(conn);
		onConnection?.(conn, req);
	});
	return { connections };
}
