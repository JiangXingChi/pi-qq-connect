/**
 * 双实例加载回归（真 pi，不连网关）。
 *
 * 把同一份插件复制成两个目录，用 `-e A -e B` 显式加载两份（不依赖本机装了哪些包）：
 * pi 会给两个不同的 `pi` 对象、同一个 `ctx`。必须做到：
 *   1. 只有一个负责人：启动提示（enabled=false）只出现一次；
 *   2. `/qq` 命令只注册一次——同名命令注册两次时 pi 的后果是「谁都别执行」。
 *
 * 没有 `pi` 可执行文件时自动跳过（`npm test` 在纯 Node 环境里仍可跑）。
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function hasPi() {
	try {
		execFileSync("pi", ["--version"], { stdio: "ignore", timeout: 20_000 });
		return true;
	} catch {
		return false;
	}
}

test("双实例加载：只一个负责人、命令只注册一次", async (t) => {
	if (!hasPi()) {
		t.skip("本机没有 pi 可执行文件，跳过双实例加载用例");
		return;
	}
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-qq-connect-dup-"));
	// 把插件复制成第二份，确保真的是两个模块实例（不是同一路径被去重）
	const copy = path.join(dir, "pkg-b");
	fs.mkdirSync(copy, { recursive: true });
	for (const entry of ["index.js", "package.json", "src"]) {
		fs.cpSync(path.join(root, entry), path.join(copy, entry), { recursive: true });
	}
	const agentDir = path.join(dir, "agent");
	fs.mkdirSync(agentDir, { recursive: true });
	const configPath = path.join(dir, "config.json");
	fs.writeFileSync(
		configPath,
		JSON.stringify({ enabled: false, appId: "1234567890", clientSecret: "x", sandbox: true, allowAll: true }),
	);

	const child = spawn("pi", ["--mode", "rpc", "--no-session", "-e", root, "-e", copy], {
		cwd: dir,
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PIQQCONNECT_CONFIG: configPath },
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
	child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
	child.on("error", (err) => (stderr += String(err?.message ?? err)));

	const until = async (check, label, timeoutMs = 20_000) => {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			if (check()) return true;
			if (Date.now() > deadline) return false;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	};

	try {
		const started = await until(() => /enabled=false/.test(stdout), "插件启动提示");
		assert.ok(started, `插件没有启动：${stderr.slice(-800)}`);
		child.stdin.write(JSON.stringify({ id: "1", type: "prompt", message: "/qq status" }) + "\n");
		const replied = await until(() => /配置：/.test(stdout), "/qq status 回执");
		assert.ok(replied, `命令没有执行（同名命令重复注册会让谁都别执行）：${stderr.slice(-800)}`);

		await t.test("启动提示只出现一次（只有一个负责人在启动桥）", () => {
			const hits = stdout.match(/enabled=false/g) ?? [];
			assert.equal(hits.length, 1, `出现 ${hits.length} 次`);
		});
		await t.test("命令只回一次", () => {
			const hits = stdout.match(/配置：/g) ?? [];
			assert.equal(hits.length, 1, `回执出现 ${hits.length} 次`);
		});
		await t.test("AppID 已打码", () => {
			const line = stdout.split("\n").find((l) => l.includes("环境：")) ?? "";
			assert.ok(line.includes("1234***890"), `AppID 没有打码：${line.slice(0, 200)}`);
		});
	} finally {
		child.kill("SIGTERM");
		await new Promise((resolve) => setTimeout(resolve, 300));
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
