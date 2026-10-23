import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { normalizeConfig, validateConfig } from "../src/config.js";
import { buildPrompt, chunkText, isAllowed, normalizeEvent, stripMarkdown } from "../src/text.js";
import { QqBridge } from "../src/session.js";
import { acquireLock, readLock, releaseLock } from "../src/lock.js";
import {
	describeService,
	isProcessAlive,
	isServiceAlive,
	readServiceState,
	removeServiceState,
	serviceStatePath,
	stopService,
	writeServiceState,
} from "../src/service.js";
import { createFakeCtx, createFakePi, sleep, tempConfigPath, waitFor, writeConfig } from "./harness.mjs";
import { c2cEvent, groupAtEvent, startMockQq } from "./mock-qq.mjs";

const silentLog = { debug() {}, info() {}, warn() {}, error() {} };

function stubApi({ markdownFails = false, failFirst = 0, failStatus = 500 } = {}) {
	const sends = [];
	const attempts = [];
	const typings = [];
	let failuresLeft = failFirst;
	const api = {
		sends,
		attempts,
		typings,
		auth: { getToken: async () => "test-token" },
		async sendText(target, content, meta) {
			attempts.push({ content, ...meta });
			if (failuresLeft > 0) {
				failuresLeft--;
				const error = new Error(failStatus === 400 ? "invalid request" : "server error");
				error.status = failStatus;
				throw error;
			}
			sends.push({ target, content, ...meta, format: "text" });
		},
		async sendMarkdown(target, content, meta) {
			if (markdownFails) throw new Error("markdown not allowed");
			sends.push({ target, content, ...meta, format: "markdown" });
		},
		async sendTyping(target, meta) {
			typings.push({ target, ...meta });
		},
	};
	return api;
}

function privateItem(overrides = {}) {
	return {
		kind: "private",
		chatId: "user-1",
		userId: "user-1",
		msgId: "msg-1",
		text: "你好",
		attachments: [],
		receivedAt: Date.now(),
		...overrides,
	};
}

// ---------------------------------------------------------------- 配置

test("配置：默认值与被夹取的范围", () => {
	const cfg = normalizeConfig({});
	assert.equal(cfg.replyFormat, "plain");
	assert.equal(cfg.maxChunks, 4);
	assert.equal(cfg.chunkChars, 4000);
	assert.equal(cfg.typing, true);
	assert.equal(cfg.enabled, true);

	const weird = normalizeConfig({ maxChunks: 99, chunkChars: 5, replyFormat: "html", allowUsers: [" a ", 3, ""] });
	assert.equal(weird.maxChunks, 5);
	assert.equal(weird.chunkChars, 100);
	assert.equal(weird.replyFormat, "plain");
	assert.deepEqual(weird.allowUsers, ["a"]);
});

test("配置：校验缺凭据与空权限", () => {
	assert.match(validateConfig(normalizeConfig({})), /appId/);
	const noSecret = normalizeConfig({ appId: "1234567890" });
	assert.match(validateConfig(noSecret), /clientSecret/);
	const noAccess = normalizeConfig({ appId: "1234567890", clientSecret: "x" });
	assert.match(validateConfig(noAccess), /allowUsers/);
	const ok = normalizeConfig({ appId: "1234567890", clientSecret: "x", allowAll: true });
	assert.equal(validateConfig(ok), null);
	const aliased = normalizeConfig({ appId: "1234567890", clientSecret: "x", allowUsers: ["u1"] });
	assert.equal(validateConfig(aliased), null);
});

// ---------------------------------------------------------------- 文本

test("文本：事件归一化（群/单聊）", () => {
	const group = normalizeEvent("GROUP_AT_MESSAGE_CREATE", groupAtEvent({ msgId: "m1", groupOpenId: "g1", memberOpenId: "u1", content: " hi " }));
	assert.equal(group.kind, "group");
	assert.equal(group.chatId, "g1");
	assert.equal(group.userId, "u1");
	assert.equal(group.text, "hi");

	const c2c = normalizeEvent("C2C_MESSAGE_CREATE", c2cEvent({ msgId: "m2", userOpenId: "u2", content: "yo" }));
	assert.equal(c2c.kind, "private");
	assert.equal(c2c.userId, "u2");

	assert.equal(normalizeEvent("C2C_MESSAGE_CREATE", {}), null);
	assert.equal(normalizeEvent("UNKNOWN", { id: "x" }), null);
});

