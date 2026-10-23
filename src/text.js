/**
 * QQ 事件归一化、提示词拼装、Markdown 清理、分片。
 *
 * 分片逻辑参考 Hermes 官方 QQ Bot 适配器（gateway/platforms/base.py 的
 * truncate_message）：保住代码围栏、多段时加 (i/n) 标记、优先在换行处切。
 */

const GROUP_AT_EVENT = "GROUP_AT_MESSAGE_CREATE";
const GROUP_MSG_EVENT = "GROUP_MESSAGE_CREATE";
const C2C_EVENT = "C2C_MESSAGE_CREATE";
const QUOTE_MESSAGE_TYPE = 103;
const MAX_CONTENT_CHARS = 4000; // QQ 单条文本上限，Hermes 也用这个值

export function maskId(id) {
	const s = String(id ?? "");
	if (s.length <= 12) return s;
	return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

function normalizeAttachment(raw) {
	if (!raw || typeof raw !== "object") return null;
	const contentType = typeof raw.content_type === "string" ? raw.content_type : "";
	let url = typeof raw.url === "string" ? raw.url.trim() : "";
	if (url.startsWith("//")) url = `https:${url}`;
	const voiceText = typeof raw.asr_refer_text === "string" ? raw.asr_refer_text.trim() : "";
	const voiceUrl = typeof raw.voice_wav_url === "string" ? raw.voice_wav_url.trim() : "";
	return {
		contentType,
		filename: typeof raw.filename === "string" ? raw.filename : "",
		size: Number(raw.size) > 0 ? Number(raw.size) : 0,
		url,
		voiceText,
		voiceUrl,
	};
}

/** 群聊正文里可能带 @机器人 的残留（"@名字 " 或 "<@!123>"），去掉。 */
export function stripMentions(text) {
	return String(text ?? "")
		.replace(/<@!?\d+>/g, " ")
		.replace(/^@\S+\s*/, "")
		.replace(/[ \t]{2,}/g, " ")
		.trim();
}

/**
 * 引用消息（message_type=103）里的上下文。
 * @returns {{text:string, imageUrls:string[], others:string[]}|null}
 */
export function extractQuote(d) {
	let isQuote = false;
	try {
		isQuote = Number(d?.message_type ?? 0) === QUOTE_MESSAGE_TYPE;
	} catch {
		isQuote = false;
	}
	if (!isQuote) return null;
	const elements = Array.isArray(d?.msg_elements) ? d.msg_elements.filter((e) => e && typeof e === "object") : [];
	if (elements.length === 0) return null;

	const texts = elements.map((e) => stripMentions(String(e.content ?? ""))).filter(Boolean);
	const attachments = elements
		.flatMap((e) => (Array.isArray(e.attachments) ? e.attachments : []))
		.map(normalizeAttachment)
		.filter(Boolean);
	const imageUrls = attachments.filter((a) => a.contentType.startsWith("image/") && a.url).map((a) => a.url);
	const others = attachments
		.filter((a) => !a.contentType.startsWith("image/"))
		.map((a) => `[${a.filename || a.contentType || "附件"}]`);

	if (texts.length === 0 && imageUrls.length === 0 && others.length === 0) return null;
	return { text: texts.join(" "), imageUrls, others };
}

/**
 * @returns {{kind:"group"|"private", chatId:string, userId:string, msgId:string, text:string,
 *            attachments:Array<object>, quote:object|null, receivedAt:number}|null}
 */
export function normalizeEvent(type, d) {
	if (!d || typeof d !== "object") return null;
	const msgId = typeof d.id === "string" ? d.id : "";
	if (!msgId) return null;
	const raw = typeof d.content === "string" ? d.content.trim() : "";
	const text = type === C2C_EVENT ? raw : stripMentions(raw);
	const attachments = Array.isArray(d.attachments) ? d.attachments.map(normalizeAttachment).filter(Boolean) : [];
	const quote = extractQuote(d);
	const receivedAt = Date.now();

	if (type === C2C_EVENT) {
		const userId = d.author?.user_openid;
		if (!userId) return null;
		return { kind: "private", chatId: userId, userId, msgId, text, attachments, quote, receivedAt };
	}
	if (type === GROUP_AT_EVENT || type === GROUP_MSG_EVENT) {
		const chatId = d.group_openid;
		if (!chatId) return null;
		const userId = d.author?.member_openid ?? "";
		return { kind: "group", chatId, userId, msgId, text, attachments, quote, receivedAt };
	}
	return null;
}

export function chatKey(item) {
	return `${item.kind}:${item.chatId}`;
}

function matchesList(list, id) {
	if (!Array.isArray(list)) return false;
	const value = String(id ?? "");
	return list.some((entry) => entry === "*" || entry === value || (entry.endsWith("*") && value.startsWith(entry.slice(0, -1))));
}

/** allowAll 优先；群看 allowGroups，私聊看 allowUsers。 */
export function isAllowed(item, cfg) {
	if (cfg.allowAll) return true;
	return item.kind === "group" ? matchesList(cfg.allowGroups, item.chatId) : matchesList(cfg.allowUsers, item.userId);
}

export function stripMarkdown(input) {
	let text = String(input ?? "");
	text = text.replace(/```[a-zA-Z0-9_+-]*\n?/g, "").replace(/```/g, "");
	text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, "$1（$2）");
	text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1（$2）");
	text = text.replace(/^#{1,6}\s+/gm, "");
	text = text.replace(/^\s*>\s?/gm, "");
	text = text.replace(/^\s*([-*_])\1{2,}\s*$/gm, "");
	text = text.replace(/\*\*\*([^*]+)\*\*\*/g, "$1");
	text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
	text = text.replace(/(^|[^\w*])\*([^*\n]+)\*(?![\w*])/g, "$1$2");
	text = text.replace(/~~([^~]+)~~/g, "$1");
	text = text.replace(/`([^`\n]+)`/g, "$1");
	text = text.replace(/[ \t]+\n/g, "\n");
	text = text.replace(/\n{3,}/g, "\n\n");
	return text.trim();
}

/** 围栏状态：返回 {open, lang}。 */
function fenceState(text) {
	let open = false;
	let lang = "";
	for (const line of text.split("\n")) {
		const match = line.match(/^\s*```(\w*)/);
		if (!match) continue;
		if (!open) {
			open = true;
			lang = match[1] || "";
		} else {
			open = false;
			lang = "";
		}
	}
	return { open, lang };
}

