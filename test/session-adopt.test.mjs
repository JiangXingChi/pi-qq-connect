/**
 * 会话实例接棒回归测试（不连 QQ 网关、不碰真实会话）。
 *
 * pi 1.4 的会话替换时序：
 *   I1 收到 session_shutdown(new) → I1 的 pi 句柄作废
 *   → 扩展工厂重跑得到 I2 → I2 收到 session_start(new) → I1 的 withSession 才执行
 *
 * 这里验证插件按实例注册事件/命令，并且新旧实例能通过进程级单例把桥交接过去。
 */

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { DEFAULT_CONFIG } from "../src/config.js";
import { QqBridge } from "../src/session.js";
import { createFakePi, sleep, tempConfigPath, waitFor, writeConfig } from "./harness.mjs";

const cfgFile = tempConfigPath();
writeConfig(cfgFile, {
	enabled: false,
	appId: "1234567890",
	clientSecret: "test-secret",
	allowAll: true,
	log: { file: path.join(path.dirname(cfgFile), "test.log"), level: "info" },
});
process.env.PIQQCONNECT_CONFIG = cfgFile;

const mod = await import("../src/index.js");
const { resetRuntimeForTests } = mod;

function fakeCtx() {
	return {
		cwd: path.dirname(cfgFile),
		ui: { notify() {}, setStatus() {} },
	};
}

/** 只实现 index.js 会用到的几件事，方便断言交接顺序。 */
function trackingBridge(pi) {
	const calls = [];
	return {
		calls,
		pi,
		switching: false,
		stale: false,
		adopt(next) {
			calls.push("adopt");
			this.pi = next;
		},
		beginSwitch() {
			calls.push("beginSwitch");
			this.switching = true;
		},
		endSwitch() {
			calls.push("endSwitch");
			this.switching = false;
		},
		pump() {
			calls.push("pump");
		},
		stop() {
			calls.push("stop");
		},
	};
}

const silentLog = { debug() {}, info() {}, warn() {}, error() {}, tail: () => [] };

/** 真 QqBridge + 假 api/pi，用来验证切换收尾时的队列语义。 */
function makeBridge({ onCommand } = {}) {
	const injected = [];
	const sends = [];
	const config = {
		...DEFAULT_CONFIG,
		allowAll: true,
		typing: false,
		ackAfterMs: 0,
		images: { ...DEFAULT_CONFIG.images, enabled: false },
	};
	const bridge = new QqBridge({
		pi: {
			sendUserMessage(content) {
				injected.push(content);
			},
		},
		api: {
			auth: { getToken: async () => "t" },
			sendText: async (target, content) => {
				sends.push({ target, content: String(content) });
			},
		},
		config,
		log: silentLog,
		notify: () => {},
		isOnline: () => true,
		onCommand,
		injectTimeoutMs: 0,
	});
	return { bridge, injected, sends };
}

function item(id, text = "hello") {
	return { kind: "private", chatId: "chat-1", userId: "user-1", msgId: id, text, receivedAt: Date.now(), attachments: [] };
}

test("T1 同一个 pi 对象重复加载只注册一次", async (t) => {
	resetRuntimeForTests();
	const fake = createFakePi();
	mod.default(fake.pi);
	const registrations = fake.commandRegistrations.length;
	const starts = fake.handlerCount("session_start");
	const shutdowns = fake.handlerCount("session_shutdown");

	mod.default(fake.pi); // 自动发现 + 显式 --extension 命中同一路径

	await t.test("命令没有被重复注册", () => assert.equal(fake.commandRegistrations.length, registrations));
	await t.test("事件监听没有被重复注册", () => {
		assert.equal(fake.handlerCount("session_start"), starts);
		assert.equal(fake.handlerCount("session_shutdown"), shutdowns);
	});
});

test("T2 新会话实例重新注册命令与事件", async (t) => {
	resetRuntimeForTests();
	const first = createFakePi();
	mod.default(first.pi);
	await first.emit("session_start", { reason: "startup" }, fakeCtx());

	const second = createFakePi();
	const state = mod.default(second.pi);
	await second.emit("session_start", { reason: "new" }, fakeCtx());

	await t.test("新实例注册了 /qq 命令", () => assert.ok(second.commands.has("qq")));
	await t.test("新实例注册了事件监听", () => {
		assert.ok(second.handlerCount("session_start") > 0);
		assert.ok(second.handlerCount("session_shutdown") > 0);
		assert.ok(second.handlerCount("message_end") > 0);
	});
	await t.test("state.extensionApi 指向最新句柄", () => assert.equal(state.extensionApi, second.pi));
	await t.test("state.ctx 指向新会话上下文", () => assert.equal(state.ctx.cwd, path.dirname(cfgFile)));
});

