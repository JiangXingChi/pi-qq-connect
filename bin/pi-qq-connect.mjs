#!/usr/bin/env node
/**
 * 常驻启动器：拉起 `pi --mode rpc` 并挂本扩展，保持 stdin 不关，pi 就不会退出。
 * QQ 一直在线的同时，这条 pi 会话也持久化在 --session-id 指定的文件里。
 *
 * 用法：
 *   ./bin/pi-qq-connect.mjs                    # 默认 session-id=pi-qq-connect，cwd=当前目录
 *   ./bin/pi-qq-connect.mjs --cwd ~/Agent/Core # 指定 pi 的工作目录
 *   ./bin/pi-qq-connect.mjs --session-id qq    # 指定会话文件
 *   ./bin/pi-qq-connect.mjs --no-restart       # 退出后不自动重启
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { configPath, loadConfig } from "../src/config.js";
import {
	isServiceAlive,
	readServiceState,
	removeServiceState,
	serviceStatePath,
	writeServiceState,
} from "../src/service.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const baseDir = path.dirname(configPath());
const stateFile = serviceStatePath(baseDir);

function arg(name, fallback) {
	const index = process.argv.indexOf(`--${name}`);
	if (index === -1) return fallback;
	const value = process.argv[index + 1];
	return value && !value.startsWith("--") ? value : fallback;
}

const sessionId = arg("session-id", "pi-qq-connect");
const cwd = arg("cwd", process.cwd());
const restart = !process.argv.includes("--no-restart");
// 只打印将要执行的 pi 命令与扩展策略，不启动任何东西（排查「QQ 里为什么没有某个插件」时用）
const dryRun = process.argv.includes("--dry-run");
const extra = [];
const modelIndex = process.argv.indexOf("--model");
const modelValue = modelIndex > -1 ? process.argv[modelIndex + 1] : undefined;
if (modelValue && !modelValue.startsWith("--")) extra.push("--model", modelValue);

let child;
let stopping = false;
let restartDelay = 3000;
let startedAt = 0;
const startedIso = new Date().toISOString();

function beat() {
	try {
		writeServiceState(stateFile, {
			pid: process.pid,
			startedAt: startedIso,
			heartbeatAt: new Date().toISOString(),
			sessionId: String(sessionId),
			cwd: String(cwd),
			version: pkg.version,
		});
	} catch {
		// 状态文件写不进去不影响机器人
	}
}

function scheduleRestart() {
	restartDelay = Date.now() - startedAt > 60_000 ? 3000 : Math.min(restartDelay * 2, 60_000);
	if (restart) {
		setTimeout(launch, restartDelay);
	} else {
		console.error("[pi-qq-connect] --no-restart：服务结束");
		removeServiceState(stateFile);
		process.exit(0);
	}
}

/**
 * `pi list` 的输出是「npm:包名」一行加缩进后的绝对路径；读不到就返回空数组，
 * 调用方退回只加载自身（旧行为）。
 */
function installedPiPackages() {
	const res = spawnSync("pi", ["list"], { encoding: "utf8", timeout: 15_000 });
	if (res.error || res.status !== 0 || !res.stdout) {
		const why = res.error?.message ?? `pi list 退出码 ${res.status}`;
		console.error(`[pi-qq-connect] 读不到已安装插件（${why}），本轮只加载自身`);
		return [];
	}
	const found = [];
	let current;
	for (const line of res.stdout.split("\n")) {
		const text = line.trim();
		if (!text) continue;
		// 路径行以 / 或 ~ 开头（Windows 盘符也算），其余带来源前缀的行是包名；
		// 像「User packages:」这种小节标题两个都不是，直接忽略。
		if (/^(\/|~|[A-Za-z]:[\\/])/.test(text)) {
			if (current && !current.path) current.path = text;
			continue;
		}
		if (/^(npm:|git:|https?:|builtin:|\.\/)/.test(text)) {
			current = { name: text, path: "" };
			found.push(current);
		}
	}
	return found.filter((item) => item.path);
}

/** 本插件自身的包名与根目录：无论 extensions 怎么配，都只加载一份。 */
function isSelf(name, pkgPath) {
	if (String(name).replace(/^npm:/, "") === pkg.name) return true;
	return Boolean(pkgPath) && path.resolve(pkgPath) === root;
}

/**
 * 把配置里的 extensions 解析成启动参数。
 *
 * - "auto"（默认）：一个都不加，交给 pi 自己走完整发现流程——内置扩展、settings 里的包、
 *   ~/.pi/agent/extensions、项目 .pi/extensions、技能、模板、主题、AGENTS.md。
 *   QQ 会话因此和终端会话加载同一套东西，不再由本插件维护白名单。
 * - "none"：`--no-extensions`，只加载自身（隔离模式）。
 * - 数组：`--no-extensions` + 逐个 `--extension`，`builtin:xxx` 原样透传。
 *
 * 自身永远用显式 `--extension <root>` 加载（没装进 settings 也能跑）；自动发现再加载
 * 一份也没关系，入口有 Symbol.for 幂等守卫，只会注册一次。
 */
function extensionFlags(config) {
	const policy = config?.extensions ?? "auto";
	if (policy === "auto") return [];
	if (policy === "none" || (Array.isArray(policy) && policy.length === 0)) return ["--no-extensions"];
	const installed = installedPiPackages();
	const byName = new Map(installed.map((item) => [item.name, item.path]));
	const seen = new Set([pkg.name]);
	const args = ["--no-extensions"];
	const pick = (name, pkgPath) => {
		if (!pkgPath || isSelf(name, pkgPath)) return;
		const bare = String(name).replace(/^npm:/, "");
		if (seen.has(bare)) return;
		seen.add(bare);
		args.push("--extension", pkgPath);
	};
	for (const wanted of policy) {
		// 内置扩展不在 `pi list` 里，pi 自己认 -e builtin:<名字>，直接透传。
		if (String(wanted).startsWith("builtin:")) {
			args.push("--extension", String(wanted));
			continue;
		}
		const resolved = path.isAbsolute(wanted) ? wanted : (byName.get(wanted) ?? byName.get(`npm:${wanted}`));
		if (!resolved) {
			console.error(`[pi-qq-connect] 找不到插件：${wanted}（跳过）`);
			continue;
		}
		pick(wanted, resolved);
	}
	return args;
}

