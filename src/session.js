/**
 * QQ ⇄ Pi 会话桥：串行队列、注入、收集最终回答、被动回复。
 *
 * 关键约束：
 *  - pi.sendUserMessage() 在 streaming 时会抛错，所以必须等 agent_settled 再注下一条；
 *  - 群聊被动回复窗口 5 分钟、单聊 60 分钟，每条消息最多 5 次（默认只发 4 条）；
 *  - 同一 (msg_id, msg_seq) 重复会失败，所以 seq 在同一 msg_id 下递增。
 */

import { randomInt } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { parseFileMarkers, uploadFile } from "./media.js";
import { buildPrompt, chatKey, chunkText, isAllowed, maskId, replyTarget, stripMarkdown } from "./text.js";
import { parseCommand } from "./commands.js";

/**
 * Pi 换会话/重载后会作废旧 pi、旧 ctx 句柄；pi 1.x 的固定文案如下。
 * 命中的意思不是"暂时忙"，而是这个句柄永久不可用。
 */
export function isStaleContextError(err) {
	return /stale after session replacement or reload/i.test(String(err?.message ?? err ?? ""));
}

/** QQ 多媒体 URL 带 appid/fileid/rkey，日志里只留主机名。 */
function maskUrl(url) {
	try {
		return new URL(url).origin;
	} catch {
		return "（无效 URL）";
	}
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

/**
 * 回答超过分片上限时把完整正文写成文件，随回复一起发出去（终端里能看全的东西，QQ 也要能看全）。
 * 落盘失败就退回截断，不能让回复发不出去。
 */
export async function writeOverflowFile(body, cfg, log) {
	try {
		let dir = cfg.replyDir;
		const allowDirs = cfg.files?.allowDirs ?? [];
		if (allowDirs.length > 0 && !allowDirs.some((allowed) => path.resolve(dir).startsWith(path.resolve(allowed)))) {
			dir = allowDirs[0];
		}
		await fs.promises.mkdir(dir, { recursive: true });
		const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
		const file = path.join(dir, `reply-${stamp}-${randomInt(1000, 9999)}.md`);
		await fs.promises.writeFile(file, `${body}\n`, "utf8");
		return file;
	} catch (err) {
		log?.warn?.(`长回答落盘失败：${err?.message ?? err}`);
		return null;
	}
}

export class QqBridge {
	constructor({ pi, api, config, log, notify, isOnline, onCommand, injectTimeoutMs = 5000 }) {
		this.pi = pi;
		this.api = api;
		this.cfg = config;
		this.log = log;
		this.notify = notify ?? (() => {});
		this.isOnline = isOnline;
		this.onCommand = onCommand;
		this.queue = [];
		this.inflight = undefined;
		this.running = false;
		this.finishing = false;
		this.pumping = false;
		this.injecting = false;
		this.injectTimeoutMs = injectTimeoutMs;
		this.stale = false;
		this.retryCount = 0;
		this.stopped = false;
		this.seen = new Map();
		this.lastByChat = new Map();
		this.switching = false;
		this.deferred = [];
		this.generation = 0;
		this.retryTimer = undefined;
		this.ackTimer = undefined;
		this.injectTimer = undefined;
		this.switchTimer = undefined;
		this.stats = { received: 0, ignored: 0, sent: 0, failed: 0 };
	}

	get status() {
		return {
			queue: this.queue.length,
			busy: this.running,
			stale: this.stale,
			inflight: this.inflight ? { chat: chatKey(this.inflight.item), texts: this.inflight.texts.length } : null,
			stats: { ...this.stats },
		};
	}

	/** 换会话/重建时清掉进行中的状态；排队消息由调用方（endSwitch）另行放回。 */
	reset() {
		this.generation++;
		this.retryCount = 0;
		this.#clearTimers();
		this.#stopTyping(this.inflight);
		this.queue = [];
		this.deferred = [];
		this.inflight = undefined;
		this.running = false;
		this.injecting = false;
	}

	/**
	 * 新会话实例接棒：pi 每换会话都会重跑扩展工厂、换一个 pi 句柄，旧句柄随即作废。
	 * 这里把旧句柄换掉；如果之前因为等不到接手而暂停，顺便解除暂停。
	 */
	adopt(pi) {
		if (pi) this.pi = pi;
		if (!this.stale) return;
		this.stale = false;
		this.retryCount = 0;
		this.injecting = false;
		this.log.info(`新会话实例已接管 QQ 桥，积压 ${this.queue.length} 条消息待处理`);
	}

	/**
	 * 换会话开始：期间到达的消息先暂存，等 session_start 之后再放回队列。
	 * 可重复调用（QQ 侧 /new 会先调一次，session_shutdown 再调一次）：
	 * 已经在切换中时只续看门狗，绝不清空已暂存的消息。
	 */
	beginSwitch() {
		if (!this.switching) {
			this.switching = true;
			this.deferred = [];
		}
		if (this.switchTimer) clearTimeout(this.switchTimer);
		// 兜底：Pi 没给 session_start（拒绝/报错/被打断）时不能一直暂存消息
		this.switchTimer = setTimeout(() => {
			this.switchTimer = undefined;
			if (!this.switching) return;
			this.log.warn("换会话 30 秒内没有完成，恢复队列");
			this.cancelSwitch();
		}, 30_000);
		this.switchTimer.unref?.();
	}

	#clearSwitchTimer() {
		if (this.switchTimer) {
			clearTimeout(this.switchTimer);
			this.switchTimer = undefined;
		}
	}

	/**
	 * 换会话完成：保留排队消息与暂存消息，丢掉属于旧会话的在途回答。
	 * 已经注入旧会话的那条没办法重放（模型可能已经动过手），只记一条日志。
	 */
	endSwitch() {
		this.#clearSwitchTimer();
		const deferred = this.deferred;
		const inflight = this.inflight;
		const kept = this.queue;
		this.deferred = [];
		this.switching = false;
		this.reset();
		if (inflight) {
			this.log.warn(`会话切换时有一条消息正在生成回答，该回答随旧会话丢弃（chat=${maskId(inflight.item.chatId)}）`);
		}
		this.#restore([...kept, ...deferred], "会话切换完成");
	}

	/** 换会话失败：解除暂存，把消息放回队列，别把队列一起清了。 */
	cancelSwitch() {
		this.#clearSwitchTimer();
		if (!this.switching) return;
		const deferred = this.deferred;
		this.deferred = [];
		this.switching = false;
		this.#restore(deferred, "开新会话失败");
	}

	/**
	 * 把暂存/排队过的消息放回桥里。
	 * 斜杠命令在暂存期间没法执行（旧句柄已死），这里重新解析一遍交给命令通道，
	 * 绝不当作普通提问喂给模型（AGENTS.md：斜杠命令不进模型）。
	 */
	#restore(items, label) {
		if (items.length === 0) return;
		const commands = [];
		let queued = 0;
		for (const item of items) {
			const command = parseCommand(item.text);
			if (command) {
				commands.push({ item, command });
				continue;
			}
			if (this.queue.length >= this.cfg.maxQueue) {
				this.stats.ignored++;
				this.log.warn(`队列已满（${this.cfg.maxQueue}），丢弃切换前排队的消息 ${maskId(item.msgId)}`);
				continue;
			}
			this.queue.push(item);
			queued++;
		}
		if (queued > 0) this.log.info(`${label}，恢复 ${queued} 条消息`);
		if (commands.length === 0) {
			void this.pump();
			return;
		}
		// 命令按顺序补跑完再泵消息：否则 /model、/compact 可能落到刚注入的提问之后
		this.log.info(`${label}，补跑 ${commands.length} 条命令`);
		void (async () => {
			for (let i = 0; i < commands.length; i++) {
				if (this.stopped) return;
				if (this.stale) {
					// 接棒还没完成：把剩下的命令原样放回队首，等下一次恢复，别静默丢掉
					const rest = commands.slice(i).map((entry) => entry.item);
					this.queue.unshift(...rest);
					this.log.warn(`桥已暂停，${rest.length} 条命令留到接棒后再跑`);
					return;
				}
				await this.#runCommand(commands[i].item, commands[i].command);
			}
			void this.pump();
		})();
	}

	/** 直接回一条纯文本（命令的答复），不走模型、不占队列。 */
	async reply(item, text) {
		if (this.stopped || !text) return;
		const body = this.cfg.replyFormat === "markdown" ? String(text) : stripMarkdown(String(text));
		const inflight = { seqs: new Set(), attemptsLeft: this.#replyQuota(item.kind), quotaMax: this.#replyQuota(item.kind) };
		const chunks = chunkText(body, {
			chunkChars: this.cfg.chunkChars,
			maxChunks: Math.min(this.cfg.maxChunks, inflight.attemptsLeft),
		});
		for (const chunk of chunks) {
			if (this.stopped) return;
			try {
				await this.#sendWithRetry(inflight, (seq) =>
					this.api.sendText(replyTarget(item), chunk, { msgId: item.msgId, msgSeq: seq }),
				);
				this.stats.sent++;
			} catch (err) {
				this.stats.failed++;
				this.log.warn(`命令回执发送失败：${err?.message ?? err}`);
				return;
			}
		}
	}

	/** 命令处理：本模块不管具体命令，只负责「不喂模型」和回执。 */
	async #runCommand(item, command) {
		try {
			const result = await this.onCommand?.(command, item);
			if (!result) {
				// 没有处理器：按普通消息处理
				this.queue.push(item);
				void this.pump();
				return;
			}
			if (result.forward) {
				// 技能/提示模板/其它插件的命令：交给 Pi 展开执行，算一次正常提问
				item.expandTemplates = true;
				this.queue.push(item);
				void this.pump();
				return;
			}
			await this.reply(item, result.text ?? "");
		} catch (err) {
			this.log.error(`命令执行失败：${err?.stack ?? err}`);
			await this.reply(item, `命令执行失败：${err?.message ?? err}`).catch(() => {});
		}
	}

	stop() {
		this.stopped = true;
		this.generation++;
		this.#clearSwitchTimer();
		this.switching = false;
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
		this.seen.set(item.msgId, Date.now());
		this.lastByChat.set(chatKey(item), { msgId: item.msgId, at: item.receivedAt });

		// 正在切换会话：新消息留在暂存区，等 session_start 后放回队列，避免被 reset 清掉
		if (this.switching) {
			if (this.deferred.length >= this.cfg.maxQueue) {
				this.stats.ignored++;
				this.log.warn(`切换期间暂存已满（${this.cfg.maxQueue}），丢弃来自 ${logChat(item)} 的消息`);
				return { accepted: false, reason: "暂存已满" };
			}
			this.deferred.push(item);
			this.stats.received++;
			this.log.info(`会话切换中，暂存消息 chat=${maskId(item.chatId)}（${this.deferred.length} 条）`);
			return { accepted: true, deferred: true };
		}

		// 斜杠命令不喂模型：本插件或 Pi 的桌面命令自己处理（与终端里敲命令一致）。
		// 放在队列上限判断之前——队列满的时候也应该能 /new、/model。
		const command = parseCommand(item.text);
		if (command) {
			this.stats.received++;
			this.log.info(`收到命令 /${command.name}（chat=${maskId(item.chatId)}）`);
			void this.#runCommand(item, command);
			return { accepted: true, handled: true };
		}

		if (this.queue.length >= this.cfg.maxQueue) {
			this.stats.ignored++;
			this.log.warn(`队列已满（${this.cfg.maxQueue}），丢弃来自 ${logChat(item)} 的消息`);
			return { accepted: false, reason: "队列已满" };
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
		if (this.stopped || this.stale || this.switching || this.pumping || this.finishing || this.injecting || this.inflight || this.running || this.queue.length === 0) return;
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
		// 转发的斜杠命令必须保持「/开头且无信封头」，否则 Pi 不会展开技能/模板
		const prompt = item.expandTemplates
			? { text: String(item.text ?? ""), imageUrls: [] }
			: buildPrompt(item, this.cfg);

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
				if (!image) this.log.warn(`图片下载失败：${maskUrl(url)}`);
				return image;
			}),
		);
		const images = downloaded.filter(Boolean);

		// 下载期间可能被 stop()、换会话或已经排了新消息：放回队首，别把这条吞掉
		if (this.stopped) return;
		if (generation !== this.generation || this.switching || this.stale) {
			this.queue.unshift(item);
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

		try {
			const content = images.length > 0 ? [{ type: "text", text: prompt.text }, ...images] : prompt.text;
			this.pi.sendUserMessage(content, item.expandTemplates ? { expandPromptTemplates: true } : undefined);
			this.retryCount = 0;
			this.log.info(`已注入 Pi（chat=${maskId(item.chatId)}，图片 ${images.length} 张）`);
			// Pi 的 sendUserMessage 是 fire-and-forget，异步失败不会抛回来；靠看门狗兜底
			this.#armInjectWatchdog(inflight);
			this.#armAck(inflight);
			this.#startTyping(inflight);
		} catch (err) {
			const inflight = this.inflight;
			this.inflight = undefined;
			if (isStaleContextError(err)) {
				// 会话已被替换：旧 pi 句柄永久失效，重试多少次都不会成功
				this.#failOnStale(item, err, inflight);
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
	 * 会话被替换：旧 pi 句柄永久失效。
	 *
	 * 不能每 2 秒重试（会无限刷），也不能把网关一起收掉——新会话实例很快就会通过
	 * adopt() 接棒。所以这里只暂停：保留队列、网关和切换状态（switching/deferred 归
	 * endSwitch/cancelSwitch 管），回一条提示，等新实例接手后自动继续。
	 */
	#failOnStale(item, err, inflight) {
		const reason = err?.message ?? String(err);
		const first = !this.stale;
		this.stale = true;
		if (first) this.log.error(`会话已被替换，暂停注入直到新会话实例接棒：${reason}`);

		// 丢掉在途轮次（回答属于旧会话，收不回来了），把消息还回去等接棒后重发
		this.generation++;
		this.#clearTimers();
		this.#stopTyping(inflight ?? this.inflight);
		this.inflight = undefined;
		this.injecting = false;
		if (item && !this.stopped) this.queue.unshift(item);

		if (!first) return;
		try {
			const sending = this.api?.sendText?.(
				replyTarget(item),
				"⚠️ Pi 会话已切换，QQ 桥正在等新会话接棒；刚才这条会在接棒后自动重试。",
				{ msgId: item.msgId, msgSeq: this.#nextSeq({ seqs: new Set(), attemptsLeft: 1 }) },
			);
			if (sending && typeof sending.catch === "function") {
				sending.catch((sendErr) => this.log.warn(`切换提示发送失败：${sendErr?.message ?? sendErr}`));
			}
		} catch {
			// 网关可能已经不可用，回执失败不影响接棒
		}
		this.notify("QQ 桥已暂停：Pi 会话被替换，等新会话接手后自动恢复", "warning");
	}

	#scheduleRetry() {
		if (this.retryTimer || this.stopped) return;
		// 退避：2s → 4s → 8s … 最多 30s。否则一条永久失败的消息会每 2 秒刷一次日志并堵住队列
		this.retryCount = (this.retryCount ?? 0) + 1;
		const delay = Math.min(2000 * 2 ** (this.retryCount - 1), 30_000);
		this.retryTimer = setTimeout(() => {
			this.retryTimer = undefined;
			this.injecting = false;
			void this.pump();
		}, delay);
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

		// 长回答：先用「最多能发几段文字」判断有没有溢出，溢出就把全文落盘当附件发，
		// 别像旧版那样把后半截直接丢掉。
		let overflowed = false;
		if (wantText && body && this.cfg.overflow === "file" && this.cfg.files?.enabled) {
			const textCapacity = Math.max(1, Math.min(this.cfg.maxChunks, available - (parsed.files.length > 0 ? 1 : 0)));
			const totalChunks = chunkText(body, { chunkChars: this.cfg.chunkChars, maxChunks: 999 }).length;
			if (totalChunks > textCapacity) {
				const file = await writeOverflowFile(body, this.cfg, this.log);
				if (file) {
					overflowed = true;
					parsed.files.unshift(file);
					this.log.info(`回答有 ${totalChunks} 段，超过 ${textCapacity} 段上限，全文已写入 ${file}`);
				}
			}
		}

		const filesToSend = parsed.files.slice(0, Math.max(0, Math.min(parsed.files.length, available - (wantText ? 1 : 0))));
		const textSlots = wantText ? Math.max(0, available - filesToSend.length) : 0;
		const chunks = textSlots > 0
			? chunkText(body, {
					chunkChars: this.cfg.chunkChars,
					maxChunks: Math.min(this.cfg.maxChunks, textSlots),
					overflowHint: overflowed ? "……（全文见附件）" : undefined,
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
