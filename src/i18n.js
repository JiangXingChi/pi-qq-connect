/** English notice codes for pi-qq-connect: every warning/error carries a stable [CODE] prefix. */
export const CODE = {
	NO_CONFIG: "QQ_E_NO_CONFIG",
	LOCK_HELD: "QQ_E_LOCK_HELD",
	LOCK_TAKEN: "QQ_E_LOCK_TAKEN",
	CONFIG_PERM: "QQ_E_CONFIG_PERM",
	SERVICE_STALE: "QQ_E_SERVICE_STALE",
	SERVICE_START_FAILED: "QQ_E_SERVICE_START_FAILED",
	STOP_FAILED: "QQ_E_STOP_FAILED",
	TAKEOVER_FAILED: "QQ_E_TAKEOVER_FAILED",
	NEW_SESSION_FAILED: "QQ_E_NEW_SESSION_FAILED",
	GATEWAY_OFFLINE: "QQ_E_GATEWAY_OFFLINE",
	REPLY_FAILED: "QQ_E_REPLY_FAILED",
	BRIDGE_PAUSED: "QQ_E_BRIDGE_PAUSED",
	INJECT_FAILED: "QQ_E_INJECT_FAILED",
	FILE_SEND_FAILED: "QQ_E_FILE_SEND_FAILED",
	UNKNOWN_COMMAND: "QQ_E_UNKNOWN_COMMAND",
	TUI_ONLY: "QQ_E_TUI_ONLY",
	LOGIN_FAILED: "QQ_E_LOGIN_FAILED",
	LOGOUT_BLOCKED: "QQ_E_LOGOUT_BLOCKED",
};

/** `[CODE] text: detail` — detail is optional. */
export function err(code, text, detail) {
	const body = detail === undefined || detail === null || detail === "" ? text : `${text}: ${detail}`;
	return `[${code}] ${body}`;
}
