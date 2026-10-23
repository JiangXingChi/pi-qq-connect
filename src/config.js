/**
 * 配置加载：~/.pi/agent/pi-qqbot.json + 环境变量覆盖。
 *
 * 环境变量：QQBOT_CONFIG / QQBOT_APP_ID / QQBOT_CLIENT_SECRET / QQBOT_SANDBOX / QQBOT_DISABLED
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function expandHome(p) {
	if (typeof p !== "string" || !p) return p;
	if (p === "~") return os.homedir();
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	return p;
}

/** 每次调用都重新读取 QQBOT_CONFIG，便于测试与运行中切换。 */
export function configPath() {
	return expandHome(process.env.QQBOT_CONFIG) || path.join(os.homedir(), ".pi/agent", "pi-qqbot.json");
}

export const DEFAULT_CONFIG = Object.freeze({
	enabled: true,
	appId: "",
	clientSecret: "",
	sandbox: false,
	allowUsers: [],
	allowGroups: [],
	allowAll: false,
	envelope: true,
	replyPrefix: "",
	replyFormat: "plain", // plain | markdown
	maxChunks: 4, // 官方上限 5，留 1 条余量
	replyQuota: 5, // 发送总次数上限（含回执；重试复用 seq 不额外占）；实际按场景取小：单聊 4、群 5
	chunkChars: 4000,
	typing: true,
	maxQueue: 20,
	emptyReply: "（Pi 这轮没有返回文字）",
	ackAfterMs: 0, // >0 时，任务超过该毫秒数先回一条「收到」
	dedupeTtlMs: 10 * 60 * 1000,
	passiveWindowSec: { group: 300, private: 3600 },
	images: { enabled: true, maxCount: 2, maxBytes: 8 * 1024 * 1024 },
	files: { enabled: true, maxCount: 3, maxBytes: 200 * 1024 * 1024, allowDirs: [] },
	lock: true,
	log: { file: "~/.pi/agent/pi-qqbot.log", level: "info", maxBytes: 2 * 1024 * 1024 },
	endpoints: { token: "", api: "", gateway: "" },
});

const REPLY_FORMATS = new Set(["plain", "markdown"]);
const LEVELS = new Set(["debug", "info", "warn", "error"]);

function mergeSection(base, override) {
	const out = { ...base };
	if (!override || typeof override !== "object" || Array.isArray(override)) return out;
	for (const [key, value] of Object.entries(override)) {
		if (value === undefined) continue;
		const baseValue = base[key];
		if (baseValue && typeof baseValue === "object" && !Array.isArray(baseValue)) {
			out[key] = mergeSection(baseValue, value);
		} else {
			out[key] = value;
		}
	}
	return out;
}

function strList(value) {
	return Array.isArray(value) ? value.filter((v) => typeof v === "string" && v.trim()).map((v) => v.trim()) : [];
}

function boolIn(value, fallback) {
	if (typeof value === "boolean") return value;
	if (value === "true" || value === 1) return true;
	if (value === "false" || value === 0) return false;
	return fallback;
}

function intIn(value, fallback, min, max) {
	const n = Number(value);
	if (!Number.isFinite(n)) return fallback;
	const i = Math.trunc(n);
	return i < min ? min : i > max ? max : i;
}

export function readRawConfig(file = configPath()) {
	if (!fs.existsSync(file)) return { raw: {}, exists: false };
	const text = fs.readFileSync(file, "utf8");
	try {
		const raw = JSON.parse(text);
		return { raw: raw && typeof raw === "object" ? raw : {}, exists: true };
	} catch (err) {
		throw new Error(`配置文件不是合法 JSON（${file}）：${err.message}`);
	}
}

