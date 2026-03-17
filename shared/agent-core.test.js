import { describe, it, expect } from "vitest"
import { MockLanguageModelV3 } from "ai/test"
import { createAgent } from "./agent-core.js"

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeGrid(rows = 16, steps = 16) {
	return Array.from({ length: rows }, () => Array(steps).fill(false))
}

/**
 * Build an in-memory WebSocket constructor.
 *
 * On construction it immediately (via microtask) fires "open", then delivers
 * each message in `inboundMessages` in order.
 *
 * The constructor carries the WS readyState constants so agent-core can use
 * FakeWS.OPEN / FakeWS.CLOSED in place of the real ws module's constants.
 */
function buildFakeWebSocket(inboundMessages = []) {
	function FakeWS(_url, _opts) {
		this.readyState = FakeWS.OPEN
		const handlers = {}

		this.on = (event, handler) => {
			handlers[event] = handler
		}

		this.send = (_data) => {} // captured via onSend override instead

		this.close = (_code, _reason) => {
			this.readyState = FakeWS.CLOSED
			handlers["close"]?.()
		}

		// Deliver open + messages asynchronously so `.on()` calls complete first
		Promise.resolve().then(async () => {
			handlers["open"]?.()
			for (const msg of inboundMessages) {
				await handlers["message"]?.(JSON.stringify(msg))
			}
		})
	}

	FakeWS.OPEN = 1
	FakeWS.CONNECTING = 0
	FakeWS.CLOSING = 2
	FakeWS.CLOSED = 3

	return FakeWS
}

function flushMicrotasks() {
	return new Promise((resolve) => setTimeout(resolve, 0))
}

const BASE_CONFIG = {
	name: "PULSE",
	color: "#fff",
	description: "test agent",
	personality: "PULSE",
	systemPrompt: "You are a test agent.",
}

const INIT_MESSAGE = {
	type: "init",
	state: { grid: makeGrid(), bpm: 120, isPlaying: false },
	agents: [],
	discussion: [],
}

/**
 * ManualClock — captures the onTick callback so tests can fire beats manually.
 * Returns { clock, tick } where tick() fires one beat.
 */
function buildManualClock() {
	let onTick = null
	const clock = {
		start(_bpm, cb) {
			onTick = cb
		},
		stop() {
			onTick = null
		},
		updateBpm(_bpm) {},
	}
	return {
		clock,
		tick: () => onTick?.(),
	}
}

/**
 * Build a MockLanguageModelV3 that returns the given moves on every doGenerate call.
 */