const INDICATOR_RESERVE = 10; // " (12/12)" 之类的余量

/**
 * 保住代码围栏的分片：切在换行处优先，跨块时关掉再重开围栏；
 * 多段时每段末尾加 (i/n)。单块内容上限 4000（QQ 文本上限）。
 */
function splitFenced(text, limit) {
	const chunks = [];
	let rest = text;
	let carryLang = null;
	let guard = 0;
	while (rest.length > 0 && guard++ < 500) {
		const prefix = carryLang !== null ? `\`\`\`${carryLang}\n` : "";
		if (prefix.length + rest.length <= limit) {
			let chunk = prefix + rest;
			if (carryLang !== null && fenceState(chunk).open) chunk += "\n```";
			chunks.push(chunk);
			break;
		}
		const headroom = Math.max(1, limit - prefix.length - 5);
		let cut = rest.lastIndexOf("\n", headroom);
		if (cut < Math.floor(headroom * 0.5)) cut = rest.lastIndexOf(" ", headroom);
		if (cut <= 0) cut = headroom;
		let chunk = prefix + rest.slice(0, cut);
		const state = fenceState(chunk);
		if (state.open) {
			chunk += "\n```";
			carryLang = state.lang;
		} else {
			carryLang = null;
		}
		chunks.push(chunk);
		rest = rest.slice(cut).replace(/^\n/, "");
	}
	return chunks;
}

/**
 * 分段并加上 (i/n)；超过 maxChunks 时只发前 maxChunks 段，最后一段带提示。
 */
export function chunkText(
	text,
	{ chunkChars = MAX_CONTENT_CHARS, maxChunks = 4, overflowHint = "……（内容过长，完整结果见 Pi 终端）" } = {},
) {
	const normalized = String(text ?? "").trim();
	if (!normalized) return [];
	const limit = Math.max(200, Math.min(chunkChars, MAX_CONTENT_CHARS));
	const raw = splitFenced(normalized, Math.max(100, limit - INDICATOR_RESERVE));

	let chunks = raw.filter((c) => c.trim());
	if (chunks.length > 1) {
		chunks = chunks.map((chunk, i) => `${chunk} (${i + 1}/${chunks.length})`);
	}
	if (chunks.length <= maxChunks) return chunks;

	const kept = chunks.slice(0, maxChunks);
	const last = kept[maxChunks - 1] ?? "";
	const hint = `\n${overflowHint}`;
	const room = Math.max(0, limit - hint.length);
	kept[maxChunks - 1] = (last.length > room ? last.slice(0, room) : last) + hint;
	return kept;
}

/**
 * 拼成 Pi 的用户消息：信封头 + 引用 + 正文 + 附件说明。
 * @returns {{text:string, imageUrls:string[]}}
 */
export function buildPrompt(item, cfg) {
	const lines = [];
	if (cfg.envelope) {
		const where =
			item.kind === "group" ? `QQ群聊 · 群 ${maskId(item.chatId)} · 成员 ${maskId(item.userId)}` : `QQ单聊 · 用户 ${maskId(item.userId)}`;
		lines.push(`[${where}]`);
	}

	const imageUrls = [];
	const maxImages = cfg.images?.maxCount ?? 2;
	if (item.quote) {
		const quoted = [item.quote.text, ...(item.quote.others ?? [])].filter(Boolean).join(" ");
		lines.push(`[引用的消息] ${quoted || "（图片）"}`);
		if (cfg.images?.enabled) {
			for (const url of item.quote.imageUrls ?? []) {
				if (imageUrls.length < maxImages) imageUrls.push(url);
			}
		}
	}

	if (item.text) lines.push(item.text);

	for (const att of item.attachments) {
		if (att.contentType.startsWith("image/") && att.url && cfg.images?.enabled) {
			if (imageUrls.length < maxImages) {
				imageUrls.push(att.url);
				lines.push(`[图片附件 ${imageUrls.length}]`);
			} else {
				lines.push(`[图片附件（超出 ${maxImages} 张，已忽略）]`);
			}
			continue;
		}
		if (att.voiceText) {
			lines.push(`[语音消息转写] ${att.voiceText}`);
			continue;
		}
		const name = att.filename || att.contentType || "附件";
		lines.push(`[附件：${name}${att.url ? ` ${att.url}` : ""}]`);
	}
	if (!item.text && item.attachments.length === 0 && !item.quote) {
		lines.push("（对方只 @ 了你，没有文字）");
	}
	if (cfg.files?.enabled) {
		lines.push(
			`[插件提示] 需要把本地文件发给对方时，在回复末尾单独写一行 [[file:/绝对路径]]（最多 ${cfg.files.maxCount} 个，支持图片和任意文件）。`,
		);
	}
	return { text: lines.join("\n"), imageUrls };
}

export function replyTarget(item, msgIdOverride) {
	return {
		type: item.kind === "group" ? "group" : "private",
		openid: item.chatId,
		msgId: msgIdOverride || item.msgId,
	};
}
