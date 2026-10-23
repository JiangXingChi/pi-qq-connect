/**
 * 模拟 QQ 开放平台：token 接口 + /gateway + 被动回复接口 + WebSocket 网关。
 * 只用于本地测试，不连接真实 QQ。
 */

import http from "node:http";

import { attachWsServer } from "./ws-server.mjs";

export async function startMockQq({ port = 0, heartbeatMs = 30_000, path = "/ws" } = {}) {
	const state = {
		tokenRequests: [],
		gatewayRequests: 0,
		identifies: [],
		resumes: [],
		heartbeats: 0,
		sends: [],
		typings: [],
		messageRequests: [],
		uploadPrepares: [],
		uploadParts: [],
		replySeqs: new Set(),
		replyCounts: new Map(),
		partFinishes: [],
		fileMerges: [],
		failNextSend: null,
	};
	let seq = 0;
	let conn = undefined;

	const server = http.createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			const rawBuf = Buffer.concat(chunks);
			const raw = rawBuf.toString("utf8");
			let body;
			try {
				body = raw ? JSON.parse(raw) : {};
			} catch {
				body = { raw };
			}

			const json = (status, payload) => {
				res.writeHead(status, { "Content-Type": "application/json" });
				res.end(JSON.stringify(payload));
			};

			if (url.pathname === "/app/getAppAccessToken" && req.method === "POST") {
				state.tokenRequests.push({ body, auth: req.headers.authorization });
				if (!body.appId || !body.clientSecret) return json(400, { code: 1000, message: "missing appId/clientSecret" });
				return json(200, { access_token: "mock-access-token", expires_in: "7200" });
			}

			if (url.pathname === "/gateway" && req.method === "GET") {
				state.gatewayRequests++;
				if (req.headers.authorization !== "QQBot mock-access-token") {
					return json(401, { code: 11244, message: "invalid token" });
				}
				return json(200, { url: `ws://127.0.0.1:${server.address().port}${path}` });
			}

			if (url.pathname === "/users/@me" && req.method === "GET") {
				return json(200, { id: "bot-1", username: "mock-bot" });
			}

			const prepMatch = url.pathname.match(/^\/v2\/(groups|users)\/([^/]+)\/upload_prepare$/);
			if (prepMatch && req.method === "POST") {
				const id = `upload-${state.uploadPrepares.length + 1}`;
				const size = Number(body.file_size) || 1;
				const block = Math.max(1, Math.ceil(size / 2));
				state.uploadPrepares.push({ body, id });
				return json(200, {
					upload_id: id,
					block_size: String(block),
					parts: [1, 2, 3].map((index) => ({
						index,
						presigned_url: `http://127.0.0.1:${server.address().port}/mock-upload/${id}/${index}`,
						block_size: String(block),
					})),
					upload_config: { concurrency: 1, retry_timeout: 300, retry_delay: 1 },
				});
			}

			const putMatch = url.pathname.match(/^\/mock-upload\/([^/]+)\/(\d+)$/);
			if (putMatch && req.method === "PUT") {
				state.uploadParts.push({ uploadId: putMatch[1], index: Number(putMatch[2]), bytes: rawBuf.length });
				return json(200, {});
			}

			const partMatch = url.pathname.match(/^\/v2\/(groups|users)\/([^/]+)\/upload_part_finish$/);
			if (partMatch && req.method === "POST") {
				state.partFinishes.push(body);
				return json(200, {});
			}

			const filesMatch = url.pathname.match(/^\/v2\/(groups|users)\/([^/]+)\/files$/);
			if (filesMatch && req.method === "POST") {
				state.fileMerges.push(body);
				return json(200, { file_uuid: "mock-file-uuid", file_info: `file-info-${state.fileMerges.length}`, ttl: 300 });
			}

			const sendMatch = url.pathname.match(/^\/v2\/(groups|users)\/([^/]+)\/messages$/);
			if (sendMatch && req.method === "POST") {
				const record = {
					type: sendMatch[1] === "groups" ? "group" : "private",
					openid: decodeURIComponent(sendMatch[2]),
					body,
					authorization: req.headers.authorization,
					at: Date.now(),
				};
				state.messageRequests.push(record);
				if (record.body?.msg_type === 6) {
					// 「正在输入」提示，不算回复
					state.typings.push(record);
					return json(200, { id: `typing-${state.typings.length}` });
				}
				if (state.failNextSend) {
					const failure = state.failNextSend;
					state.failNextSend = null;
					return json(failure.status ?? 400, failure.body ?? { code: 40054, message: "mock failure" });
				}
				// 真实平台：同一 (msg_id, msg_seq) 重复会失败；每条入站消息回复次数有上限
				const replyKey = `${record.body?.msg_id}:${record.body?.msg_seq}`;
				if (record.body?.msg_id && state.replySeqs.has(replyKey)) {
					return json(400, { code: 40054005, message: "消息被去重" });
				}
				if (record.body?.msg_id) {
					const used = (state.replyCounts.get(record.body.msg_id) ?? 0) + 1;
					const limit = record.type === "group" ? 5 : 4;
					if (used > limit) return json(400, { code: 22009, message: "msg limit exceed" });
					state.replySeqs.add(replyKey);
					state.replyCounts.set(record.body.msg_id, used);
				}
				state.sends.push(record);
				return json(200, { id: `sent-${state.sends.length}`, timestamp: String(Date.now()) });
			}

			json(404, { code: 404, message: `no route ${req.method} ${url.pathname}` });
		});
	});

	attachWsServer(server, {
		path,
		onConnection: (connection) => {
			conn = connection;
			connection.send(JSON.stringify({ op: 10, d: { heartbeat_interval: heartbeatMs } }));
			connection.onmessage = (raw) => {
				let payload;
				try {
					payload = JSON.parse(raw);
				} catch {
					return;
				}
				if (payload.op === 2) {
					state.identifies.push(payload.d);
					connection.send(JSON.stringify({
						op: 0,
						s: ++seq,
						t: "READY",
						d: { session_id: "mock-session", user: { id: "bot-1", username: "mock-bot" } },
					}));
				} else if (payload.op === 6) {
					state.resumes.push(payload.d);
					connection.send(JSON.stringify({ op: 0, s: ++seq, t: "RESUMED", d: {} }));
				} else if (payload.op === 1) {
					state.heartbeats++;
					connection.send(JSON.stringify({ op: 11 }));
				}
			};
		},
	});

	await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
	const actualPort = server.address().port;
	const base = `http://127.0.0.1:${actualPort}`;

	return {
		port: actualPort,
		base,
		wsUrl: `ws://127.0.0.1:${actualPort}${path}`,
		state,
		/** 让网关推送一条事件 */
		dispatch(type, data, id) {
			if (!conn || conn.closed) throw new Error("mock gateway 没有连接");
			conn.send(JSON.stringify({ op: 0, s: ++seq, t: type, d: data, ...(id ? { id } : {}) }));
		},
		get connected() {
			return Boolean(conn && !conn.closed);
		},
		/** 断开当前网关连接（模拟网络故障） */
		dropConnection() {
			conn?.close();
		},
		async stop() {
			for (const socket of [conn]) socket?.close();
			await new Promise((resolve) => server.close(resolve));
		},
	};
}

export function groupAtEvent({ msgId, groupOpenId, memberOpenId, content, attachments }) {
	return {
		id: msgId,
		content,
		group_openid: groupOpenId,
		author: { member_openid: memberOpenId },
		timestamp: new Date().toISOString(),
		...(attachments ? { attachments } : {}),
	};
}

export function c2cEvent({ msgId, userOpenId, content, attachments }) {
	return {
		id: msgId,
		content,
		author: { user_openid: userOpenId },
		timestamp: new Date().toISOString(),
		...(attachments ? { attachments } : {}),
	};
}
