/**
 * QQ 侧桌面命令的单测：不起真 pi，用假的 pi/ctx 验证解析与回执。
 * 运行：node --test test/
 */

import assert from "node:assert/strict";
import test from "node:test";

import { HELP_TEXT, QQ_SIDE, THINKING_LEVELS, TUI_ONLY, createCommandRunner, parseCommand } from "../src/commands.js";

function fakePi(overrides = {}) {
	const state = {
		model: { provider: "acme", id: "fast-1", name: "Fast" },
		thinking: "high",
		sessionName: undefined,
		models: [
			{ provider: "acme", id: "fast-1", name: "Fast" },
			{ provider: "acme", id: "slow-2" },
		],
		setModelCalls: [],
		setThinkingCalls: [],
		sessionNameCalls: [],
		...overrides,
	};
	return {
		state,
		api: {
			get model() {
				return state.model;
			},
			setModel: async (model) => {
				state.setModelCalls.push(model);
				state.model = model;
				return model.id !== "locked-3";
			},
			getThinkingLevel: () => state.thinking,
			setThinkingLevel: (level) => {
				state.setThinkingCalls.push(level);
				state.thinking = level;
			},
			getSessionName: () => state.sessionName,
			setSessionName: (name) => {
				state.sessionNameCalls.push(name);
				state.sessionName = name;
			},
			getActiveTools: () => ["bash", "read"],
		},
	};
}

function fakeCtx({ model, models } = {}) {
	const list = models ?? [
		{ provider: "acme", id: "fast-1", name: "Fast" },
		{ provider: "acme", id: "slow-2" },
		{ provider: "acme", id: "locked-3" },
	];
	return {
		model,
		cwd: "/home/user/project",
		modelRegistry: {
			getAvailable: () => list,
		},
		getContextUsage: () => ({ tokens: 1234, contextWindow: 200000, percent: 0.617 }),
		sessionManager: {
			getSessionId: () => "sess-1",
			getSessionFile: () => "/tmp/sess-1.jsonl",
			getSessionName: () => "demo",
		},
		compact: (options) => {
			fakeCtx.lastCompact = options ?? {};
		},
	};
}

function makeRunner(pi, ctx) {
	const newSessionCalls = [];
	const runner = createCommandRunner({
		getPi: () => pi,
		getCtx: () => ctx,
		newSession: async (args) => {
			newSessionCalls.push(args);
			return { ok: true };
		},
	});
	return { runner, newSessionCalls };
}

test("parseCommand 只认斜杠开头的命令", () => {
	assert.equal(parseCommand("你好"), null);
	assert.equal(parseCommand(""), null);
	assert.deepEqual(parseCommand("/model"), { name: "model", args: "", raw: "/model" });
	assert.deepEqual(parseCommand("/Model  3 "), { name: "model", args: "3", raw: "/Model  3" });
	assert.deepEqual(parseCommand("/new 潮汐 投资"), { name: "new", args: "潮汐 投资", raw: "/new 潮汐 投资" });
	assert.deepEqual(parseCommand("/skill:a-stock-data 查询"), {
		name: "skill:a-stock-data",
		args: "查询",
		raw: "/skill:a-stock-data 查询",
	});
});

test("命令清单：QQ 侧与 TUI 专用不重叠", () => {
	for (const name of QQ_SIDE) assert.equal(TUI_ONLY.has(name), false, `${name} 不该同时在两边`);
	assert.equal(QQ_SIDE.has("new"), true);
	assert.equal(TUI_ONLY.has("resume"), true);
});

test("/new 走命令通道并回执", async () => {
	const { api } = fakePi();
	const { runner, newSessionCalls } = makeRunner(api, fakeCtx());
	assert.equal(await runner.run(parseCommand("/new")), "✅ 已开新会话");
	assert.deepEqual(newSessionCalls, [""]);
	assert.equal(await runner.run(parseCommand("/new 潮汐")), "✅ 已开新会话（潮汐）");
});

test("/new 被取消或失败时如实回执", async () => {
	const { api } = fakePi();
	const runner = createCommandRunner({
		getPi: () => api,
		getCtx: () => fakeCtx(),
		newSession: async () => ({ ok: false, cancelled: true }),
	});
	assert.equal(await runner.run(parseCommand("/new")), "开新会话被取消");
	const failing = createCommandRunner({
		getPi: () => api,
		getCtx: () => fakeCtx(),
		newSession: async () => ({ ok: false, message: "Pi 忙" }),
	});
	assert.match(await failing.run(parseCommand("/new")), /开新会话失败：Pi 忙/);
});

test("/model 无参数列清单，标出当前模型", async () => {
	const { api } = fakePi();
	const { runner } = makeRunner(api, fakeCtx({ model: { provider: "acme", id: "fast-1" } }));
	const text = await runner.run(parseCommand("/model"));
	assert.match(text, /可选模型（共 3 个/);
	assert.match(text, /1\. acme\/fast-1（Fast） ← 当前/);
	assert.match(text, /2\. acme\/slow-2/);
});

