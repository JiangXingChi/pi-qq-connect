/**
 * QQ Bot WebSocket 网关客户端（零依赖，用 Node ≥22 的内置 WebSocket）。
 *
 * 流程：
 *   GET /gateway → wss://...
 *   收到 op10 Hello（d.heartbeat_interval 毫秒）→ 发 op2 Identify（或 op6 Resume）
 *   每 interval 发一次 op1 心跳（d = 最新 s）
 *   op0 Dispatch：READY 取 session_id；RESUMED 表示续接成功；其余转发给上层
 *   op7 服务端要求重连；op9 会话失效（清 session 重新 identify）
 *   断开后指数退避重连，有 session_id 时优先 resume
 */

const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_RESUME = 6;
const OP_RECONNECT = 7;
const OP_INVALID_SESSION = 9;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;

const INTENT_GROUP_AND_C2C = 1 << 25;
const MAX_BACKOFF_MS = 60_000;

/** 会话失效、必须重新 identify 的关闭码（4009 可续接，不在列，参考 Hermes）。 */
const SESSION_RESET_CLOSE_CODES = new Set([4006, 4007, ...Array.from({ length: 14 }, (_, i) => 4900 + i), 9001, 9005]);
const AUTH_FAIL_CLOSE_CODES = new Set([4004, 401]);
/** 不可恢复的关闭码：不再重连，直接报错。 */
const FATAL_CLOSE_CODES = new Map([
	[4001, "invalid opcode"],
	[4002, "invalid payload"],
	[4010, "invalid shard"],
	[4011, "sharding required"],
	[4012, "invalid API version"],
	[4013, "invalid intent"],
	[4014, "intent not authorized"],
	[4914, "offline/sandbox-only"],
	[4915, "banned"],
]);
const RATE_LIMIT_DELAY_MS = 60_000;
const QUICK_DISCONNECT_MS = 5_000;
const MAX_QUICK_DISCONNECTS = 3;

export class QqGateway {
	constructor({ auth, api, log, onEvent, onState, intents = INTENT_GROUP_AND_C2C, heartbeatTimeoutMs }) {
		this.auth = auth;
		this.api = api;
		this.log = log;
		this.onEvent = onEvent;
		this.onState = onState;
		this.intents = intents;
		this.heartbeatTimeoutMs = heartbeatTimeoutMs;
		this.ws = undefined;
		this.sessionId = undefined;
		this.lastSeq = null;
		this.heartbeatTimer = undefined;
		this.reconnectTimer = undefined;
		this.backoffMs = 1000;
		this.started = false;
		this.closing = false;
		this.state = "idle";
		this.lastCloseCode = 0;
		this.openedAt = 0;
		this.quickDisconnects = 0;
		this.openGeneration = 0;
	}

	get status() {
		return {
			state: this.state,
			sessionId: this.sessionId,
			lastSeq: this.lastSeq,
			backoffMs: this.backoffMs,
			lastCloseCode: this.lastCloseCode,
		};
	}

	async start() {
		if (this.started) return;
		this.started = true;
		this.closing = false;
		await this.#open();
	}

	stop() {
		this.closing = true;
		this.started = false;
		this.openGeneration++;
		this.#clearTimers();
		this.#closeSocket();
		this.#setState("stopped");
	}

	/** 手动重连：默认保留 session 尝试 resume，fresh=true 时彻底重来。 */
	async reconnect({ fresh = false } = {}) {
		if (fresh) {
			this.sessionId = undefined;
			this.lastSeq = null;
		}
		this.#clearTimers();
		this.#closeSocket();
		this.backoffMs = 1000;
		this.closing = false;
		this.started = true;
		await this.#open();
	}