function buildFakeModel(moves) {
	return new MockLanguageModelV3({
		doGenerate: {
			content: [
				{
					type: "tool-call",
					toolCallId: "tc-1",
					toolName: "plan_notes",
					input: JSON.stringify({ moves }),
				},
			],
			finishReason: { type: "tool-calls" },
			usage: {
				inputTokens: { total: 1, noCache: 1, cacheRead: 0 },
				outputTokens: { total: 1 },
			},
		},
	})
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("createAgent", () => {
	it("sends cell_set in scope after scope_assigned with isPlaying: true", async () => {
		const sent = []
		const { clock, tick } = buildManualClock()
		const model = buildFakeModel([{ row: 1, step: 3, value: true, velocity: 0.8 }])

		const FakeWS = buildFakeWebSocket([
			INIT_MESSAGE,
			{
				type: "scope_assigned",
				scopeStart: 0,
				scopeEnd: 2,
				currentGrid: makeGrid(),
				bpm: 120,
				isPlaying: true,
			},
		])

		const agent = createAgent(BASE_CONFIG, {
			WebSocket: FakeWS,
			onSend: (msg) => sent.push(msg),
			clock,
			model,
		})

		agent.connect("ws://fake", "agent-1")
		await flushMicrotasks()
		await flushMicrotasks()

		// Fire one beat — should dequeue the planned move and send cell_set
		tick()
		await flushMicrotasks()

		expect(sent.find((m) => m.type === "cell_set")).toMatchObject({
			type: "cell_set",
			row: 1,
			step: 3,
			value: true,
		})
	})

	it("does not send cell_set for rows outside scope", async () => {
		const sent = []
		const { clock, tick } = buildManualClock()
		// Model returns a move in row 5, but scope is rows 0-2
		const model = buildFakeModel([{ row: 5, step: 0, value: true, velocity: 0.8 }])

		const FakeWS = buildFakeWebSocket([
			INIT_MESSAGE,
			{
				type: "scope_assigned",
				scopeStart: 0,
				scopeEnd: 2,
				currentGrid: makeGrid(),
				bpm: 120,
				isPlaying: true,
			},
		])

		const agent = createAgent(BASE_CONFIG, {
			WebSocket: FakeWS,
			onSend: (msg) => sent.push(msg),
			clock,
			model,
		})

		agent.connect("ws://fake", "agent-1")
		await flushMicrotasks()
		await flushMicrotasks()

		tick()
		await flushMicrotasks()

		const cellSets = sent.filter((m) => m.type === "cell_set")
		expect(cellSets).toHaveLength(0)
	})

	it("disconnect() stops the beat loop and closes the socket", async () => {
		const clockStopped = { value: false }
		const socketClosed = { value: false }

		const clock = {
			start: () => {},
			stop: () => {
				clockStopped.value = true
			},
			updateBpm: () => {},
		}

		let closeFn
		function FakeWS(_url, _opts) {
			this.readyState = FakeWS.OPEN
			const handlers = {}
			this.on = (event, handler) => {
				handlers[event] = handler
			}
			this.send = () => {}
			this.close = (_code, _reason) => {
				socketClosed.value = true
				this.readyState = FakeWS.CLOSED
				handlers["close"]?.()
			}
			closeFn = this.close.bind(this)
			Promise.resolve().then(async () => {
				handlers["open"]?.()
				await handlers["message"]?.(JSON.stringify(INIT_MESSAGE))
				await handlers["message"]?.(
					JSON.stringify({
						type: "scope_assigned",
						scopeStart: 0,
						scopeEnd: 2,
						currentGrid: makeGrid(),
						bpm: 120,
						isPlaying: true,
					}),
				)
			})
		}
		FakeWS.OPEN = 1
		FakeWS.CONNECTING = 0
		FakeWS.CLOSING = 2
		FakeWS.CLOSED = 3

		const model = buildFakeModel([])
		const agent = createAgent(BASE_CONFIG, {
			WebSocket: FakeWS,
			onSend: () => {},
			clock,
			model,
		})

		agent.connect("ws://fake", "agent-1")
		await flushMicrotasks()
		await flushMicrotasks()

		agent.disconnect()

		expect(clockStopped.value).toBe(true)
		expect(socketClosed.value).toBe(true)
	})

	it("sends agent_connect after WS open + init", async () => {
		const sent = []
		const FakeWS = buildFakeWebSocket([INIT_MESSAGE])

		const agent = createAgent(BASE_CONFIG, {
			WebSocket: FakeWS,
			onSend: (msg) => sent.push(msg),
		})

		agent.connect("ws://fake", "agent-1")
		await flushMicrotasks()
		await flushMicrotasks()

		expect(sent.find((m) => m.type === "agent_connect")).toMatchObject({
			type: "agent_connect",
			agentId: "agent-1",
			name: "PULSE",
		})
	})

	it("stops sending cell_set after play_state:false, resumes after play_state:true", async () => {
		const sent = []
		const { clock, tick } = buildManualClock()
		const model = buildFakeModel([
			{ row: 0, step: 0, value: true, velocity: 0.8 },
			{ row: 0, step: 1, value: true, velocity: 0.8 },
			{ row: 0, step: 2, value: true, velocity: 0.8 },
			{ row: 0, step: 3, value: true, velocity: 0.8 },
			{ row: 0, step: 4, value: true, velocity: 0.8 },
		])

		let wsHandlers = {}
		function FakeWS(_url, _opts) {
			this.readyState = FakeWS.OPEN
			this.on = (event, handler) => { wsHandlers[event] = handler }
			this.send = () => {}
			this.close = () => { this.readyState = FakeWS.CLOSED }
			Promise.resolve().then(async () => {
				wsHandlers["open"]?.()
				await wsHandlers["message"]?.(JSON.stringify(INIT_MESSAGE))
				await wsHandlers["message"]?.(JSON.stringify({
					type: "scope_assigned",
					scopeStart: 0, scopeEnd: 5,
					currentGrid: makeGrid(), bpm: 120, isPlaying: true,
				}))
			})
		}
		FakeWS.OPEN = 1; FakeWS.CONNECTING = 0; FakeWS.CLOSING = 2; FakeWS.CLOSED = 3

		const agent = createAgent(BASE_CONFIG, {
			WebSocket: FakeWS, onSend: (msg) => sent.push(msg), clock, model,
		})
		agent.connect("ws://fake", "agent-1")
		await flushMicrotasks()
		await flushMicrotasks()

		// Playing: first tick should produce a cell_set
		tick()
		await flushMicrotasks()
		const countAfterFirstTick = sent.filter((m) => m.type === "cell_set").length
		expect(countAfterFirstTick).toBe(1)

		// Stop playback
		await wsHandlers["message"]?.(JSON.stringify({ type: "play_state", isPlaying: false }))
		await flushMicrotasks()

		// Tick while stopped — no new cell_set
		tick()
		await flushMicrotasks()
		expect(sent.filter((m) => m.type === "cell_set")).toHaveLength(1)

		// Resume playback
		await wsHandlers["message"]?.(JSON.stringify({ type: "play_state", isPlaying: true }))
		await flushMicrotasks()

		// Tick again — should produce another cell_set
		tick()
		await flushMicrotasks()
		expect(sent.filter((m) => m.type === "cell_set").length).toBeGreaterThan(1)
	})

	it("re-plans when moveQueue drains to threshold", async () => {
		let planCallCount = 0
		const { clock, tick } = buildManualClock()

		// Return 5 moves on first call, then 5 more on subsequent calls
		const makeMoves = (offset = 0) =>
			Array.from({ length: 5 }, (_, i) => ({
				row: 0, step: i + offset, value: true, velocity: 0.8,
			}))

		let callIndex = 0
		const model = {
			specificationVersion: "v3",
			provider: "fake",
			modelId: "fake",
			doGenerate: async () => {
				planCallCount++
				const moves = makeMoves(callIndex * 5)
				callIndex++
				return {
					content: [{
						type: "tool-call", toolCallId: "tc-1", toolName: "plan_notes",
						input: JSON.stringify({ moves }),
					}],
					finishReason: { type: "tool-calls" },
					usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0 }, outputTokens: { total: 1 } },
				}
			},
			doStream: async () => { throw new Error("not used") },
		}

		const FakeWS = buildFakeWebSocket([
			INIT_MESSAGE,
			{ type: "scope_assigned", scopeStart: 0, scopeEnd: 5, currentGrid: makeGrid(), bpm: 120, isPlaying: true },
		])

		const agent = createAgent(BASE_CONFIG, {
			WebSocket: FakeWS, onSend: () => {}, clock, model,
		})
		agent.connect("ws://fake", "agent-1")
		await flushMicrotasks()
		await flushMicrotasks()

		const firstPlanCount = planCallCount

		// Drain the queue by ticking — each tick consumes one move
		// After enough ticks, queue hits threshold and triggers a re-plan
		for (let i = 0; i < 5; i++) {
			tick()
			await flushMicrotasks()
		}

		expect(planCallCount).toBeGreaterThan(firstPlanCount)
	})
})