test("T2b 同一会话里两个 pi 对象只让一个实例处理事件", async (t) => {
	resetRuntimeForTests();
	const first = createFakePi();
	const state = mod.default(first.pi);
	const second = createFakePi();
	mod.default(second.pi); // 另一个对象，同一个会话

	const shared = fakeCtx();
	await first.emit("session_start", { reason: "startup" }, shared);
	await second.emit("session_start", { reason: "startup" }, shared);

	await t.test("事件只绑定到被选中的那个实例", () => {
		assert.ok(state.owner === first.pi || state.owner === second.pi);
	});
	const ownerFake = state.owner === first.pi ? first : second;
	const otherFake = ownerFake === first ? second : first;
	const events = [];
	state.bridge = { onMessageEnd: () => events.push("hit"), pi: null, adopt() {}, pump() {}, stop() {} };
	await otherFake.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "x" }] } }, shared);
	await t.test("非负责人实例的回调被忽略", () => assert.equal(events.length, 0));
	await ownerFake.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "x" }] } }, shared);
	await t.test("负责人实例的回调生效", () => assert.equal(events.length, 1));
	state.bridge = undefined;
});

test("T3 换会话时暂停注入，新实例接棒后收尾", async (t) => {
	resetRuntimeForTests();
	const first = createFakePi();
	const state = mod.default(first.pi);
	await first.emit("session_start", { reason: "startup" }, fakeCtx());

	const bridge = trackingBridge(first.pi);
	state.bridge = bridge;

	await first.emit("session_shutdown", { reason: "new" });
	await t.test("旧实例退出时只暂停，不拆网关", () => {
		assert.deepEqual(bridge.calls, ["beginSwitch"]);
		assert.equal(bridge.switching, true);
	});

	const second = createFakePi();
	mod.default(second.pi);
	await t.test("工厂一跑就把桥指向新句柄", () => assert.equal(bridge.pi, second.pi));

	await second.emit("session_start", { reason: "new" }, fakeCtx());
	await t.test("新实例接棒并结束切换", () => {
		assert.equal(bridge.calls.at(-1), "endSwitch");
		assert.equal(bridge.switching, false);
	});

	state.bridge = undefined;
});

test("T4 /reload 也走同一条接棒路径", async (t) => {
	resetRuntimeForTests();
	const first = createFakePi();
	const state = mod.default(first.pi);
	await first.emit("session_start", { reason: "startup" }, fakeCtx());

	const bridge = trackingBridge(first.pi);
	state.bridge = bridge;

	await first.emit("session_shutdown", { reason: "reload" });
	await t.test("reload 时暂停注入", () => assert.equal(bridge.switching, true));

	const second = createFakePi();
	mod.default(second.pi);
	await second.emit("session_start", { reason: "reload" }, fakeCtx());
	await t.test("reload 后接棒结束切换", () => {
		assert.equal(bridge.calls.at(-1), "endSwitch");
		assert.equal(bridge.switching, false);
	});
	state.bridge = undefined;
});

test("T5 /fork 走同一条接棒路径", async (t) => {
	resetRuntimeForTests();
	const first = createFakePi();
	const state = mod.default(first.pi);
	await first.emit("session_start", { reason: "startup" }, fakeCtx());
	const bridge = trackingBridge(first.pi);
	state.bridge = bridge;

	await first.emit("session_shutdown", { reason: "fork" });
	assert.equal(bridge.switching, true);
	const second = createFakePi();
	mod.default(second.pi);
	await second.emit("session_start", { reason: "fork" }, fakeCtx());
	await t.test("fork 后接棒结束切换", () => {
		assert.equal(bridge.calls.at(-1), "endSwitch");
		assert.equal(bridge.switching, false);
	});
	state.bridge = undefined;
});

test("T6 未知 shutdown reason 不拆网关，按换会话处理", async (t) => {
	resetRuntimeForTests();
	const fake = createFakePi();
	const state = mod.default(fake.pi);
	await fake.emit("session_start", { reason: "startup" }, fakeCtx());
	const bridge = trackingBridge(fake.pi);
	state.bridge = bridge;

	await fake.emit("session_shutdown", { reason: "switch" });
	await t.test("未知 reason 只暂停", () => {
		assert.deepEqual(bridge.calls, ["beginSwitch"]);
		assert.equal(bridge.calls.includes("stop"), false);
	});
	state.bridge = undefined;
});

test("T7 退出（quit）时照常收摊", async (t) => {
	resetRuntimeForTests();
	const fake = createFakePi();
	const state = mod.default(fake.pi);
	await fake.emit("session_start", { reason: "startup" }, fakeCtx());
	const bridge = trackingBridge(fake.pi);
	state.bridge = bridge;

	await fake.emit("session_shutdown", { reason: "quit" });
	await t.test("quit 时停桥并释放状态", () => {
		assert.ok(bridge.calls.includes("stop"));
		assert.equal(state.bridge, undefined);
		assert.equal(state.gateway, undefined);
	});
});