test("文本：@ 前缀与引用消息", () => {
	const group = normalizeEvent(
		"GROUP_AT_MESSAGE_CREATE",
		groupAtEvent({ msgId: "m3", groupOpenId: "g1", memberOpenId: "u1", content: "<@!123456> 查一下日志" }),
	);
	assert.equal(group.text, "查一下日志");

	const quoted = normalizeEvent("C2C_MESSAGE_CREATE", {
		...c2cEvent({ msgId: "m4", userOpenId: "u2", content: "追问" }),
		message_type: 103,
		msg_elements: [{ content: "原来的问题" }, { content: "补充" }],
	});
	assert.equal(quoted.quote.text, "原来的问题 补充");
	const prompt = buildPrompt(quoted, normalizeConfig({ envelope: false }));
	assert.match(prompt.text, /\[引用的消息\] 原来的问题 补充/);
	assert.match(prompt.text, /追问/);
});

test("文本：跨块保留代码围栏", () => {
	const code = "```js\n" + Array.from({ length: 40 }, (_, i) => `const a${i} = ${i};`).join("\n") + "\n```";
	const chunks = chunkText(code, { chunkChars: 300, maxChunks: 6 });
	assert.ok(chunks.length > 1);
	for (const chunk of chunks) {
		const fences = (chunk.match(/```/g) ?? []).length;
		assert.equal(fences % 2, 0, `围栏不平衡：${chunk.slice(0, 40)}`);
	}
});

test("文本：权限匹配", () => {
	const cfg = normalizeConfig({ allowAll: false, allowUsers: ["u1", "abc*"], allowGroups: ["g1"] });
	assert.equal(isAllowed(privateItem({ userId: "u1" }), cfg), true);
	assert.equal(isAllowed(privateItem({ userId: "abc123" }), cfg), true);
	assert.equal(isAllowed(privateItem({ userId: "u2" }), cfg), false);
	assert.equal(isAllowed({ kind: "group", chatId: "g1", userId: "x" }, cfg), true);
	assert.equal(isAllowed(privateItem(), normalizeConfig({ allowAll: true })), true);
});

test("文本：Markdown 清理与信封", () => {
	const raw = "## 标题\n\n**粗体** 和 `代码`\n\n```js\nconst a = 1;\n```\n\n[链接](https://example.com)";
	const plain = stripMarkdown(raw);
	assert.doesNotMatch(plain, /\*\*|```|##/);
	assert.match(plain, /粗体/);
	assert.match(plain, /链接（https:\/\/example\.com）/);

	const prompt = buildPrompt(privateItem({ text: "看看这个" }), normalizeConfig({ envelope: true }));
	assert.match(prompt.text, /^\[QQ单聊 · 用户 user-1\]/);
	assert.match(prompt.text, /看看这个/);
});

test("文本：分片遵守 chunkChars / maxChunks", () => {
	const text = Array.from({ length: 12 }, (_, i) => `第${i}段内容`.repeat(10)).join("\n\n");
	const chunks = chunkText(text, { chunkChars: 200, maxChunks: 3 });
	assert.equal(chunks.length, 3);
	for (const chunk of chunks) assert.ok(chunk.length <= 200, `块长度 ${chunk.length}`);
	assert.match(chunks[2], /内容过长/);
});

// ---------------------------------------------------------------- 桥

test("桥：注入 → 收集 → 被动回复", async () => {
	const fake = createFakePi();
	const api = stubApi();
	const bridge = new QqBridge({ pi: fake.pi, api, config: normalizeConfig({ allowAll: true }), log: silentLog });

	assert.deepEqual(bridge.enqueue(privateItem()), { accepted: true });
	await waitFor(() => fake.sent.length === 1, { label: "注入 Pi" });
	assert.match(fake.sent[0].content, /你好/);

	bridge.onAgentStart();
	bridge.onMessageEnd({ role: "assistant", content: [{ type: "text", text: "**回复**内容" }] });
	bridge.onAgentSettled(false);

	await waitFor(() => api.sends.length === 1, { label: "被动回复" });
	assert.equal(api.sends[0].content, "回复内容");
	assert.equal(api.sends[0].msgId, "msg-1");
	assert.ok(api.sends[0].msgSeq >= 1 && api.sends[0].msgSeq < 65536);
	assert.equal(api.sends[0].target.type, "private");
});

test("桥：单聊会发「正在输入」", async () => {
	const fake = createFakePi();
	const api = stubApi();
	const bridge = new QqBridge({ pi: fake.pi, api, config: normalizeConfig({ allowAll: true, typing: true }), log: silentLog });
	bridge.enqueue(privateItem());
	await waitFor(() => api.typings.length === 1, { label: "typing" });
	assert.equal(api.typings[0].target.type, "private");
	assert.equal(api.typings[0].msgId, "msg-1");
	bridge.onAgentStart();
	bridge.onMessageEnd({ role: "assistant", content: "好" });
	bridge.onAgentSettled(false);
	await waitFor(() => api.sends.length === 1);
});

test("桥：发送失败会换新 seq 重试，永久错误不重试", async () => {
	const fake = createFakePi();
	const api = stubApi({ failFirst: 1, failStatus: 500 });
	const bridge = new QqBridge({ pi: fake.pi, api, config: normalizeConfig({ allowAll: true }), log: silentLog });
	bridge.enqueue(privateItem());
	await waitFor(() => fake.sent.length === 1);
	bridge.onAgentStart();
	bridge.onMessageEnd({ role: "assistant", content: "答案" });
	bridge.onAgentSettled(false);
	await waitFor(() => api.sends.length === 1, { label: "重试成功", timeoutMs: 8000 });
	assert.equal(api.attempts.length, 2);
	assert.notEqual(api.attempts[0].msgSeq, api.attempts[1].msgSeq);

	const fake2 = createFakePi();
	const api2 = stubApi({ failFirst: 1, failStatus: 400 });
	const bridge2 = new QqBridge({ pi: fake2.pi, api: api2, config: normalizeConfig({ allowAll: true }), log: silentLog });
	bridge2.enqueue(privateItem());
	await waitFor(() => fake2.sent.length === 1);
	bridge2.onAgentStart();
	bridge2.onMessageEnd({ role: "assistant", content: "答案" });
	bridge2.onAgentSettled(false);
	await waitFor(() => api2.attempts.length === 1, { label: "永久错误" });
	await sleep(150);
	assert.equal(api2.attempts.length, 1);
	assert.equal(api2.sends.length, 0);
});

test("桥：取 token 期间重复 pump 不会丢消息或重复注入", async () => {
	const fake = createFakePi();
	const api = stubApi();
	const slowToken = api.auth.getToken;
	api.auth.getToken = async () => {
		await sleep(80);
		return slowToken();
	};
	const bridge = new QqBridge({ pi: fake.pi, api, config: normalizeConfig({ allowAll: true }), log: silentLog });

	bridge.enqueue(privateItem({ msgId: "m-1", text: "第一条" }));
	bridge.enqueue(privateItem({ msgId: "m-2", text: "第二条" }));
	await waitFor(() => fake.sent.length === 1, { label: "第一条注入" });
	assert.equal(bridge.queue.length, 1);
	assert.match(String(fake.sent[0].content), /第一条/);

	bridge.onAgentStart();
	bridge.onMessageEnd({ role: "assistant", content: "答一" });
	bridge.onAgentSettled(false);
	await waitFor(() => fake.sent.length === 2, { label: "第二条注入" });
	assert.match(String(fake.sent[1].content), /第二条/);
	bridge.onAgentStart();
	bridge.onMessageEnd({ role: "assistant", content: "答二" });
	bridge.onAgentSettled(false);
	await waitFor(() => api.sends.length === 2);
});

test("桥：网关离线时先等重连再发", async () => {
	const fake = createFakePi();
	const api = stubApi();
	let online = false;
	const bridge = new QqBridge({
		pi: fake.pi,
		api,
		config: normalizeConfig({ allowAll: true }),
		log: silentLog,
		isOnline: () => online,
	});
	bridge.enqueue(privateItem());
	await waitFor(() => fake.sent.length === 1);
	bridge.onAgentStart();
	bridge.onMessageEnd({ role: "assistant", content: "答案" });
	bridge.onAgentSettled(false);
	await sleep(150);
	assert.equal(api.sends.length, 0);
	online = true;
	await waitFor(() => api.sends.length === 1, { label: "恢复后发送", timeoutMs: 4000 });
});

test("桥：被动回复额度用完就停", async () => {
	const fake = createFakePi();
	const api = stubApi();
	const bridge = new QqBridge({
		pi: fake.pi,
		api,
		config: normalizeConfig({ allowAll: true, maxChunks: 4, replyQuota: 2, chunkChars: 200 }),
		log: silentLog,
	});
	bridge.enqueue(privateItem());
	await waitFor(() => fake.sent.length === 1);
	bridge.onAgentStart();
	bridge.onMessageEnd({ role: "assistant", content: Array.from({ length: 8 }, (_, i) => `段落${i}`.repeat(30)).join("\n\n") });
	bridge.onAgentSettled(false);
	await waitFor(() => api.sends.length === 2);
	await sleep(150);
	assert.equal(api.sends.length, 2);
});

test("桥：/qq new 不注入模型，切完回执", async () => {
	const fake = createFakePi();
	const api = stubApi();
	let requested = null;
	const bridge = new QqBridge({
		pi: fake.pi,
		api,
		config: normalizeConfig({ allowAll: true }),
		log: silentLog,
		onNewSession: (args) => {
			requested = args;
		},
	});
	bridge.enqueue(privateItem({ msgId: "cmd-1", text: "/qq new 新话题" }));
	await waitFor(() => requested !== null, { label: "/qq new 回调" });
	assert.equal(requested, "新话题");
	assert.equal(fake.sent.length, 0, "不应注入模型");

	await bridge.onSessionSwitched();
	assert.equal(api.sends.length, 1);
	assert.match(api.sends[0].content, /已开新会话/);
	assert.equal(api.sends[0].msgId, "cmd-1");
});

test("桥：换会话后旧队列作废", async () => {
	const fake = createFakePi();
	const api = stubApi();
	const bridge = new QqBridge({ pi: fake.pi, api, config: normalizeConfig({ allowAll: true }), log: silentLog });
	bridge.enqueue(privateItem({ msgId: "old-1", text: "旧问题" }));
	await waitFor(() => fake.sent.length === 1);
	bridge.onAgentStart();
	bridge.onMessageEnd({ role: "assistant", content: "旧答案" });
	bridge.reset();
	bridge.onAgentSettled(false);
	await sleep(120);
	assert.equal(api.sends.length, 0, "旧会话的输出不应再发到 QQ");
});

test("桥：/qq new 失败会给 QQ 回执", async () => {
	const fake = createFakePi();
	const api = stubApi();
	const bridge = new QqBridge({
		pi: fake.pi,
		api,
		config: normalizeConfig({ allowAll: true }),
		log: silentLog,
		onNewSession: () => {},
	});
	bridge.enqueue(privateItem({ msgId: "cmd-2", text: "/qq new" }));
	await waitFor(() => bridge.pendingNew !== undefined);
	bridge.notifyNewSessionFailed("模拟失败");
	await waitFor(() => api.sends.length === 1);
	assert.match(api.sends[0].content, /开新会话失败/);
	assert.equal(api.sends[0].msgId, "cmd-2");
});

test("桥：手动 resume 时丢弃待确认的 /qq new", async () => {
	const fake = createFakePi();
	const api = stubApi();
	const bridge = new QqBridge({
		pi: fake.pi,
		api,
		config: normalizeConfig({ allowAll: true }),
		log: silentLog,
		onNewSession: () => {},
	});
	bridge.enqueue(privateItem({ msgId: "cmd-3", text: "/qq new" }));
	await waitFor(() => bridge.pendingNew !== undefined);
	bridge.clearPendingNew();
	bridge.reset();
	await bridge.onSessionSwitched();
	assert.equal(api.sends.length, 0, "resume 不应发「已开新会话」");
});

test("桥：msg_id 去重", async () => {
	const fake = createFakePi();
	const bridge = new QqBridge({ pi: fake.pi, api: stubApi(), config: normalizeConfig({ allowAll: true }), log: silentLog });
	assert.equal(bridge.enqueue(privateItem()).accepted, true);
	const second = bridge.enqueue(privateItem());
	assert.equal(second.accepted, false);
	assert.equal(second.reason, "重复消息");
});

test("桥：回复预算截断", async () => {
	const fake = createFakePi();
	const api = stubApi();
	const bridge = new QqBridge({
		pi: fake.pi,
		api,
		config: normalizeConfig({ allowAll: true, maxChunks: 2, chunkChars: 120 }),
		log: silentLog,
	});
	bridge.enqueue(privateItem());
	await waitFor(() => fake.sent.length === 1);
	bridge.onAgentStart();
	bridge.onMessageEnd({
		role: "assistant",
		content: [{ type: "text", text: Array.from({ length: 6 }, (_, i) => `内容${i}`.repeat(30)).join("\n\n") }],
	});
	bridge.onAgentSettled(false);
	await waitFor(() => api.sends.length === 2);
	assert.equal(api.sends.length, 2);
	assert.equal(new Set(api.sends.map((s) => s.msgSeq)).size, 2);
	assert.match(api.sends[1].content, /内容过长/);
});

test("桥：被动窗口过期后改用同会话最新 msg_id", async () => {
	const fake = createFakePi();
	const api = stubApi();
	const cfg = normalizeConfig({ allowAll: true, passiveWindowSec: { group: 10, private: 3600 } });
	const bridge = new QqBridge({ pi: fake.pi, api, config: cfg, log: silentLog });

	const old = {
		kind: "group",
		chatId: "group-1",
		userId: "member-1",
		msgId: "old-msg",
		text: "旧问题",
		attachments: [],
		receivedAt: Date.now() - 60_000,
	};
	bridge.enqueue(old);
	await waitFor(() => fake.sent.length === 1);
	bridge.lastByChat.set("group:group-1", { msgId: "new-msg", at: Date.now() });

	bridge.onAgentStart();
	bridge.onMessageEnd({ role: "assistant", content: "答案" });
	bridge.onAgentSettled(false);
	await waitFor(() => api.sends.length === 1);
	assert.equal(api.sends[0].msgId, "new-msg");
	assert.equal(api.sends[0].target.openid, "group-1");
});

test("桥：Markdown 被拒时回退纯文本", async () => {
	const fake = createFakePi();
	const api = stubApi({ markdownFails: true });
	const bridge = new QqBridge({ pi: fake.pi, api, config: normalizeConfig({ allowAll: true, replyFormat: "markdown" }), log: silentLog });

	bridge.enqueue(privateItem());
	await waitFor(() => fake.sent.length === 1);
	bridge.onAgentStart();
	bridge.onMessageEnd({ role: "assistant", content: "**粗体**回复" });
	bridge.onAgentSettled(false);

	await waitFor(() => api.sends.length === 1);
	assert.equal(api.sends[0].format, "text");
	assert.equal(api.sends[0].content, "粗体回复");
	assert.ok(api.sends[0].msgSeq >= 1 && api.sends[0].msgSeq < 65536);
});

test("桥：终端里输入触发的轮次不回复给 QQ", async () => {
	const fake = createFakePi();
	const api = stubApi();
	const bridge = new QqBridge({ pi: fake.pi, api, config: normalizeConfig({ allowAll: true }), log: silentLog });
	bridge.enqueue(privateItem());
	await waitFor(() => fake.sent.length === 1);

	bridge.onBeforeAgentStart({ type: "before_agent_start", messageType: "user", prompt: "终端里的话" });
	bridge.onAgentStart();
	bridge.onMessageEnd({ role: "assistant", content: "终端答案" });
	bridge.onAgentSettled(false);
	await sleep(120);
	assert.equal(api.sends.length, 0);
});

test("桥：流式期间注入失败会重排队", async () => {
	const fake = createFakePi();
	fake.pi.streaming = true;
	const bridge = new QqBridge({ pi: fake.pi, api: stubApi(), config: normalizeConfig({ allowAll: true }), log: silentLog });
	bridge.enqueue(privateItem());
	await waitFor(() => bridge.queue.length === 1 && bridge.running === true, { label: "重排队" });
	fake.pi.streaming = false;
	bridge.onAgentSettled(false);
	await waitFor(() => fake.sent.length === 1, { label: "重试注入" });
});

// ---------------------------------------------------------------- 后台服务

test("服务：心跳已停的 pid 不自动 SIGTERM", async () => {
	const result = await stopService({
		pid: process.pid,
		startedAt: new Date(Date.now() - 120_000).toISOString(),
		heartbeatAt: new Date(Date.now() - 120_000).toISOString(),
	});
	assert.equal(result.stopped, false);
	assert.match(result.reason, /--force/);
	assert.equal(isProcessAlive(process.pid), true, "本进程不应被信号影响");
});

test("服务：状态文件、心跳与过期判断", () => {
	const file = serviceStatePath(path.dirname(tempConfigPath()));
	const now = new Date().toISOString();
	writeServiceState(file, { pid: process.pid, startedAt: now, heartbeatAt: now, sessionId: "s1" });
	const state = readServiceState(file);
	assert.equal(state.pid, process.pid);
	assert.equal(isServiceAlive(state), true);
	assert.match(describeService(state), /在线/);

	// 心跳过了 45 秒即视为掉线
	const stale = { ...state, heartbeatAt: new Date(Date.now() - 60_000).toISOString() };
	assert.equal(isServiceAlive(stale), false);
	assert.match(describeService(stale), /心跳停了/);

	// 死进程 pid 不算在线
	assert.equal(isServiceAlive({ ...state, pid: 999_999 }), false);
	removeServiceState(file);
	assert.equal(readServiceState(file), null);
});

// ---------------------------------------------------------------- 锁

test("锁：活进程占用时拒绝，force 可接管", () => {
	const file = path.join(path.dirname(tempConfigPath()), "test.lock");
	fs.writeFileSync(file, JSON.stringify({ pid: 1, at: new Date().toISOString() }));
	assert.equal(acquireLock(file).ok, false);
	const forced = acquireLock(file, { force: true });
	assert.equal(forced.ok, true);
	assert.equal(readLock(file).pid, process.pid);
	releaseLock(file);
	assert.equal(readLock(file), null);
});

// ---------------------------------------------------------------- 集成（mock QQ）

test("集成：扩展 → 网关 → 注入 → 回 QQ", async () => {
	const configPath = tempConfigPath();
	const mock = await startMockQq();
	process.env.QQBOT_CONFIG = configPath;
	writeConfig(configPath, {
		appId: "1234567890",
		clientSecret: "test-secret",
		sandbox: false,
		allowAll: true,
		envelope: true,
		endpoints: { token: `${mock.base}/app/getAppAccessToken`, api: mock.base, gateway: mock.wsUrl },
		log: { file: path.join(path.dirname(configPath), "test.log"), level: "debug" },
	});

	const { default: createExtension, resetRuntimeForTests } = await import("../src/index.js");
	resetRuntimeForTests();
	const fake = createFakePi();
	const ctx = createFakeCtx();
	const extension = createExtension(fake.pi);

	try {
	await fake.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
	await waitFor(() => mock.state.identifies.length === 1, { label: "identify" });
	assert.equal(mock.state.identifies[0].token.startsWith("QQBot "), true);
	assert.equal(mock.state.identifies[0].intents, 1 << 25);

	mock.dispatch("GROUP_AT_MESSAGE_CREATE", groupAtEvent({ msgId: "real-msg-1", groupOpenId: "group-1", memberOpenId: "member-1", content: " 请只回复：pong" }));
	await waitFor(() => fake.sent.length === 1, { label: "注入 Pi" });
	assert.match(String(fake.sent[0].content), /请只回复：pong/);

	await fake.emit("agent_start", { type: "agent_start" }, ctx);
	await fake.emit("message_end", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "pong" }] } }, ctx);
	await fake.emit("agent_settled", { type: "agent_settled", aborted: false }, ctx);
	await waitFor(() => mock.state.sends.length === 1, { label: "QQ 收到回复" });

	const sent = mock.state.sends[0];
	assert.equal(sent.type, "group");
	assert.equal(sent.openid, "group-1");
	assert.equal(sent.body.content, "pong");
	assert.equal(sent.body.msg_id, "real-msg-1");
	assert.ok(sent.body.msg_seq >= 1 && sent.body.msg_seq < 65536);
	assert.equal(sent.body.msg_type, 0);
	assert.equal(sent.authorization, "QQBot mock-access-token");

	// /new /resume 换 Pi 会话时不重建 QQ 网关
	const identifyCount = mock.state.identifies.length;
	await fake.emit("session_shutdown", { type: "session_shutdown", reason: "new" }, ctx);
	await fake.emit("session_start", { type: "session_start", reason: "new" }, ctx);
	await sleep(150);
	assert.equal(mock.state.identifies.length, identifyCount, "换会话不应重新 identify");

	// /qq status 能跑通
	assert.equal(fake.commands.has("qq"), true);
	await fake.commands.get("qq").handler("status", ctx);
	assert.ok(ctx.notifications.some((n) => /后台服务/.test(n.message)));
	await fake.commands.get("qq").handler("bogus", ctx);
	assert.ok(ctx.notifications.at(-1).message.includes("take"), "帮助里应包含 take");
	await fake.commands.get("qq").handler("status", ctx);
	assert.ok(ctx.notifications.some((n) => /网关/.test(n.message)));

	// QQ 侧 /qq new：派发给扩展命令，切完回执，网关不断
	const identifyBeforeCmd = mock.state.identifies.length;
	mock.dispatch("C2C_MESSAGE_CREATE", c2cEvent({ msgId: "cmd-1", userOpenId: "user-1", content: "/qq new" }));
	await waitFor(() => fake.sent.some((s) => String(s.content).startsWith("/qq new")), { label: "/qq new 派发" });
	const dispatched = fake.sent.find((s) => String(s.content).startsWith("/qq new"));
	assert.equal(dispatched.options?.expandPromptTemplates, true);

	await fake.emit("session_shutdown", { type: "session_shutdown", reason: "new" }, ctx);
	await fake.emit("session_start", { type: "session_start", reason: "new" }, ctx);
	await waitFor(() => mock.state.sends.some((s) => /已开新会话/.test(String(s.body.content ?? ""))), { label: "新会话回执" });
	assert.equal(mock.state.identifies.length, identifyBeforeCmd, "/qq new 不应重连网关");

	assert.equal(extension.error, null);
} finally {
	await fake.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
	await mock.stop();
}
});

