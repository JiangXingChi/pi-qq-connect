/**
 * 桥的命令路径与长回答落盘：用假 api/pi 驱动，不连 QQ。
 * 运行：node --test test/
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { normalizeConfig } from "../src/config.js";
import { QqBridge, writeOverflowFile } from "../src/session.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeLog() {
	const lines = [];
	const push = (level) => (msg) => lines.push(`${level}:${msg}`);
	return {
		lines,
		debug: push("debug"),
		info: push("info"),
		warn: push("warn"),
		error: push("error"),
		tail: (n) => lines.slice(-n),
	};
}

function fakeApi() {
	const sent = [];
	const media = [];
	return {
		sent,
		media,
		auth: { getToken: async () => "token" },
		sendText: async (target, text, options) => {
			sent.push({ target, text, options });
			return { ok: true };
		},
		sendMarkdown: async (target, text) => {
			sent.push({ target, text, markdown: true });
			return { ok: true };
		},
		sendMedia: async (target, fileInfo) => {
			media.push({ target, fileInfo });
			return { ok: true };
		},
	};
}

function fakePi() {
	const calls = [];
	return {
		calls,
		sendUserMessage: (content, options) => calls.push({ content, options }),
	};
}

function makeBridge({ onCommand, config = {} } = {}) {
	const api = fakeApi();
	const pi = fakePi();
	const cfg = normalizeConfig({ allowAll: true, replyFormat: "plain", ...config });
	const log = fakeLog();
	const bridge = new QqBridge({ pi, api, config: cfg, log, notify: () => {}, isOnline: async () => true, onCommand });
	return { bridge, api, pi, cfg, log };
}

function chatItem(text, id = "m1") {
	return { kind: "private", chatId: "c1", userId: "u1", msgId: id, text, at: Date.now(), attachments: [], quote: undefined };
}

test("斜杠命令不进队列、不喂模型，直接回执", async () => {
	const { bridge, api, pi } = makeBridge({ onCommand: async () => ({ text: "模型清单" }) });
	const result = bridge.enqueue(chatItem("/model"));
	assert.equal(result.handled, true);
	await sleep(20);
	assert.equal(pi.calls.length, 0, "命令不能被注入给模型");
	assert.equal(bridge.queue.length, 0);
	assert.deepEqual(
		api.sent.map((item) => item.text),
		["模型清单"],
	);
});

test("技能/模板类命令交给 Pi 展开执行", async () => {
	const { bridge, api, pi } = makeBridge({ onCommand: async () => ({ forward: true }) });
	bridge.enqueue(chatItem("/skill:a-stock-data 查询行情"));
	await sleep(20);
	assert.equal(api.sent.length, 0);
	assert.equal(pi.calls.length, 1);
	assert.equal(pi.calls[0].options?.expandPromptTemplates, true);
});

test("普通消息照常注入，且不带 expandPromptTemplates", async () => {
	const { bridge, pi } = makeBridge({ onCommand: async () => null });
	bridge.enqueue(chatItem("帮我看看这个仓库"));
	await sleep(20);
	assert.equal(pi.calls.length, 1);
	assert.equal(pi.calls[0].options, undefined);
});

test("命令处理器抛错时回一句失败，不让消息消失", async () => {
	const { bridge, api } = makeBridge({
		onCommand: async () => {
			throw new Error("boom");
		},
	});
	bridge.enqueue(chatItem("/new"));
	await sleep(20);
	assert.equal(api.sent.length, 1);
	assert.match(api.sent[0].text, /命令执行失败：boom/);
});

test("换会话期间的消息暂存，结束后放回队列", async () => {
	const { bridge, api, pi } = makeBridge({
		onCommand: async (command) => (command.name === "new" ? { text: "✅ 已开新会话" } : null),
	});
	bridge.beginSwitch();
	bridge.enqueue(chatItem("切换中发的消息", "m2"));
	assert.equal(bridge.queue.length, 0);
	assert.equal(bridge.deferred.length, 1);
	await sleep(10);
	assert.equal(api.sent.length, 0, "暂存期间不该发任何东西");
	bridge.endSwitch();
	await sleep(20);
	assert.equal(bridge.deferred.length, 0);
	assert.equal(pi.calls.length, 1, "暂存的消息在切换后恢复注入");
});

test("换会话失败时取消暂存，队列不被清空", async () => {
	const { bridge, pi } = makeBridge({ onCommand: async () => null });
	bridge.beginSwitch();
	bridge.enqueue(chatItem("切换中发的消息", "m3"));
	bridge.cancelSwitch();
	await sleep(20);
	assert.equal(pi.calls.length, 1);
});

test("取消切换后不再暂存，消息立刻恢复处理", async () => {
	const { bridge, pi } = makeBridge({ onCommand: async () => null });
	bridge.beginSwitch();
	bridge.cancelSwitch();
	bridge.enqueue(chatItem("取消之后的消息", "m4"));
	await sleep(20);
	assert.equal(bridge.switching, false);
	assert.equal(pi.calls.length, 1);
});

test("队列满时命令仍然能执行（/new 不被丢）", async () => {
	const { bridge, api } = makeBridge({ onCommand: async () => ({ text: "开新会话中" }), config: { maxQueue: 1 } });
	bridge.queue.push(chatItem("占位", "m10"));
	bridge.queue.push(chatItem("占位2", "m11"));
	bridge.enqueue(chatItem("/new", "m12"));
	await sleep(20);
	assert.deepEqual(
		api.sent.map((item) => item.text),
		["开新会话中"],
	);
});

test("长回答落盘：文件名带时间戳，内容完整", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piqq-reply-"));
	const log = fakeLog();
	const body = "第一段\n".repeat(5000);
	const file = await writeOverflowFile(body, normalizeConfig({ replyDir: dir }), log);
	assert.ok(file && file.startsWith(dir), `应当落在 ${dir} 下，实际 ${file}`);
	assert.match(path.basename(file), /^reply-\d{8}-\d{6}-\d{4}\.md$/);
	assert.equal(fs.readFileSync(file, "utf8"), `${body}\n`);
});

test("落盘失败返回 null（调用方退回截断）", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piqq-reply-"));
	const blocker = path.join(dir, "not-a-dir");
	fs.writeFileSync(blocker, "x");
	const log = fakeLog();
	const file = await writeOverflowFile("正文", normalizeConfig({ replyDir: path.join(blocker, "sub") }), log);
	assert.equal(file, null);
	assert.ok(log.lines.some((line) => line.startsWith("warn:长回答落盘失败")));
});