	#setState(state) {
		this.state = state;
		try {
			this.onState?.(state);
		} catch (err) {
			this.log?.warn(`onState 回调出错：${err?.message ?? err}`);
		}
	}

	#clearTimers() {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = undefined;
		}
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = undefined;
		}
	}

	#closeSocket() {
		const ws = this.ws;
		this.ws = undefined;
		if (!ws) return;
		try {
			ws.close();
		} catch {
			// ignore
		}
	}

	async #open() {
		const generation = ++this.openGeneration;
		this.#setState("connecting");
		let url;
		try {
			url = await this.api.getGatewayUrl();
		} catch (err) {
			if (generation !== this.openGeneration) return; // 已被更新的连接取代
			this.log?.error(`取网关地址失败：${err?.message ?? err}`);
			this.#setState("error");
			this.#scheduleReconnect();
			return;
		}
		// 期间 stop()/reconnect() 可能已经发起新连接
		if (this.closing || generation !== this.openGeneration) return;

		let ws;
		try {
			ws = new WebSocket(url);
		} catch (err) {
			this.log?.error(`建立 WebSocket 失败：${err?.message ?? err}`);
			this.#setState("error");
			this.#scheduleReconnect();
			return;
		}
		this.ws = ws;
		this.log?.info(`连接网关 ${url}`);

		ws.addEventListener("open", () => {
			this.openedAt = Date.now();
			this.log?.info("网关连接已建立，等待 Hello");
		});
		ws.addEventListener("message", (event) => {
			if (this.ws !== ws) return;
			this.#handleFrame(event.data);
		});
		ws.addEventListener("error", () => this.log?.warn("网关 WebSocket 报错"));
		ws.addEventListener("close", (event) => {
			if (this.ws !== ws) return; // 旧连接的关闭不影响新连接
			this.#handleClose(event.code, event.reason);
		});
	}

	#handleClose(code, reason) {
		this.ws = undefined;
		this.#clearTimers();
		this.lastCloseCode = code;
		this.log?.warn(`网关断开（code=${code}${reason ? `, reason=${reason}` : ""}）`);
		if (this.closing) {
			this.#setState("stopped");
			return;
		}

		// 连上不到 5 秒就断，多半是凭据/权限问题：连续三次直接停。
		// 4008 是平台限流，按 60 秒退避重试，不能算进快速断开。
		if (code !== 4008 && this.openedAt && Date.now() - this.openedAt < QUICK_DISCONNECT_MS) {
			this.quickDisconnects++;
			if (this.quickDisconnects >= MAX_QUICK_DISCONNECTS) {
				this.closing = true;
				this.#setState("error");
				this.log?.error("连续快速断开，检查 AppID/AppSecret 与机器人权限");
				return;
			}
		} else {
			this.quickDisconnects = 0;
		}

		const fatal = FATAL_CLOSE_CODES.get(code);
		if (fatal) {
			this.closing = true;
			this.#setState("error");
			this.log?.error(`网关拒绝连接（${code} ${fatal}），请到 QQ 开放平台检查配置`);
			return;
		}
		if (AUTH_FAIL_CLOSE_CODES.has(code)) this.auth.invalidate();
		if (SESSION_RESET_CLOSE_CODES.has(code) || AUTH_FAIL_CLOSE_CODES.has(code)) {
			this.sessionId = undefined;
			this.lastSeq = null;
		}
		this.#setState("disconnected");
		this.#scheduleReconnect(code === 4008 ? RATE_LIMIT_DELAY_MS : undefined);
	}

	#scheduleReconnect(forcedDelay) {
		if (this.closing || this.reconnectTimer) return;
		const delay = forcedDelay ?? this.backoffMs;
		this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
		if (forcedDelay) {
			this.log?.info(`平台限流（4008），${Math.round(delay / 1000)}s 后再连`);
		}
		this.log?.info(`${delay}ms 后重连网关`);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			void this.#open();
		}, delay);
		this.reconnectTimer.unref?.();
	}

	#handleFrame(raw) {
		let payload;
		try {
			payload = JSON.parse(typeof raw === "string" ? raw : String(raw));
		} catch {
			this.log?.warn("收到非 JSON 的网关帧");
			return;
		}
		if (typeof payload?.s === "number") this.lastSeq = payload.s;

		switch (payload?.op) {
			case OP_HELLO:
				this.#onHello(payload.d ?? {});
				break;
			case OP_HEARTBEAT_ACK:
				break;
			case OP_DISPATCH:
				this.#onDispatch(payload);
				break;
			case OP_RECONNECT:
				this.log?.info("服务端要求重连");
				this.#softReconnect();
				break;
			case OP_INVALID_SESSION:
				// op9 的 d=true 表示可以 resume，false 才需要重新 identify
				if (payload.d === true) {
					this.log?.info("会话暂时失效（可续接），重连后续接");
				} else {
					this.log?.warn("会话失效，重新鉴权");
					this.sessionId = undefined;
					this.lastSeq = null;
				}
				this.#softReconnect();
				break;
			default:
				break;
		}
	}

	#softReconnect() {
		this.openGeneration++; // 使正在 await 的旧 #open 失效
		this.#clearTimers();
		this.#closeSocket();
		this.#setState("disconnected");
		this.#scheduleReconnect();
	}

	#onHello(d) {
		const interval = Number(d.heartbeat_interval) > 0 ? Number(d.heartbeat_interval) : this.heartbeatTimeoutMs ?? 30_000;
		this.#clearHeartbeat();
		// 用 80% 的间隔发心跳，避免刚好卡在服务端超时线上（Hermes 同样取 0.8）
		this.heartbeatTimer = setInterval(() => this.#send({ op: OP_HEARTBEAT, d: this.lastSeq }), Math.max(5_000, interval * 0.8));
		this.heartbeatTimer.unref?.();
		if (this.sessionId && this.lastSeq !== null) void this.#sendResume();
		else void this.#sendIdentify();
	}

	#clearHeartbeat() {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = undefined;
		}
	}

	async #sendIdentify() {
		let token;
		try {
			token = await this.auth.getToken();
		} catch (err) {
			this.log?.error(`identify 取 token 失败：${err?.message ?? err}`);
			this.#softReconnect(); // 不关 socket 会一直干等，等下一次重连再试
			return;
		}
		this.#send({
			op: OP_IDENTIFY,
			d: {
				token: `QQBot ${token}`,
				intents: this.intents,
				shard: [0, 1],
				properties: { $os: process.platform, $browser: "pi-qqbot", $device: "pi-qqbot" },
			},
		});
	}

	async #sendResume() {
		let token;
		try {
			token = await this.auth.getToken();
		} catch (err) {
			this.log?.error(`resume 取 token 失败：${err?.message ?? err}`);
			this.#softReconnect();
			return;
		}
		this.#send({
			op: OP_RESUME,
			d: { token: `QQBot ${token}`, session_id: this.sessionId, seq: this.lastSeq },
		});
	}

	#onDispatch(payload) {
		const type = payload.t;
		if (type === "READY") {
			this.sessionId = payload.d?.session_id;
			this.backoffMs = 1000;
			this.#setState("connected");
			const name = payload.d?.user?.username;
			this.log?.info(`网关 READY${name ? `（机器人：${name}）` : ""}`);
			return;
		}
		if (type === "RESUMED") {
			this.backoffMs = 1000;
			this.#setState("connected");
			this.log?.info("网关 RESUMED");
			return;
		}
		try {
			this.onEvent?.(type, payload.d, payload.id);
		} catch (err) {
			this.log?.error(`事件处理出错（${type}）：${err?.stack ?? err}`);
		}
	}

	#send(payload) {
		const ws = this.ws;
		if (!ws) return;
		try {
			ws.send(JSON.stringify(payload));
		} catch (err) {
			this.log?.warn(`网关发送失败：${err?.message ?? err}`);
		}
	}
}
