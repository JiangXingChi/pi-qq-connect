/**
 * 启动参数与配置的单测：
 *  - 默认必须「和终端一致」：不加 --no-extensions，交给 pi 自己发现
 *  - extensions:"none" / 数组 时退回显式挂载
 *  - 配置里写错的值不能把插件全关掉
 * 运行：node --test test/
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { DEFAULT_CONFIG, normalizeConfig } from "../src/config.js";

const run = promisify(execFile);
const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "pi-qq-connect.mjs");

function tempConfig(content) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piqq-cfg-"));
	const file = path.join(dir, "config.json");
	fs.writeFileSync(file, JSON.stringify({ enabled: false, ...content }));
	return file;
}

async function hasPiBinary() {
	try {
		await run("pi", ["--version"], { timeout: 30_000 });
		return true;
	} catch {
		return false;
	}
}

async function planFor(configFile) {
	const env = { ...process.env, PIQQCONNECT_CONFIG: configFile };
	delete env.PIQQCONNECT_DISABLED;
	const { stdout } = await run(process.execPath, [bin, "--dry-run", "--cwd", "/tmp"], { env, timeout: 60_000 });
	return JSON.parse(stdout);
}

test("默认 extensions=auto：不加 --no-extensions，交给 pi 自己发现", async () => {
	const plan = await planFor(tempConfig({}));
	assert.equal(plan.extensions, "auto");
	assert.equal(plan.args.includes("--no-extensions"), false);
	assert.equal(plan.args[0], "--mode");
	assert.equal(plan.args[1], "rpc");
	assert.ok(plan.args.includes("--extension"));
	// 自身用稳定绝对路径显式挂一次
	const rootIndex = plan.args.indexOf("--extension");
	assert.ok(path.isAbsolute(plan.args[rootIndex + 1]));
});

test("旧值 all 归一成 auto，行为与默认一致", async () => {
	const plan = await planFor(tempConfig({ extensions: "all" }));
	assert.equal(plan.extensions, "auto");
	assert.equal(plan.args.includes("--no-extensions"), false);
});

test("extensions=none：隔离模式，--no-extensions + 只挂自身", async () => {
	const plan = await planFor(tempConfig({ extensions: "none" }));
	assert.equal(plan.extensions, "none");
	assert.equal(plan.args.includes("--no-extensions"), true);
	const extensions = plan.args.filter((arg, index) => plan.args[index - 1] === "--extension");
	assert.equal(extensions.length, 1);
});

test("数组：显式挂载，builtin: 原样透传，自身不重复", async () => {
	const plan = await planFor(
		tempConfig({ extensions: ["builtin:tool-search", "pi-qq-connect", "npm:pi-hermes-memory"] }),
	);
	assert.equal(plan.args.includes("--no-extensions"), true);
	const extensions = plan.args.filter((arg, index) => plan.args[index - 1] === "--extension");
	assert.equal(extensions[0], plan.args[plan.args.indexOf("--extension") + 1], "自身在最前");
	assert.ok(extensions.includes("builtin:tool-search"));
	// 自身被跳过：pi-qq-connect 只出现一次路径（显式那个）
	const selfCount = extensions.filter((value) => value.includes("pi-qq-connect")).length;
	assert.equal(selfCount, 1);
	// CI 里没装 pi 时 `pi list` 读不到，只能验证内置扩展透传与「不重复挂自身」
	const hasPi = await hasPiBinary();
	if (hasPi) assert.ok(extensions.some((value) => value.endsWith("pi-hermes-memory")));
});

test("配置归一：非法 extensions 退回 auto，overflow 只认 file/truncate", () => {
	assert.equal(DEFAULT_CONFIG.extensions, "auto");
	assert.equal(DEFAULT_CONFIG.overflow, "file");
	assert.equal(normalizeConfig({ extensions: 42 }).extensions, "auto");
	assert.equal(normalizeConfig({ extensions: "wat" }).extensions, "auto");
	assert.equal(normalizeConfig({ extensions: [] }).extensions.length, 0);
	assert.equal(normalizeConfig({ overflow: "truncate" }).overflow, "truncate");
	assert.equal(normalizeConfig({ overflow: "???" }).overflow, "file");
	// 相对路径的 replyDir 保持可展开，默认落在 agent 目录下
	assert.match(normalizeConfig({}).replyDir, /qq-replies$/);
});