export function normalizeConfig(raw = {}) {
	const cfg = mergeSection(DEFAULT_CONFIG, raw);
	cfg.enabled = boolIn(raw.enabled, true);
	cfg.appId = String(cfg.appId ?? "").trim();
	cfg.clientSecret = String(cfg.clientSecret ?? "").trim();
	cfg.sandbox = boolIn(raw.sandbox, false);
	cfg.allowUsers = strList(cfg.allowUsers);
	cfg.allowGroups = strList(cfg.allowGroups);
	cfg.allowAll = boolIn(raw.allowAll, false);
	cfg.envelope = boolIn(raw.envelope, true);
	cfg.replyPrefix = typeof cfg.replyPrefix === "string" ? cfg.replyPrefix : "";
	cfg.replyFormat = REPLY_FORMATS.has(cfg.replyFormat) ? cfg.replyFormat : "plain";
	cfg.maxChunks = intIn(cfg.maxChunks, 4, 1, 5);
	cfg.replyQuota = intIn(cfg.replyQuota, 5, 1, 5);
	cfg.chunkChars = intIn(cfg.chunkChars, 4000, 100, 4000);
	cfg.maxQueue = intIn(cfg.maxQueue, 20, 1, 200);
	cfg.typing = boolIn(raw.typing, true);
	cfg.emptyReply = typeof cfg.emptyReply === "string" && cfg.emptyReply ? cfg.emptyReply : DEFAULT_CONFIG.emptyReply;
	cfg.ackAfterMs = intIn(cfg.ackAfterMs, 0, 0, 300000);
	cfg.dedupeTtlMs = intIn(cfg.dedupeTtlMs, DEFAULT_CONFIG.dedupeTtlMs, 1000, 86400000);
	cfg.passiveWindowSec = mergeSection(DEFAULT_CONFIG.passiveWindowSec, cfg.passiveWindowSec);
	cfg.passiveWindowSec.group = intIn(cfg.passiveWindowSec.group, 300, 10, 3600);
	cfg.passiveWindowSec.private = intIn(cfg.passiveWindowSec.private, 3600, 10, 86400);
	cfg.images = mergeSection(DEFAULT_CONFIG.images, cfg.images);
	cfg.images.enabled = boolIn(cfg.images.enabled, true);
	cfg.images.maxCount = intIn(cfg.images.maxCount, 2, 0, 10);
	cfg.images.maxBytes = intIn(cfg.images.maxBytes, DEFAULT_CONFIG.images.maxBytes, 1024, 30 * 1024 * 1024);
	cfg.files = mergeSection(DEFAULT_CONFIG.files, cfg.files);
	cfg.files.enabled = boolIn(cfg.files.enabled, true);
	cfg.files.maxCount = intIn(cfg.files.maxCount, 3, 0, 3);
	cfg.files.maxBytes = intIn(cfg.files.maxBytes, DEFAULT_CONFIG.files.maxBytes, 1024, 200 * 1024 * 1024);
	// 类型错误必须 fail-closed：绝不能让 allowDirs 退化成“不限制”
	const rawDirs = cfg.files.allowDirs;
	if (typeof rawDirs === "string") {
		cfg.files.allowDirs = rawDirs.split(",").map((d) => d.trim()).filter(Boolean);
	} else if (Array.isArray(rawDirs)) {
		const dirs = strList(rawDirs);
		if (rawDirs.some((d) => typeof d !== "string" || !d.trim())) cfg.files.enabled = false;
		cfg.files.allowDirs = dirs;
	} else if (rawDirs !== undefined) {
		cfg.files.enabled = false;
		cfg.files.allowDirs = [];
	} else {
		cfg.files.allowDirs = [];
	}
	cfg.lock = boolIn(raw.lock, true);
	cfg.log = mergeSection(DEFAULT_CONFIG.log, cfg.log);
	if (!LEVELS.has(cfg.log.level)) cfg.log.level = "info";
	cfg.log.file = expandHome(cfg.log.file || DEFAULT_CONFIG.log.file);
	cfg.log.maxBytes = intIn(cfg.log.maxBytes, DEFAULT_CONFIG.log.maxBytes, 64 * 1024, 100 * 1024 * 1024);
	cfg.endpoints = mergeSection(DEFAULT_CONFIG.endpoints, cfg.endpoints);
	return cfg;
}

function applyEnv(cfg) {
	if (process.env.QQBOT_APP_ID) cfg.appId = process.env.QQBOT_APP_ID.trim();
	if (process.env.QQBOT_CLIENT_SECRET) cfg.clientSecret = process.env.QQBOT_CLIENT_SECRET.trim();
	if (/^(1|true|yes)$/i.test(process.env.QQBOT_SANDBOX ?? "")) cfg.sandbox = true;
	if (/^(1|true|yes)$/i.test(process.env.QQBOT_DISABLED ?? "")) cfg.enabled = false;
	return cfg;
}

export function validateConfig(cfg) {
	if (!cfg.appId) return "缺少 appId（QQ 开放平台的应用 AppID）";
	if (!/^\d{5,}$/.test(cfg.appId)) return `appId 看起来不对：应为纯数字，当前是 "${cfg.appId}"`;
	if (!cfg.clientSecret) return "缺少 clientSecret（QQ 开放平台的应用密钥）";
	if (!cfg.allowAll && cfg.allowUsers.length === 0 && cfg.allowGroups.length === 0) {
		return "allowUsers / allowGroups 都为空：请填入允许使用的 openid，或设 allowAll=true 明确放行所有人";
	}
	return null;
}

/**
 * @returns {{config: any, path: string, exists: boolean, warnings: string[], error: string|null}}
 */
export function loadConfig(file = configPath()) {
	const warnings = [];
	let raw = {};
	let exists = false;
	try {
		const read = readRawConfig(file);
		raw = read.raw;
		exists = read.exists;
	} catch (err) {
		return { config: normalizeConfig({}), path: file, exists: true, warnings, error: err.message };
	}
	if (!exists) warnings.push(`配置文件不存在：${file}`);
	const config = applyEnv(normalizeConfig(raw));
	if (config.files?.enabled && config.files.allowDirs.length === 0) {
		warnings.push("files.allowDirs 为空：除内置敏感路径外，任意路径都能被 [[file:...]] 发送；建议限定目录");
	}
	const error = exists ? validateConfig(config) : `配置文件不存在：${file}`;
	return { config, path: file, exists, warnings, error };
}