/** RPC 对话框方法：后台没有界面，必须自己应答，否则扩展会一直等下去。 */
const RPC_DIALOGS = new Set(["select", "confirm", "input", "editor"]);

/**
 * 后台跑的是 `pi --mode rpc`，extension_ui_request 只会发给客户端（也就是本进程）。
 * 没人读 stdout 时：对话框会挂住，管道写满后 pi 还会整体卡死。所以这里持续排空 stdout，
 * 遇到对话框就自动回「取消」，并在 stderr 留一行（journald 里能看到）。
 */
function pumpStdout(stream) {
	let buffer = "";
	stream.setEncoding("utf8");
	stream.on("data", (chunk) => {
		buffer += chunk;
		let index;
		while ((index = buffer.indexOf("\n")) !== -1) {
			const line = buffer.slice(0, index).replace(/\r$/, "");
			buffer = buffer.slice(index + 1);
			if (!line.trim()) continue;
			let record;
			try {
				record = JSON.parse(line);
			} catch {
				continue;
			}
			if (record?.type !== "extension_ui_request" || !RPC_DIALOGS.has(record.method)) continue;
			const title = record.title ?? record.message ?? record.method;
			console.error(`[pi-qq-connect] 扩展请求交互（${record.method}：${title}），后台无人应答，已按取消处理`);
			try {
				child?.stdin?.write(`${JSON.stringify({ type: "extension_ui_response", id: record.id, cancelled: true })}\n`);
			} catch {
				// 子进程已退出
			}
		}
	});
	stream.on("error", () => {});
}

/** 拼出要执行的 pi 参数：QQ 服务与终端应当是同一套资源，差别只有 --mode rpc。 */
function buildPlan() {
	const { config } = loadConfig();
	const extensions = extensionFlags(config);
	const args = ["--mode", "rpc", "--session-id", String(sessionId), "--extension", root, ...extensions, ...extra];
	return { config, args, extensions: config?.extensions ?? "auto" };
}

function launch() {
	const plan = buildPlan();
	const { args } = plan;
	console.error(`[pi-qq-connect] 启动：pi ${args.join(" ")}（cwd=${cwd}，extensions=${JSON.stringify(plan.extensions)}）`);
	startedAt = Date.now();
	let launched;
	try {
		launched = spawn("pi", args, {
			cwd: String(cwd),
			stdio: ["pipe", "pipe", "inherit"],
			env: { ...process.env, PIQQCONNECT_SERVICE_PID: String(process.pid) },
		});
	} catch (err) {
		console.error(`[pi-qq-connect] 无法启动 pi：${err.message}`);
		scheduleRestart();
		return;
	}
	if (launched.stdout) pumpStdout(launched.stdout);
	child = launched;
	let ended = false;
	const onEnd = (why) => {
		if (ended) return;
		ended = true;
		child = undefined;
		if (stopping) return;
		console.error(`[pi-qq-connect] pi ${why}`);
		scheduleRestart();
	};
	launched.once("exit", (code, signal) => onEnd(`退出（code=${code} signal=${signal}）`));
	// spawn 失败只发 error/close，不会发 exit；必须走同一套重启逻辑
	launched.once("error", (err) => onEnd(`无法启动：${err.message}`));
	launched.once("close", (code) => onEnd(`关闭（code=${code}）`));
}

function shutdown(signal) {
	stopping = true;
	console.error(`[pi-qq-connect] 收到 ${signal}，停止`);
	try {
		child?.stdin?.end();
		child?.kill("SIGTERM");
	} catch {
		// ignore
	}
	// 等 pi 自己收尾（会释放锁）；超时只结束本进程，不强杀子进程
	const waiter = setInterval(() => {
		if (!child) {
			clearInterval(waiter);
			process.exit(0);
		}
	}, 100);
	waiter.unref?.();
	setTimeout(() => {
		if (child) {
			console.error("[pi-qq-connect] 子进程 8 秒内未退出，强制结束，避免留下占网关的孤儿");
			try {
				child.kill("SIGKILL");
			} catch {
				// ignore
			}
		}
		process.exit(0);
	}, 8000);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("exit", () => removeServiceState(stateFile));

// --dry-run：只回答「会用什么参数拉起 pi」，不碰网关、不写状态文件
if (dryRun) {
	const plan = buildPlan();
	console.log(
		JSON.stringify(
			{ cwd: String(cwd), extensions: plan.extensions, args: plan.args, line: `pi ${plan.args.join(" ")}` },
			null,
			2,
		),
	);
	process.exit(0);
}

// 已经有一个健康的服务时，第二个实例直接退出，避免两个 pi 抢网关/覆盖心跳
const existing = readServiceState(stateFile);
if (existing && existing.pid !== process.pid && isServiceAlive(existing)) {
	console.error(`[pi-qq-connect] 已有后台服务在运行（pid ${existing.pid}），本进程退出`);
	// systemd 下让它可见地失败（配合 StartLimitBurst=3），否则 unit 看起来是 inactive；
	// 手动 /qq start 的场景则干净退出，避免父进程误判。
	process.exit(process.env.INVOCATION_ID ? 1 : 0);
}

beat();
setInterval(beat, 15_000);
launch();
