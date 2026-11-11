/**
 * QQ 侧命令的单测：不起真 pi，用假的 newSession 验证解析与回执。
 *
 * QQ 聊天里只有 /new 由本模块处理：/model、/thinking、/compact、/session、
 * /name、/tools、/help 不再映射，runner.run() 返回 null 交给上层（index.js 回一条
 * 「只能在终端用」，或按技能/普通文本转发）。
 * 运行：node --test test/
 */

import assert from "node:assert/strict";
import test from "node:test";

import { HELP_TEXT, QQ_SIDE, TUI_ONLY, createCommandRunner, parseCommand } from "../src/commands.js";

function makeRunner(newSession = async () => ({ ok: true })) {
	const calls = [];
	const runner = createCommandRunner({
		getPi: () => ({}),
		getCtx: () => ({}),
		newSession: async (args) => {
			calls.push(args);
			return newSession(args);
		},
	});
	return { runner, calls };
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

test("命令清单：QQ 侧只剩 /new，且与 TUI 专用不重叠", () => {
	assert.deepEqual([...QQ_SIDE], ["new"]);
	for (const name of QQ_SIDE) assert.equal(TUI_ONLY.has(name), false, `${name} 不该同时在两边`);
	assert.equal(TUI_ONLY.has("resume"), true);
});

test("/new 走命令通道并回执", async () => {
	const { runner, calls } = makeRunner();
	assert.equal(await runner.run(parseCommand("/new")), "✅ new session started");
	assert.deepEqual(calls, [""]);
	assert.equal(await runner.run(parseCommand("/new 潮汐")), "✅ new session started (潮汐)");
	assert.deepEqual(calls, ["", "潮汐"]);
});

test("/new 被取消或失败时如实回执", async () => {
	const cancelled = makeRunner(async () => ({ ok: false, cancelled: true }));
	assert.equal(await cancelled.runner.run(parseCommand("/new")), "new session cancelled");

	const failing = makeRunner(async () => ({ ok: false, message: "pi is busy" }));
	assert.match(await failing.runner.run(parseCommand("/new")), /could not open a new session: pi is busy/);
});

test("其它桌面命令不再由 runner 处理，返回 null 交给上层", async () => {
	const { runner, calls } = makeRunner();
	for (const line of [
		"/model",
		"/model 2",
		"/thinking",
		"/thinking high",
		"/compact",
		"/compact 只留最近三条",
		"/session",
		"/name",
		"/name 潮汐投资",
		"/tools",
		"/help",
	]) {
		assert.equal(await runner.run(parseCommand(line)), null, `${line} 应交给上层`);
	}
	assert.deepEqual(calls, [], "这些命令都不该开新会话");
});

test("技能、扩展命令与未知命令一律返回 null", async () => {
	const { runner } = makeRunner();
	for (const name of ["resume", "fork", "skill:a-stock-data", "cron", "qq", "tmp"]) {
		assert.equal(await runner.run(parseCommand(`/${name}`)), null, `${name} 应由上层处理`);
	}
});

test("HELP_TEXT 只承诺 /new", () => {
	assert.match(HELP_TEXT, /\/new \[name\]/);
	assert.match(HELP_TEXT, /runs in the terminal/);
	assert.doesNotMatch(HELP_TEXT, /\/model|\/thinking|\/compact|\/session|\/name|\/tools|\/help/);
});
