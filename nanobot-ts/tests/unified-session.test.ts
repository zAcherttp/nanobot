/**
 * Stub tests for unified session feature.
 *
 * These tests document the expected behavior ported from the Python suite
 * (tests/agent/test_unified_session.py). They should be implemented once the
 * unified session subsystem is built in nanobot-ts.
 */
import { describe, it } from "vitest";

describe("unified session — key rewriting", () => {
	it.todo("rewrites session key to 'unified:default' when enabled");
	it.todo("different channels share the same key in unified mode");
	it.todo("preserves original channel-based key when disabled");
	it.todo("respects an existing session_key_override instead of rewriting");
});

describe("unified session — config", () => {
	it.todo("unified session is disabled by default");
	it.todo("agent defaults unified_session is false");
	it.todo("agent defaults unified_session can be enabled");
	it.todo("config serializes unified_session as camelCase");
	it.todo("config parses unified_session from camelCase");
	it.todo("config parses unified_session from snake_case");
	it.todo("onboard-generated config contains the unified_session key");
});

describe("unified session — /new command", () => {
	it.todo("/new is not a priority command");
	it.todo("/new is an exact command");
	it.todo("/new clears the unified session");
	it.todo("/new in unified mode does not affect other sessions");
});

describe("unified session — consolidation", () => {
	it.todo("consolidation skips empty session for unified key");
	it.todo("consolidation behavior is identical for any key");
	it.todo("consolidation triggers when over budget with unified key");
});

describe("unified session — task management", () => {
	it.todo("active tasks use the effective key in unified mode");
	it.todo("/stop command finds task in unified mode");
	it.todo("/stop command works cross-channel in unified mode");
});
