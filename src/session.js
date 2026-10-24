/**
 * QQ ⇄ Pi 会话桥：串行队列、注入、收集最终回答、被动回复。
 *
 * 关键约束：
 *  - pi.sendUserMessage() 在 streaming 时会抛错，所以必须等 agent_settled 再注下一条；
 *  - 群聊被动回复窗口 5 分钟、单聊 60 分钟，每条消息最多 5 次（默认只发 4 条）；
 *  - 同一 (msg_id, msg_seq) 重复会失败，所以 seq 在同一 msg_id 下递增。
 */

import { randomInt } from "node:crypto";

import { parseFileMarkers, uploadFile } from "./media.js";
import { buildPrompt, chatKey, chunkText, isAllowed, maskId, replyTarget, stripMarkdown } from "./text.js";

/**
 * Pi 换会话/重载后会作废旧 pi、旧 ctx 句柄；pi 1.x 的固定文案如下。
 * 命中的意思不是"暂时忙"，而是这个句柄永久不可用。
 */
export function isStaleContextError(err) {
	return /stale after session replacement or reload/i.test(String(err?.message ?? err ?? ""));
}

function logChat(item) {
	return `${item.kind}:${maskId(item.chatId)}`;
}

function messageText(message) {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((part) => part && part.type === "text" && typeof part.text === "string")
			.map((part) => part.text)
			.join("");
	}
	return "";
}

