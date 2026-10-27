/**
 * 会话切换回归测试（不连 QQ 网关、不碰真实会话）。
 *
 *   P0 isStaleContextError 只认 pi 的 stale 文案
 *   P1 stale 注入 → 停桥 + 一次性告警 + onFatal，不再每 2 秒无限重试
 *   P2 session_start(new|resume|fork) 且没有活动桥 → 重建（自愈）
 *   P3 switchSession 按 pi 文档传 withSession
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { DEFAULT_CONFIG } from "../src/config.js";
import { QqBridge, isStaleContextError } from "../src/session.js";
import { createFakePi, sleep, tempConfigPath, waitFor, writeConfig } from "./harness.mjs";

const STALE = "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().";

function makeLog(sink) {
	const push = (level) => (message) => sink.push({ level, message: String(message) });
	return { debug() {}, info: push("info"), warn: push("warn"), error: push("error"), tail: () => [] };
}

function makeCfg() {
	return {
		...DEFAULT_CONFIG,
		allowAll: true,
		typing: false,
		ackAfterMs: 0,
		images: { ...DEFAULT_CONFIG.images, enabled: false },
	};
}

function makeItem(id = "m1") {
	return {
		kind: "private",
		chatId: "chat-1",
		userId: "user-1",
		msgId: id,
		text: "hello",
		receivedAt: Date.now(),
		attachments: [],
	};
}

test("P0 isStaleContextError 识别", async (t) => {
	await t.test("命中 pi 1.4 的 stale 文案", () => {
		assert.equal(isStaleContextError(new Error(STALE)), true);
		assert.equal(isStaleContextError(STALE), true);
	});
	await t.test("不误伤普通错误", () => {
		assert.equal(isStaleContextError(new Error("Still streaming, try again")), false);
		assert.equal(isStaleContextError(undefined), false);
	});
});

test("P1 stale 注入不再无限重试", async (t) => {
	const logs = [];
	const notes = [];
	let fatal = 0;
	const bridge = new QqBridge({
		pi: {
			sendUserMessage() {
				throw new Error(STALE);
			},
		},
		api: { sendText: () => ({}) },
		config: makeCfg(),
		log: makeLog(logs),
		notify: (message) => notes.push(message),
		isOnline: () => true,
		onNewSession: () => {},
		onFatal: (err) => {
			fatal++;
			assert.equal(isStaleContextError(err), true);
		},
		injectTimeoutMs: 0,
	});
	bridge.enqueue(makeItem());
	await sleep(300);

	await t.test("桥已停止", () => assert.equal(bridge.stopped, true));
	await t.test("没有残留重试定时器", () => {
		assert.equal(bridge.retryTimer, undefined);
		assert.equal(bridge.injectTimer, undefined);
	});
	await t.test("队列清空、无 inflight", () => {
		assert.equal(bridge.queue.length, 0);
		assert.equal(bridge.inflight, undefined);
	});
	await t.test("onFatal 只调用一次", () => assert.equal(fatal, 1));
	await t.test("stale 只记一次 error，不再打「等空闲后重试」", () => {
		const staleLines = logs.filter((l) => /stale after session replacement/i.test(l.message));
		assert.equal(staleLines.length, 1, `stale 记录 ${staleLines.length} 条`);
		assert.equal(logs.filter((l) => l.message.includes("等空闲后重试")).length, 0);
	});
	await t.test("给 QQ 的提示带 /qq stop", () => {
		assert.ok(notes.some((n) => n.includes("/qq stop")), "缺少 /qq stop 提示");
	});
});

test("P1 非 stale 错误仍保留原有重试行为（防回归）", async (t) => {
	const logs = [];
	const bridge = new QqBridge({
		pi: {
			sendUserMessage() {
				throw new Error("Pi 正在流式输出");
			},
		},
		api: { sendText: () => ({}) },
		config: makeCfg(),
		log: makeLog(logs),
		notify: () => {},
		isOnline: () => true,
		onNewSession: () => {},
		injectTimeoutMs: 0,
	});
	bridge.enqueue(makeItem());
	await sleep(120);

	await t.test("放回队首并安排重试", () => {
		assert.equal(bridge.stopped, false);
		assert.equal(bridge.injecting, true);
		assert.ok(bridge.retryTimer);
		assert.equal(bridge.queue.length, 1);
		assert.ok(logs.some((l) => l.message.includes("等空闲后重试")));
	});
	bridge.stop();
	await sleep(50);
});

// 这一组必须让扩展读到临时配置：先设环境变量再 import index.js
const cfgFile = tempConfigPath();
writeConfig(cfgFile, {
	enabled: false,
	appId: "1234567890",
	clientSecret: "test-secret",
	allowAll: true,
	log: { file: path.join(path.dirname(cfgFile), "test.log"), level: "info" },
});
process.env.PIQQCONNECT_CONFIG = cfgFile;

test("P2 session_start 没有活动桥时自愈", async (t) => {
	const mod = await import("../index.js");
	const fake = createFakePi();
	const state = mod.default(fake.pi);

	const notifications = [];
	let nextCtx;
	const makeCtx = () => {
		const ctx = {
			cwd: path.dirname(cfgFile),
			ui: {
				notify(message, level) {
					notifications.push({ message, level });
				},
				setStatus() {},
			},
		};
		nextCtx = ctx;
		return ctx;
	};

	assert.equal(state.bridge, undefined, "初始不应有桥");

	const firstCtx = makeCtx();
	await fake.emit("session_start", { reason: "new" }, firstCtx);

	await t.test("无桥时提示并尝试重建（start 被执行）", async () => {
		await waitFor(() => notifications.some((n) => n.message.includes("enabled=false")), {
			label: "start() 走到 enabled=false 分支",
		});
		assert.ok(
			notifications.some((n) => n.message.includes("当前没有活动桥")),
			"缺少重建提示",
		);
	});
	await t.test("state.ctx 指向新会话上下文", () => assert.equal(state.ctx, firstCtx));

	let ended = 0;
	let reset = 0;
	state.bridge = {
		pi: null,
		endSwitch: () => {
			ended++;
		},
		reset: () => {
			reset++;
		},
	};
	const secondCtx = makeCtx();
	const before = notifications.length;
	await fake.emit("session_start", { reason: "new" }, secondCtx);
	await sleep(120);

	await t.test("有桥时只切换、不重建", () => {
		assert.equal(ended, 1);
		assert.equal(notifications.length, before, "不应再触发 start()");
	});
	await t.test("有桥时刷新 bridge.pi", () => assert.equal(state.bridge.pi, fake.pi));

	await fake.emit("session_start", { reason: "resume" }, makeCtx());
	await t.test("resume 时重置队列", () => {
		assert.equal(reset, 1);
		assert.equal(state.ctx, nextCtx);
	});
	state.bridge = undefined;
});

test("P3 switchSession 按 pi 文档传 withSession", () => {
	const src = fs.readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
	const start = src.indexOf("async function switchSession");
	const end = src.indexOf("function requestNewSession");
	assert.ok(start > 0 && end > start, "找不到 switchSession 代码块");
	const block = src.slice(start, end);
	assert.ok(block.includes("withSession"), "switchSession 没有传 withSession");
	assert.ok(block.includes("state.ctx = next"), "withSession 里没刷新 state.ctx");
});