test("/model 3 用上一次清单，序号越界有提示", async () => {
	const { api, state } = fakePi();
	const { runner } = makeRunner(api, fakeCtx());
	await runner.run(parseCommand("/model"));
	assert.match(await runner.run(parseCommand("/model 9")), /序号超出范围/);
	assert.match(await runner.run(parseCommand("/model 2")), /已切换到 acme\/slow-2/);
	assert.equal(state.setModelCalls.at(-1).id, "slow-2");
});

test("/model provider/id 直接指定，找不到有提示", async () => {
	const { api } = fakePi();
	const { runner } = makeRunner(api, fakeCtx());
	assert.match(await runner.run(parseCommand("/model acme/fast-1")), /已切换到 acme\/fast-1/);
	assert.match(await runner.run(parseCommand("/model acme/nope")), /没找到模型/);
	assert.match(await runner.run(parseCommand("/model acme/locked-3")), /没有配置认证/);
});

test("/thinking 查看、切换、非法值", async () => {
	const { api, state } = fakePi();
	const { runner } = makeRunner(api, fakeCtx());
	assert.match(await runner.run(parseCommand("/thinking")), /思考级别：high/);
	assert.match(await runner.run(parseCommand("/thinking max")), /已设为 max/);
	assert.equal(state.thinking, "max");
	assert.match(await runner.run(parseCommand("/thinking 超高")), /不认识的级别/);
	for (const level of THINKING_LEVELS) {
		assert.match(await runner.run(parseCommand(`/thinking ${level}`)), /思考级别已设为|当前生效的是/);
	}
});

test("/compact 透传说明", async () => {
	const { api } = fakePi();
	const ctx = fakeCtx();
	const { runner } = makeRunner(api, ctx);
	assert.match(await runner.run(parseCommand("/compact")), /已开始压缩上下文/);
	assert.match(await runner.run(parseCommand("/compact 只留最近三条")), /附加说明：只留最近三条/);
	assert.deepEqual(fakeCtx.lastCompact, { customInstructions: "只留最近三条" });
});

test("/session 报模型、思考级别、上下文、会话名", async () => {
	const { api } = fakePi();
	const { runner } = makeRunner(api, fakeCtx({ model: { provider: "acme", id: "fast-1" } }));
	const text = await runner.run(parseCommand("/session"));
	assert.match(text, /模型：acme\/fast-1/);
	assert.match(text, /思考级别：high/);
	assert.match(text, /上下文：1,234 \/ 200,000（1%）/);
	assert.match(text, /会话：sess-1 · demo/);
	assert.match(text, /工具：2 个/);
});

test("/name 读写会话名", async () => {
	const { api, state } = fakePi();
	const { runner } = makeRunner(api, fakeCtx());
	assert.match(await runner.run(parseCommand("/name")), /还没有名字/);
	assert.match(await runner.run(parseCommand("/name 潮汐投资")), /会话名已设为 潮汐投资/);
	assert.equal(state.sessionName, "潮汐投资");
	assert.match(await runner.run(parseCommand("/name")), /会话名：潮汐投资/);
});

test("/tools 与 /help", async () => {
	const { api } = fakePi();
	const { runner } = makeRunner(api, fakeCtx());
	const tools = await runner.run(parseCommand("/tools"));
	assert.match(tools, /当前启用 2 个工具/);
	assert.match(tools, /bash/);
	const help = await runner.run(parseCommand("/help"));
	assert.match(help, /\/new \[名称\]/);
	assert.equal(help, HELP_TEXT);
});

test("不是 QQ 侧命令时返回 null，交给上层转发或拒绝", async () => {
	const { api } = fakePi();
	const { runner } = makeRunner(api, fakeCtx());
	for (const name of ["resume", "fork", "skill:a-stock-data", "cron", "qq"]) {
		assert.equal(await runner.run(parseCommand(`/${name}`)), null, `${name} 应由上层处理`);
	}
});

test("换会话后 getPi/getCtx 取到新句柄", async () => {
	let pi = fakePi().api;
	let ctx = fakeCtx();
	const runner = createCommandRunner({ getPi: () => pi, getCtx: () => ctx, newSession: async () => ({ ok: true }) });
	assert.match(await runner.run(parseCommand("/model")), /fast-1/);
	// 模拟换会话：句柄整体换新
	const swapped = { provider: "other", id: "new-1" };
	pi = fakePi({ model: swapped, models: [swapped] }).api;
	ctx = fakeCtx({ model: swapped, models: [swapped] });
	assert.match(await runner.run(parseCommand("/model")), /other\/new-1/);
});