test("集成：后台服务在线时本地不抢网关", async () => {
	const configPath = tempConfigPath();
	const mock = await startMockQq();
	process.env.QQBOT_CONFIG = configPath;
	delete process.env.QQBOT_SERVICE_PID;
	writeConfig(configPath, {
		appId: "1234567890",
		clientSecret: "test-secret",
		sandbox: false,
		allowAll: true,
		endpoints: { token: `${mock.base}/app/getAppAccessToken`, api: mock.base, gateway: mock.wsUrl },
		log: { file: path.join(path.dirname(configPath), "test-service.log"), level: "debug" },
	});
	const serviceFile = serviceStatePath(path.dirname(configPath));
	writeServiceState(serviceFile, {
		pid: process.pid,
		startedAt: new Date().toISOString(),
		heartbeatAt: new Date().toISOString(),
		sessionId: "pi-qqbot-service",
	});

	const { default: createExtension, resetRuntimeForTests } = await import("../src/index.js");
	resetRuntimeForTests();
	const fake = createFakePi();
	const ctx = createFakeCtx();
	createExtension(fake.pi);
	await fake.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
	await sleep(200);
	assert.equal(mock.state.identifies.length, 0, "不应连接网关");
	assert.ok(ctx.notifications.some((n) => /后台服务在线/.test(n.message)));

	removeServiceState(serviceFile);
	await fake.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
	await mock.stop();
});

test("集成：缺配置时不连接并给出提示", async () => {
	const configPath = tempConfigPath();
	fs.rmSync(configPath, { force: true });
	process.env.QQBOT_CONFIG = configPath;
	const { default: createExtension } = await import("../src/index.js");
	const fake = createFakePi();
	const ctx = createFakeCtx();
	createExtension(fake.pi);
	await fake.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
	assert.ok(ctx.notifications.some((n) => /配置文件不存在/.test(n.message)));
});
