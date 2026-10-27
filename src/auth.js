/**
 * QQ 开放平台 access_token：缓存 + 提前刷新 + 并发去重。
 * 文档：POST https://api.bot.qq.com/app/getAppAccessToken（旧域名 bots.qq.com 仍兼容）
 *      body { appId, clientSecret } → { access_token, expires_in }（expires_in 是字符串）
 */

import { maskAppId } from "./text.js";

const DEFAULT_TOKEN_URL = "https://api.bot.qq.com/app/getAppAccessToken";
const REFRESH_MARGIN_MS = 60_000;

export class QqAuthError extends Error {}

export class QqAuth {
	constructor({ appId, clientSecret, tokenUrl = DEFAULT_TOKEN_URL, log }) {
		this.appId = appId;
		this.clientSecret = clientSecret;
		this.tokenUrl = tokenUrl || DEFAULT_TOKEN_URL;
		this.log = log;
		this.token = undefined;
		this.expiresAt = 0;
		this.inflight = undefined;
	}

	async getToken() {
		if (this.token && Date.now() < this.expiresAt - REFRESH_MARGIN_MS) return this.token;
		if (this.inflight) return this.inflight;
		this.inflight = this.#fetchToken().finally(() => {
			this.inflight = undefined;
		});
		return this.inflight;
	}

	invalidate() {
		this.token = undefined;
		this.expiresAt = 0;
	}

	/** 供日志使用的脱敏版本 */
	describe() {
		return `appId=${maskAppId(this.appId)} token=${this.token ? "cached" : "none"}`;
	}

	async #fetchToken() {
		let res;
		try {
			res = await fetch(this.tokenUrl, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ appId: this.appId, clientSecret: this.clientSecret }),
				signal: AbortSignal.timeout(15_000),
			});
		} catch (err) {
			throw new QqAuthError(`token 请求失败：${this.redact(err?.message ?? String(err))}`);
		}
		let body;
		try {
			body = await res.json();
		} catch {
			throw new QqAuthError(`token 响应不是 JSON（HTTP ${res.status}）`);
		}
		if (!res.ok || !body?.access_token) {
			// token 接口失败也返回 HTTP 200，错误码在 body.code 里
			const status = body?.code !== undefined ? `code ${body.code}` : `HTTP ${res.status}`;
			const detail = body?.message ? `：${this.redact(body.message)}` : "";
			throw new QqAuthError(`取 token 失败（${status}）${detail}`);
		}
		const seconds = Number(body.expires_in ?? 7200) || 7200;
		this.token = body.access_token;
		this.expiresAt = Date.now() + seconds * 1000;
		this.log?.debug(`token 刷新成功，有效期 ${seconds}s`);
		return this.token;
	}

	redact(message) {
		let out = String(message ?? "");
		const secrets = [this.appId, this.clientSecret, this.token]
			.filter((v) => typeof v === "string" && v.length >= 4)
			.sort((a, b) => b.length - a.length);
		for (const secret of secrets) out = out.split(secret).join("[redacted]");
		return out;
	}
}
