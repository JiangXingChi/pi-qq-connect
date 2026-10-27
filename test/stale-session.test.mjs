/**
 * 会话切换回归测试（不连 QQ 网关、不碰真实会话）。
 *
 *   P0 isStaleContextError 只认 pi 的 stale 文案
 *   P1 stale 注入 → 暂停注入（不停桥、不无限重试），新实例接手后自动恢复
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

test("P1 stale 注入只暂停，接棒后恢复", async (t) => {
	const logs = [];
	const notes = [];
	const sends = [];
	let attempts = 0;
	const stalePi = {
		sendUserMessage() {
			attempts++;
			throw new Error(STALE);
		},
	};
	const bridge = new QqBridge({
		pi: stalePi,
		api: {
			sendText: async (target, content) => {
				sends.push({ target, content });
			},
		},
		config: makeCfg(),
		log: makeLog(logs),
		notify: (message) => notes.push(message),
		isOnline: () => true,
		onNewSession: () => {},
		injectTimeoutMs: 0,
	});
	bridge.enqueue(makeItem());
	await waitFor(() => bridge.stale === true, { label: "进入 stale 状态" });

	await t.test("桥没有自毁（网关仍在）", () => assert.equal(bridge.stopped, false));
	await t.test("标记 stale 并停止重试", () => {
		assert.equal(bridge.stale, true);
		assert.equal(bridge.retryTimer, undefined);
		assert.equal(bridge.injectTimer, undefined);
		assert.equal(attempts, 1, "stale 后不应再重试注入");
	});
	await t.test("没处理的消息留在队列里等接棒", () => {
		assert.equal(bridge.inflight, undefined);
		assert.equal(bridge.queue.length, 1);
	});
	await t.test("stale 只记一次 error，不再打「等空闲后重试」", () => {
		const staleLines = logs.filter((l) => /stale after session replacement/i.test(l.message));
		assert.equal(staleLines.length, 1, `stale 记录 ${staleLines.length} 条`);
		assert.equal(logs.filter((l) => l.message.includes("等空闲后重试")).length, 0);
	});
	await t.test("提示不再要求用户手动 /qq stop", () => {
		assert.ok(notes.some((n) => n.includes("自动恢复")), "缺少自动恢复提示");
		assert.ok(sends.some((s) => String(s.content).includes("接棒")), "缺少给 QQ 的提示");
	});

	await t.test("新实例接手后自动恢复（走生产路径 adopt + endSwitch）", async () => {
		const injected = [];
		bridge.adopt({
			sendUserMessage(content) {
				injected.push(content);
			},
		});
		assert.equal(bridge.stale, false);
		bridge.endSwitch();
		await waitFor(() => injected.length >= 1, { label: "接棒后重新注入积压消息" });
		assert.equal(bridge.queue.length, 0, "积压消息应被处理完");
	});
	bridge.stop();
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
	let adopted = 0;
	state.bridge = {
		pi: null,
		switching: false,
		adopt(pi) {
			adopted++;
			this.pi = pi;
		},
		endSwitch() {
			ended++;
			this.switching = false;
		},
		beginSwitch() {
			this.switching = true;
		},
		pump() {},
		reset() {},
	};
	const secondCtx = makeCtx();
	const before = notifications.length;
	// 真实时序：先 session_shutdown（暂停注入），再 session_start（接棒收尾）
	await fake.emit("session_shutdown", { reason: "new" });
	await t.test("shutdown 时进入切换态", () => assert.equal(state.bridge.switching, true));
	await fake.emit("session_start", { reason: "new" }, secondCtx);
	await sleep(120);

	await t.test("有桥时只切换、不重建", () => {
		assert.equal(ended, 1);
		assert.equal(notifications.length, before, "不应再触发 start()");
	});
	await t.test("有桥时刷新 bridge.pi", () => assert.equal(state.bridge.pi, fake.pi));

	await fake.emit("session_shutdown", { reason: "resume" });
	await fake.emit("session_start", { reason: "resume" }, makeCtx());
	await t.test("resume 同样接棒并结束切换", () => {
		assert.equal(adopted, 2);
		assert.equal(ended, 2);
		assert.equal(state.ctx, nextCtx);
	});

	// 没有经历 beginSwitch 的 session_start（例如 reload 后重放）不能重置健康会话
	const endedBefore = ended;
	await fake.emit("session_start", { reason: "startup" }, makeCtx());
	await t.test("无切换态时不调 endSwitch", () => assert.equal(ended, endedBefore));
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