test("T8 beginSwitch 可重复调用，暂存的消息不丢", async () => {
	const { bridge, injected } = makeBridge();
	bridge.beginSwitch();
	bridge.enqueue(item("m1"));
	bridge.enqueue(item("m2"));
	bridge.beginSwitch(); // session_shutdown 又来一次
	assert.equal(bridge.deferred.length, 2, "重复 beginSwitch 不能清空暂存");
	bridge.endSwitch();
	await waitFor(() => injected.length === 1, { label: "接棒后先注入第一条" });
	assert.equal(bridge.queue.length, 1, "第二条仍在队列里");
	assert.equal(bridge.stopped, false);
	bridge.stop();
});

test("T9 endSwitch 保留排队消息，丢掉旧会话的在途回答", async (t) => {
	const { bridge, injected } = makeBridge();
	bridge.enqueue(item("m1")); // 立刻注入，成为 inflight
	await waitFor(() => bridge.inflight?.item.msgId === "m1", { label: "第一条进入在途" });
	bridge.enqueue(item("m2")); // 排队
	assert.equal(bridge.queue.length, 1);

	bridge.beginSwitch();
	bridge.enqueue(item("m3")); // 暂存
	assert.equal(bridge.deferred.length, 1);

	bridge.endSwitch();
	await waitFor(() => injected.length >= 2, { label: "接棒后继续注入排队消息" });
	await t.test("旧会话的在途消息不会被重放（回答已丢弃）", () => assert.equal(injected.length, 2));
	await t.test("排队与暂存的消息都还在，顺序不变", () => {
		assert.equal(bridge.inflight?.item.msgId, "m2");
		assert.deepEqual(
			bridge.queue.map((i) => i.msgId),
			["m3"],
		);
	});
	bridge.stop();
});

test("T10 切换期间到达的斜杠命令不会被当提问喂模型", async () => {
	const handled = [];
	const { bridge, injected } = makeBridge({ onCommand: (command) => (handled.push(command), { text: "ok" }) });
	bridge.beginSwitch();
	bridge.enqueue(item("c1", "/help"));
	assert.equal(bridge.deferred.length, 1);
	bridge.endSwitch();
	await waitFor(() => handled.length === 1, { label: "切换后补跑命令" });
	assert.deepEqual(
		handled.map((c) => c.name),
		["help"],
		"切换后应重新走命令通道",
	);
	assert.equal(injected.length, 0, "命令不能进模型");
	assert.equal(bridge.queue.length, 0);
	bridge.stop();
});

test("T11 切换期间 pump 不注入", async () => {
	const { bridge, injected } = makeBridge();
	bridge.beginSwitch();
	bridge.queue.push(item("m1"));
	await bridge.pump();
	assert.equal(injected.length, 0, "切换中不允许注入");
	bridge.cancelSwitch();
	bridge.stop();
});

test("T12 开新会话失败（cancelSwitch）时命令照样补跑，不进模型", async () => {
	const handled = [];
	const { bridge, injected } = makeBridge({ onCommand: (command) => (handled.push(command), { text: "ok" }) });
	bridge.beginSwitch();
	bridge.enqueue(item("c1", "/help"));
	bridge.cancelSwitch();
	await waitFor(() => handled.length === 1, { label: "取消切换后补跑命令" });
	assert.equal(injected.length, 0, "命令不能进模型");
	assert.equal(bridge.switching, false);
	bridge.stop();
});

test("T13 切换期间暂存受队列上限约束，超限丢弃并计数", async () => {
	const { bridge } = makeBridge();
	bridge.beginSwitch();
	for (let i = 0; i < bridge.cfg.maxQueue; i++) bridge.enqueue(item(`q${i}`));
	const overflow = bridge.enqueue(item("overflow"));
	assert.equal(overflow.accepted, false);
	assert.equal(overflow.reason, "暂存已满");
	assert.equal(bridge.deferred.length, bridge.cfg.maxQueue);
	bridge.endSwitch();
	bridge.stop();
});

test("T14 同一会话重复加载时命令只注册一次", async (t) => {
	resetRuntimeForTests();
	const first = createFakePi();
	mod.default(first.pi);
	const second = createFakePi();
	mod.default(second.pi);
	const shared = fakeCtx();
	await first.emit("session_start", { reason: "startup" }, shared);
	await second.emit("session_start", { reason: "startup" }, shared);
	const count = () =>
		first.commandRegistrations.filter((n) => n === "qq").length + second.commandRegistrations.filter((n) => n === "qq").length;
	await t.test("同一会话只注册一次 /qq", () => assert.equal(count(), 1, "同名命令重复注册会让命令彻底失效"));
	await t.test("重复的 session_start 不会重复注册", async () => {
		await first.emit("session_start", { reason: "startup" }, shared);
		assert.equal(count(), 1);
	});
});