async function downloadImage(url, maxBytes, headers = {}) {
	if (!/^https:\/\//i.test(url)) return null;
	try {
		// QQ 媒体 CDN 必须带 QQBot token，否则常见 403（Hermes 适配器同样处理）
		const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
		if (!res.ok) return null;
		const mimeType = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
		if (!mimeType.startsWith("image/")) return null;
		const declared = Number(res.headers.get("content-length"));
		if (Number.isFinite(declared) && declared > maxBytes) return null;
		if (!res.body) return null;
		const chunks = [];
		let total = 0;
		for await (const chunk of res.body) {
			total += chunk.length;
			if (total > maxBytes) {
				await res.body.cancel().catch(() => {});
				return null;
			}
			chunks.push(Buffer.from(chunk));
		}
		const buf = Buffer.concat(chunks);
		if (buf.length === 0) return null;
		return { type: "image", data: buf.toString("base64"), mimeType };
	} catch {
		return null;
	}
}

export class QqBridge {
	constructor({ pi, api, config, log, notify, isOnline, onNewSession, onFatal, injectTimeoutMs = 5000 }) {
		this.pi = pi;
		this.api = api;
		this.cfg = config;
		this.log = log;
		this.notify = notify ?? (() => {});
		this.isOnline = isOnline;
		this.onNewSession = onNewSession;
		this.queue = [];
		this.inflight = undefined;
		this.running = false;
		this.finishing = false;
		this.pumping = false;
		this.injecting = false;
		this.injectTimeoutMs = injectTimeoutMs;
		this.onFatal = onFatal;
		this.staleReported = false;
		this.stopped = false;
		this.seen = new Map();
		this.lastByChat = new Map();
		this.pendingNew = undefined;
		this.deferred = [];
		this.generation = 0;
		this.retryTimer = undefined;
		this.ackTimer = undefined;
		this.injectTimer = undefined;
		this.stats = { received: 0, ignored: 0, sent: 0, failed: 0 };
	}

	get status() {
		return {
			queue: this.queue.length,
			busy: this.running,
			inflight: this.inflight ? { chat: chatKey(this.inflight.item), texts: this.inflight.texts.length } : null,
			stats: { ...this.stats },
		};
	}

	/** 换会话/重建时清空队列与进行中的状态。 */
	reset() {
		this.generation++;
		this.#clearTimers();
		this.#stopTyping(this.inflight);
		this.queue = [];
		this.deferred = [];
		this.inflight = undefined;
		this.running = false;
		this.injecting = false;
	}

	/** 新会话就绪：回执并清空旧状态。 */
	async onSessionSwitched() {
		const pending = this.pendingNew;
		const deferred = this.deferred;
		this.pendingNew = undefined;
		this.deferred = [];
		this.reset();
		if (pending) {
			const temp = { seqs: new Set(), attemptsLeft: 1 };
			try {
				await this.api.sendText(replyTarget(pending.item), "✅ 已开新会话", {
					msgId: pending.item.msgId,
					msgSeq: this.#nextSeq(temp),
				});
				this.stats.sent++;
			} catch (err) {
				this.log.warn(`新会话回执发送失败：${err?.message ?? err}`);
			}
		}
		if (deferred.length > 0) {
			this.queue.push(...deferred);
			this.log.info(`会话切换完成，恢复暂存的 ${deferred.length} 条消息`);
			void this.pump();
		}
	}

	clearPendingNew() {
		this.pendingNew = undefined;
	}

	/** /qq new 失败：TUI 通知 + 尽力给 QQ 回一条失败提示。 */
	notifyNewSessionFailed(reason) {
		const pending = this.pendingNew;
		const deferred = this.deferred;
		this.pendingNew = undefined;
		this.deferred = [];
		if (deferred.length > 0) {
			this.queue.push(...deferred);
			void this.pump();
		}
		if (!pending) return;
		this.log.warn(`开新会话失败：${reason}`);
		this.notify(`开新会话失败：${reason}`, "warning");
		const temp = { seqs: new Set(), attemptsLeft: 1 };
		void this.api
			.sendText(replyTarget(pending.item), `开新会话失败：${reason}`, {
				msgId: pending.item.msgId,
				msgSeq: this.#nextSeq(temp),
			})
			.catch((err) => this.log.warn(`失败提示发送失败：${err?.message ?? err}`));
	}

	stop() {
		this.stopped = true;
		this.generation++;
		this.pendingNew = undefined;
		this.#clearTimers();
		this.#stopTyping(this.inflight);
		this.queue = [];
		this.inflight = undefined;
	}

	#clearTimers() {
		if (this.retryTimer) {
			clearTimeout(this.retryTimer);
			this.retryTimer = undefined;
		}
		if (this.ackTimer) {
			clearTimeout(this.ackTimer);
			this.ackTimer = undefined;
		}
		if (this.injectTimer) {
			clearTimeout(this.injectTimer);
			this.injectTimer = undefined;
		}
	}

	#pruneSeen() {
		const cutoff = Date.now() - this.cfg.dedupeTtlMs;
		for (const [id, at] of this.seen) {
			if (at < cutoff) this.seen.delete(id);
		}
		// 参考 Hermes 的 DEDUP_MAX_SIZE：只留最近 1000 条
		while (this.seen.size > 1000) {
			const oldest = this.seen.keys().next().value;
			this.seen.delete(oldest);
		}
	}

	/**
	 * 收到一条 QQ 消息。
	 * @returns {{accepted:boolean, reason?:string}}
	 */
	enqueue(item) {
		if (this.stopped) return { accepted: false, reason: "已停止" };
		this.#pruneSeen();
		if (this.seen.has(item.msgId)) {
			this.stats.ignored++;
			this.log.debug(`重复消息 ${maskId(item.msgId)}，忽略`);
			return { accepted: false, reason: "重复消息" };
		}
		if (!isAllowed(item, this.cfg)) {
			this.stats.ignored++;
			this.log.warn(`未授权来源 ${logChat(item)}（kind=${item.kind} user=${maskId(item.userId)}），忽略`);
			return { accepted: false, reason: "未授权" };
		}
		if (this.queue.length >= this.cfg.maxQueue) {
			this.stats.ignored++;
			this.log.warn(`队列已满（${this.cfg.maxQueue}），丢弃来自 ${logChat(item)} 的消息`);
			return { accepted: false, reason: "队列已满" };
		}
		this.seen.set(item.msgId, Date.now());
		this.lastByChat.set(chatKey(item), { msgId: item.msgId, at: item.receivedAt });

		// QQ 侧 /qq new：不注入模型，交给 Pi 的扩展命令开新会话
		// 正在切换会话：新消息留在暂存区，等 session_start(new) 后放回队列，避免被 reset 清掉
		if (this.pendingNew) {
			this.deferred.push(item);
			this.stats.received++;
			this.log.info(`会话切换中，暂存消息 chat=${maskId(item.chatId)}（${this.deferred.length} 条）`);
			return { accepted: true, deferred: true };
		}

		const command = /^\/qq\s+new(?:\s+(.*))?$/i.exec(item.text.trim());
		if (command && typeof this.onNewSession === "function") {
			this.log.info(`收到 /qq new（chat=${maskId(item.chatId)}）`);
			this.pendingNew = { item, at: Date.now() };
			try {
				this.onNewSession?.(command[1] ?? "");
			} catch (err) {
				this.notifyNewSessionFailed(err?.message ?? String(err));
			}
			return { accepted: true, handled: true };
		}

		this.queue.push(item);
		this.stats.received++;
		this.log.info(`收到 ${item.kind} 消息 msg=${maskId(item.msgId)} chat=${maskId(item.chatId)} 队列=${this.queue.length}`);
		void this.pump();
		return { accepted: true };
	}

	/** Pi 侧事件 */
	onAgentStart() {
		this.running = true;
	}

	/** 判断这一轮到底是不是我们注入的那条消息发起的。 */
	onBeforeAgentStart(event) {
		const inflight = this.inflight;
		if (!inflight) return;
		if (event?.messageType && event.messageType !== "user") {
			inflight.foreign = true;
			this.log.warn("本轮由自定义消息发起，不归给 QQ 请求");
			return;
		}
		const prompt = String(event?.prompt ?? "").trim();
		if (!prompt) return;
		if (prompt !== inflight.promptText.trim()) {
			inflight.foreign = true;
			this.log.warn("本轮是终端里输入的消息，跳过收集");
			return;
		}
		inflight.started = true;
		if (this.injectTimer) {
			clearTimeout(this.injectTimer);
			this.injectTimer = undefined;
		}
	}

	onMessageEnd(message) {
		if (!this.inflight || this.inflight.foreign || !this.inflight.started || message?.role !== "assistant") return;
		const text = messageText(message).trim();
		if (!text) return;
		this.inflight.texts.push(text);
	}

	onAgentSettled(aborted = false) {
		this.running = false;
		const inflight = this.inflight;
		if (!inflight) {
			if (this.injectTimer) {
				clearTimeout(this.injectTimer);
				this.injectTimer = undefined;
			}
			void this.pump();
			return;
		}
		if (!inflight.started) {
			// 这一轮不是我们注入的消息触发的：不要收它的输出，也不要清看门狗
			this.log.warn("本轮不是 QQ 请求触发的，跳过收集");
			void this.pump();
			return;
		}
		if (this.injectTimer) {
			clearTimeout(this.injectTimer);
			this.injectTimer = undefined;
		}
		if (aborted && inflight.texts.length === 0) {
			this.log.warn("本轮被中止且没有输出，跳过回复");
			this.inflight = undefined;
			this.#clearAckTimer();
			this.#stopTyping(inflight);
			void this.pump();
			return;
		}
		void this.#finish(inflight);
	}

	async #finish(inflight) {
		this.inflight = undefined;
		this.finishing = true;
		this.#clearAckTimer();
		this.#stopTyping(inflight);
		try {
			if (inflight.foreign && inflight.texts.length === 0) {
				this.log.warn("这一轮不是 QQ 请求触发的，未回复");
				return;
			}
			const text = inflight.texts.join("\n\n").trim() || this.cfg.emptyReply;
			await this.#deliver(inflight, text);
		} catch (err) {
			this.log.error(`回复失败：${err?.stack ?? err}`);
			this.notify(`QQ 回复失败：${err?.message ?? err}`, "warning");
		} finally {
			this.finishing = false;
			void this.pump();
		}
	}

	async pump() {
		if (this.stopped || this.pumping || this.finishing || this.injecting || this.inflight || this.running || this.queue.length === 0) return;
		this.pumping = true;
		try {
			await this.#pumpOnce();
		} catch (err) {
			this.log.error(`注入流程异常：${err?.stack ?? err}`);
			this.#scheduleRetry();
		} finally {
			this.pumping = false;
			// 取 token / 下载图片期间被换会话或 stop 打断时，队列可能还有消息，补泵一次
			if (!this.stopped && !this.finishing && !this.injecting && !this.inflight && !this.running && this.queue.length > 0) {
				void this.pump();
			}
		}
	}

	async #pumpOnce() {
		const generation = this.generation;
		const item = this.queue.shift();
		const prompt = buildPrompt(item, this.cfg);

		let token = null;
		try {
			token = await this.api.auth?.getToken?.();
		} catch {
			token = null;
		}
		const mediaHeaders = token ? { Authorization: `QQBot ${token}` } : {};
		// 最多 2 张，并发下载；单张内部按 maxBytes 流式截断
		const downloaded = await Promise.all(
			prompt.imageUrls.map(async (url) => {
				const image = await downloadImage(url, this.cfg.images.maxBytes, mediaHeaders);
				if (!image) this.log.warn(`图片下载失败：${url.slice(0, 80)}`);
				return image;
			}),
		);
		const images = downloaded.filter(Boolean);

		// 下载期间可能被 stop()、换会话或已经排了新消息
		if (this.stopped || generation !== this.generation) {
			if (generation === this.generation) this.queue.unshift(item);
			return;
		}

		const inflight = {
			item,
			texts: [],
			seq: 0,
			attemptsLeft: this.#replyQuota(item.kind),
			quotaMax: this.#replyQuota(item.kind),
			ackSent: false,
			startedAt: Date.now(),
			promptText: prompt.text,
		};
		this.inflight = inflight;

		if (generation !== this.generation) return;
		try {
			const content = images.length > 0 ? [{ type: "text", text: prompt.text }, ...images] : prompt.text;
			this.pi.sendUserMessage(content);
			this.log.info(`已注入 Pi（chat=${maskId(item.chatId)}，图片 ${images.length} 张）`);
			// Pi 的 sendUserMessage 是 fire-and-forget，异步失败不会抛回来；靠看门狗兜底
			this.#armInjectWatchdog(inflight);
			this.#armAck(inflight);
			this.#startTyping(inflight);
		} catch (err) {
			this.inflight = undefined;
			if (isStaleContextError(err)) {
				// 会话已被替换：旧 pi 句柄永久失效，重试多少次都不会成功
				this.#failOnStale(item, err);
				return;
			}
			// 可能刚好在流式输出中：放回队首，等 agent_settled 或定时器再试
			this.queue.unshift(item);
			this.injecting = true;
			this.log.warn(`注入失败，等空闲后重试：${err?.message ?? err}`);
			this.#scheduleRetry();
		}
	}

	/**
	 * 会话被替换后旧 pi 句柄永久失效：一次性告警、回执 QQ、停桥并交上层收尾。
	 * 绝不能再走 #scheduleRetry：那条路径每 2 秒重试一次且没有上限。
	 */
	#failOnStale(item, err) {
		if (this.staleReported) return;
		this.staleReported = true;
		const reason = err?.message ?? String(err);
		this.log.error(`会话已被替换，QQ 桥失效，停止桥接：${reason}`);
		try {
			const sending = this.api?.sendText?.(
				replyTarget(item),
				"⚠️ Pi 会话已切换，这个 QQ 桥已失效。请在终端执行 /qq stop 再 /qq start 恢复。",
				{ msgId: item.msgId, msgSeq: this.#nextSeq({ seqs: new Set(), attemptsLeft: 1 }) },
			);
			if (sending && typeof sending.catch === "function") {
				sending.catch((sendErr) => this.log.warn(`失效提示发送失败：${sendErr?.message ?? sendErr}`));
			}
		} catch {
			// 网关可能已经不可用，回执失败不影响停桥
		}
		this.notify("QQ 桥已随会话切换失效，已停止重试：请在终端 /qq stop 再 /qq start", "warning");
		this.stop();
		try {
			this.onFatal?.(err);
		} catch {
			// 上层收尾失败不影响已经停掉的桥
		}
	}

	#scheduleRetry() {
		if (this.retryTimer || this.stopped) return;
		this.retryTimer = setTimeout(() => {
			this.retryTimer = undefined;
			this.injecting = false;
			void this.pump();
		}, 2000);
		this.retryTimer.unref?.();
	}

	/** 注入后等 before_agent_start；超时说明 Pi 静默拒绝了这条消息，重排一次。 */
	#armInjectWatchdog(inflight) {
		if (!this.injectTimeoutMs || this.injectTimeoutMs <= 0) return;
		if (this.injectTimer) clearTimeout(this.injectTimer);
		this.injectTimer = setTimeout(() => {
			this.injectTimer = undefined;
			if (this.inflight !== inflight || inflight.started || this.stopped) return;
			if (this.running) {
				// 另一个轮次在跑，可能只是 before_agent_start 被延迟；等它结束再看，别重复注入
				this.log.warn(`注入后 ${this.injectTimeoutMs}ms 仍未开始，但 Pi 正在忙，延后判定`);
				this.#armInjectWatchdog(inflight);
				return;
			}
			this.log.warn(`注入后 ${this.injectTimeoutMs}ms 没有开始执行，判定注入失败`);
			this.#clearAckTimer();
			this.#stopTyping(inflight);
			this.inflight = undefined;
			if (!inflight.item.injectRetried) {
				inflight.item.injectRetried = true;
				this.queue.unshift(inflight.item);
			} else {
				this.notify("QQ 消息注入 Pi 失败（模型没有开始执行），请重发", "warning");
			}
			void this.pump();
		}, this.injectTimeoutMs);
		this.injectTimer.unref?.();
	}

	#armAck(inflight) {
		const delay = this.cfg.ackAfterMs;
		if (!delay || delay <= 0) return;
		this.#clearAckTimer();
		this.ackTimer = setTimeout(() => {
			this.ackTimer = undefined;
			if (this.inflight !== inflight || inflight.ackSent) return;
			// 额度只剩 1 次时别把唯一的机会用在回执上，否则正文必然发不出去
			if (inflight.attemptsLeft <= 1) return;
			inflight.ackSent = true;
			inflight.attemptsLeft--;
			const seq = this.#nextSeq(inflight);
			void this.api
				.sendText(replyTarget(inflight.item), "收到，正在处理…", { msgId: inflight.item.msgId, msgSeq: seq })
				.catch((err) => this.log.warn(`回执发送失败：${err?.message ?? err}`));
		}, delay);
		this.ackTimer.unref?.();
	}

	#clearAckTimer() {
		if (this.ackTimer) {
			clearTimeout(this.ackTimer);
			this.ackTimer = undefined;
		}
	}

	/**
	 * 被动窗口兜底：超时且该会话有更新消息时，改用它当 msg_id。
	 */
	#resolveMsgId(item) {
		const windowSec = item.kind === "group" ? this.cfg.passiveWindowSec.group : this.cfg.passiveWindowSec.private;
		const windowMs = windowSec * 1000;
		if (Date.now() - item.receivedAt <= windowMs) return item.msgId;
		const latest = this.lastByChat.get(chatKey(item));
		if (latest && latest.msgId !== item.msgId && Date.now() - latest.at <= windowMs) {
			this.log.warn(`原消息已过被动窗口（${windowSec}s），改用同会话最新消息 msg=${maskId(latest.msgId)}`);
			return latest.msgId;
		}
		this.log.warn(`被动回复窗口已过（${windowSec}s），仍按原 msg_id 尝试`);
		return item.msgId;
	}

	/**
	 * 生成一个 0..65535 的唯一 msg_seq。参考 Hermes 的 _next_msg_seq：
	 * 不用 1/2/3 递增，而是时间 + 随机，这样重发或重启后不会撞上旧的 (msg_id, msg_seq)。
	 */
	#nextSeq(inflight) {
		const used = inflight.seqs ?? (inflight.seqs = new Set());
		for (let attempt = 0; attempt < 32; attempt++) {
			const seq = (((Math.floor(Date.now() / 1000) % 100_000_000) ^ randomInt(0, 65536)) % 65536) >>> 0;
			if (seq > 0 && !used.has(seq)) {
				used.add(seq);
				return seq;
			}
		}
		let seq = 1;
		while (used.has(seq)) seq++;
		used.add(seq);
		return seq;
	}

	/** 被动回复次数上限：官方单聊 4 次、群聊 5 次；配置只能调低。 */
	#replyQuota(kind) {
		const max = kind === "private" ? 4 : 5;
		const configured = Number(this.cfg.replyQuota);
		return Number.isFinite(configured) && configured > 0 ? Math.min(configured, max) : max;
	}

	#isPermanentSendError(err) {
		const status = Number(err?.status ?? 0);
		if (status === 429) return false; // 限流可重试
		const code = Number(err?.code);
		// 业务错误常以 HTTP 200 + err_code 返回，不能靠 status 判断
		if ([40034005, 40034024, 40034006, 40034128, 40054013].includes(code)) return true;
		if ([400, 403, 404].includes(status)) return true;
		const message = String(err?.message ?? err).toLowerCase();
		return /invalid|forbidden|not found|bad request|limit exceed|超频|频率/.test(message);
	}

	/** 发送失败重试 2 次（1s/2s）；同一条内容复用同一个 msg_seq，重复即视为已送达。 */
	async #sendWithRetry(inflight, send, { attempts = 3 } = {}) {
		if (inflight.attemptsLeft <= 0) {
			throw new Error(`被动回复额度已用完（每条消息最多 ${inflight.quotaMax} 次）`);
		}
		const seq = this.#nextSeq(inflight);
		let charged = false;
		const charge = () => {
			if (charged) return;
			charged = true;
			inflight.attemptsLeft--;
		};
		let lastError;
		for (let attempt = 0; attempt < attempts; attempt++) {
			try {
				const result = await send(seq);
				charge();
				return result;
			} catch (err) {
				lastError = err;
				// 40054005：同一 msg_id+msg_seq 已发过，说明上一次其实成功
				if (Number(err?.code) === 40054005) {
					charge();
					return undefined;
				}
				if (this.#isPermanentSendError(err)) break;
				if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
			}
		}
		throw lastError;
	}

	#startTyping(inflight) {
		if (!this.cfg.typing || inflight.item.kind !== "private") return;
		const send = () => {
			if (this.inflight !== inflight) return;
			const seq = this.#nextSeq(inflight);
			void this.api
				.sendTyping(replyTarget(inflight.item), { msgId: inflight.item.msgId, msgSeq: seq, seconds: 60 })
				.catch(() => {});
		};
		send();
		inflight.typingTimer = setInterval(send, 50_000);
		inflight.typingTimer.unref?.();
	}

	#stopTyping(inflight) {
		if (inflight?.typingTimer) {
			clearInterval(inflight.typingTimer);
			inflight.typingTimer = undefined;
		}
	}

	/** 发送前等网关回到 connected：官方要求发消息时 WS 在线，Hermes 同样先等重连。 */
	async #waitOnline(timeoutMs = 10_000) {
		if (typeof this.isOnline !== "function" || this.isOnline()) return true;
		this.log.warn(`网关不在线，最多等 ${Math.round(timeoutMs / 1000)}s 重连`);
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (this.stopped) return false;
			await new Promise((resolve) => setTimeout(resolve, 500));
			if (this.isOnline()) return true;
		}
		this.log.warn("网关仍未恢复，照常尝试发送");
		return false;
	}

	async #deliver(inflight, text) {
		if (this.stopped) return;
		const online = await this.#waitOnline();
		if (this.stopped) return;
		if (!online) this.notify("QQ 网关离线，回复可能发送失败", "warning");
		const { item } = inflight;
		const msgId = this.#resolveMsgId(item);
		const markdown = this.cfg.replyFormat === "markdown";
		const parsed = this.cfg.files?.enabled
			? parseFileMarkers(text, { maxCount: this.cfg.files.maxCount })
			: { text, files: [], skipped: [] };
		for (const skipped of parsed.skipped) this.log.warn(`文件标记被忽略：${skipped}`);
		const body = markdown ? parsed.text.trim() : stripMarkdown(parsed.text);

		// 额度要给文件留位置：单聊总共 4 次，1 段文字 + 3 个文件正好用完。
		// #finish 在进 #deliver 前已经清掉回执定时器，这里不可能再发回执，别再预留额度
		const reserveAck = 0;
		const available = Math.max(0, inflight.attemptsLeft - reserveAck);
		const wantText = body.length > 0 || parsed.files.length === 0;
		const filesToSend = parsed.files.slice(0, Math.max(0, Math.min(parsed.files.length, available - (wantText ? 1 : 0))));
		const textSlots = wantText ? Math.max(0, available - filesToSend.length) : 0;
		const chunks = textSlots > 0
			? chunkText(body, {
					chunkChars: this.cfg.chunkChars,
					maxChunks: Math.min(this.cfg.maxChunks, textSlots),
				})
			: [];
		if (chunks.length === 0 && filesToSend.length === 0) {
			// 正文被 Markdown 清理成空（例如只有围栏）时，至少回一句，别让用户干等
			await this.#sendWithRetry(inflight, (seq) =>
				this.api.sendText(replyTarget(item), this.cfg.emptyReply, { msgId, msgSeq: seq }),
			).catch((err) => this.log.warn(`空回复兜底失败：${err?.message ?? err}`));
			return;
		}

		const prefix = this.cfg.replyPrefix || "";
		let markdownBroken = false;
		let sent = 0;

		for (let index = 0; index < chunks.length; index++) {
			if (this.stopped) break;
			const content = (index === 0 ? prefix : "") + chunks[index];
			try {
				if (markdown && !markdownBroken) {
					try {
						await this.#sendWithRetry(
							inflight,
							(seq) => this.api.sendMarkdown(replyTarget(item), content, { msgId, msgSeq: seq }),
							{ attempts: 1 },
						);
					} catch (err) {
						markdownBroken = true;
						this.log.warn(`Markdown 被拒，改纯文本：${err?.message ?? err}`);
						await this.#sendWithRetry(inflight, (seq) =>
							this.api.sendText(replyTarget(item), stripMarkdown(content), { msgId, msgSeq: seq }),
						);
					}
				} else {
					await this.#sendWithRetry(inflight, (seq) =>
						this.api.sendText(replyTarget(item), content, { msgId, msgSeq: seq }),
					);
				}
				sent++;
				this.stats.sent++;
			} catch (err) {
				this.stats.failed++;
				this.log.error(`第 ${index + 1} 段发送失败：${err?.message ?? err}`);
				this.notify(`QQ 回复失败（第 ${index + 1} 段）：${err?.message ?? err}`, "warning");
				break;
			}
		}
		this.log.info(`已回复 ${sent}/${chunks.length} 段到 ${logChat(item)}`);

		if (filesToSend.length > 0 && !this.stopped) {
			const target = replyTarget(item);
			let sentFiles = 0;
			for (const file of filesToSend) {
				if (this.stopped) break;
				if (inflight.attemptsLeft <= 0) {
					this.log.warn("被动回复额度已用完，剩余文件不再上传");
					break;
				}
				try {
					const uploaded = await uploadFile(this.api, target, file, {
						log: this.log,
						maxBytes: this.cfg.files.maxBytes,
						allowDirs: this.cfg.files.allowDirs,
					});
					const fileMsgId = this.#resolveMsgId(item);
					await this.#sendWithRetry(inflight, (seq) =>
						this.api.sendMedia(target, uploaded.fileInfo, { msgId: fileMsgId, msgSeq: seq }),
					);
					sentFiles++;
					this.stats.sent++;
					this.log.info(`已发送文件 ${uploaded.name} 到 ${logChat(item)}`);
				} catch (err) {
					this.stats.failed++;
					this.log.error(`文件发送失败 ${file}：${err?.message ?? err}`);
					this.notify(`QQ 文件发送失败：${err?.message ?? err}`, "warning");
				}
			}
			if (sentFiles === 0 && sent === 0 && !this.stopped) {
				await this.#sendWithRetry(inflight, (seq) =>
					this.api.sendText(target, "文件发送失败，请查看 Pi 终端日志", { msgId, msgSeq: seq }),
				).catch((err) => this.log.warn(`文件失败兜底也没发出去：${err?.message ?? err}`));
			}
			this.log.info(`已发送文件 ${sentFiles}/${filesToSend.length} 个到 ${logChat(item)}`);
		}
	}
}
