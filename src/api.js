/**
 * QQ Bot HTTP 接口：网关地址、被动回复（群/单聊）、机器人自身信息。
 *
 * 被动回复：{ content, msg_type: 0, msg_id, msg_seq }
 *   群：POST /v2/groups/{group_openid}/messages
 *   单聊：POST /v2/users/{openid}/messages
 * msg_id 来自入站事件 d.id；同一 (msg_id, msg_seq) 重复发送会被拒绝，所以 seq 必须在同一 msg_id 下唯一。
 */

const PROD_BASE = "https://api.bot.qq.com";
const SANDBOX_BASE = "https://sandbox.api.sgroup.qq.com";
const TIMEOUT_MS = 15_000;

export class QqApiError extends Error {
	constructor(message, { status = 0, code, traceId, body } = {}) {
		super(message);
		this.name = "QqApiError";
		this.status = status;
		this.code = code;
		this.traceId = traceId;
		this.body = body;
	}
}

export class QqApi {
	constructor({ auth, sandbox = false, endpoints = {}, log }) {
		this.auth = auth;
		this.base = (endpoints.api || (sandbox ? SANDBOX_BASE : PROD_BASE)).replace(/\/+$/, "");
		this.gatewayOverride = endpoints.gateway || "";
		this.log = log;
	}

	async getGatewayUrl() {
		if (this.gatewayOverride) return this.gatewayOverride;
		const body = await this.request("GET", "/gateway");
		if (!body?.url) throw new QqApiError("网关接口没有返回 url", { body });
		return body.url;
	}

	async getBotInfo() {
		return this.request("GET", "/users/@me");
	}

	/**
	 * 被动回复一条文本。
	 * @param {{type:"group"|"private", openid:string}} target
	 * @param {string} content
	 * @param {{msgId:string, msgSeq:number}} reply
	 */
	async sendText(target, content, { msgId, msgSeq }) {
		return this.request("POST", this.#messagesPath(target), {
			content,
			msg_type: 0,
			msg_id: msgId,
			msg_seq: msgSeq,
		});
	}

	/**
	 * 单聊「正在输入」提示（msg_type=6）。QQ 目前只支持 C2C，群聊调用会被忽略。
	 * 需要带上触发消息的 msg_id 和唯一 msg_seq。
	 */
	async sendTyping(target, { msgId, msgSeq, seconds = 60 }) {
		if (target.type !== "private") return null;
		return this.request("POST", this.#messagesPath(target), {
			msg_type: 6,
			msg_id: msgId,
			msg_seq: msgSeq,
			input_notify: { input_type: 1, input_second: Math.min(Math.max(seconds, 1), 60) },
		});
	}

	/** Markdown 被动回复；平台不允许时调用方回退到 sendText。 */
	async sendMarkdown(target, content, { msgId, msgSeq }) {
		const body = {
			markdown: { content },
			msg_type: 2,
			msg_id: msgId,
			msg_seq: msgSeq,
		};
		// 官方文档：群聊即使发 Markdown 也要带 content
		if (target.type === "group") body.content = " ";
		return this.request("POST", this.#messagesPath(target), body);
	}

	/** 富媒体：msg_type=7 + media.file_info，仍走被动回复。 */
	async sendMedia(target, fileInfo, { msgId, msgSeq }) {
		return this.request("POST", this.#messagesPath(target), {
			msg_type: 7,
			media: { file_info: fileInfo },
			msg_id: msgId,
			msg_seq: msgSeq,
		});
	}

	/** 分片上传第 1 步：拿 upload_id、block_size 和各分片预签名 URL。 */
	async uploadPrepare(target, { fileType, fileSize, fileName, md5, sha1, md5_10m }) {
		return this.request("POST", `${this.#uploadBase(target)}/upload_prepare`, {
			file_type: fileType,
			file_size: String(fileSize),
			file_name: fileName,
			md5,
			sha1,
			md5_10m,
		});
	}

	/** 分片上传第 2 步：通知某个分片已完成。 */
	async uploadPartFinish(target, { uploadId, index, blockSize, md5 }) {
		return this.request("POST", `${this.#uploadBase(target)}/upload_part_finish`, {
			upload_id: uploadId,
			part_index: index,
			block_size: String(blockSize),
			md5,
		});
	}

	/** 分片上传第 3 步：合并分片，返回 file_info。线上只传 upload_id，多带字段会 40093006。 */
	async finishUpload(target, { uploadId }) {
		return this.request("POST", `${this.#uploadBase(target)}/files`, {
			upload_id: uploadId,
		});
	}

	/** 预签名 URL 的 PUT 不带鉴权头，超时放宽到 60 秒。 */
	async putPresigned(url, buffer) {
		const res = await fetch(url, {
			method: "PUT",
			body: buffer,
			signal: AbortSignal.timeout(60_000),
		});
		if (!res.ok) {
			throw new QqApiError(`分片 PUT 失败（HTTP ${res.status}）`, { status: res.status });
		}
	}

	#uploadBase(target) {
		if (target.type === "group") return `/v2/groups/${encodeURIComponent(target.openid)}`;
		return `/v2/users/${encodeURIComponent(target.openid)}`;
	}

	#messagesPath(target) {
		if (target.type === "group") return `/v2/groups/${encodeURIComponent(target.openid)}/messages`;
		return `/v2/users/${encodeURIComponent(target.openid)}/messages`;
	}

	async request(method, path, body) {
		const token = await this.auth.getToken();
		const doFetch = async (bearer) => {
			const res = await fetch(this.base + path, {
				method,
				headers: {
					Authorization: `QQBot ${bearer}`,
					"Content-Type": "application/json",
					Accept: "application/json",
				},
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(TIMEOUT_MS),
			});
			const text = await res.text();
			let json;
			try {
				json = text ? JSON.parse(text) : {};
			} catch {
				json = { raw: text };
			}
			return { res, json };
		};

		let { res, json } = await doFetch(token);
		if (res.status === 401 || res.status === 403) {
			this.auth.invalidate();
			({ res, json } = await doFetch(await this.auth.getToken()));
		}
		const code = json?.err_code ?? json?.code;
		const traceId = json?.trace_id || res.headers.get("x-tps-trace-id") || undefined;
		if (!res.ok || (code !== undefined && Number(code) !== 0)) {
			const detail = [json?.message || json?.raw || res.statusText, code !== undefined ? `err_code ${code}` : "", traceId ? `trace ${traceId}` : ""]
				.filter(Boolean)
				.join(" · ");
			const err = new QqApiError(`${method} ${path} 失败（HTTP ${res.status}）：${detail}`, {
				status: res.status,
				code,
				traceId,
				body: json,
			});
			this.log?.warn(err.message);
			throw err;
		}
		return json;
	}
}
