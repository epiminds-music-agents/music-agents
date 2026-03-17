import { describe, expect, it, vi } from "vitest"
import {
	createModel,
	requestDiscussionDecision,
	requestLoopRecommendation,
	requestMoves,
} from "./ai-service.js"

describe("ai-service", () => {
	it("prefers Vertex when GOOGLE_CLOUD_PROJECT is set", () => {
		const vertexFactory = vi.fn(() => vi.fn(() => "vertex-model"))
		const googleFactory = vi.fn()

		const model = createModel({
			env: {
				GOOGLE_CLOUD_PROJECT: "project-1",
				GOOGLE_CLOUD_LOCATION: "europe-north1",
			},
			geminiModel: "gemini-test",
			createVertexFactory: vertexFactory,
			createGoogleFactory: googleFactory,
		})

		expect(model).toBe("vertex-model")
		expect(vertexFactory).toHaveBeenCalledWith({
			project: "project-1",
			location: "europe-north1",
		})
		expect(googleFactory).not.toHaveBeenCalled()
	})

	it("falls back to Google API key auth when cloud project is missing", () => {
		const googleFactory = vi.fn(() => vi.fn(() => "google-model"))

		const model = createModel({
			env: {
				GEMINI_API_KEY: "secret",
			},
			geminiModel: "gemini-test",
			createVertexFactory: vi.fn(),
			createGoogleFactory: googleFactory,
		})

		expect(model).toBe("google-model")
		expect(googleFactory).toHaveBeenCalledWith({ apiKey: "secret" })
	})

	it("throws when no credentials are available", () => {
		expect(() =>
			createModel({
				env: {},
				geminiModel: "gemini-test",
				createVertexFactory: vi.fn(),
				createGoogleFactory: vi.fn(),
			}),
		).toThrow("Missing Gemini credentials")
	})

	it("extracts planned moves from the first tool call", async () => {
		const generateText = vi.fn(async () => ({
			toolCalls: [{ input: { moves: [{ row: 1, step: 2, value: true }] } }],
		}))

		const result = await requestMoves({
			generateTextImpl: generateText,
			toolBuilder: (config) => config,
			model: "model",
			system: "system",
			prompt: "prompt",
			agentName: "PULSE",
			moveTemperature: 0.7,
			maxOutputTokens: 300,
			plannedMovesSchema: { shape: "schema" },
		})

		expect(result).toEqual({ moves: [{ row: 1, step: 2, value: true }] })
	})

	it("returns a silent decision when the stay_silent tool is chosen", async () => {
		const generateText = vi.fn(async () => ({
			toolCalls: [{ toolName: "stay_silent", input: {} }],
		}))

		const result = await requestDiscussionDecision({
			generateTextImpl: generateText,
			toolBuilder: (config) => config,
			model: "model",
			system: "system",
			prompt: "prompt",
			agentName: "WAVE",
			discussionTemperature: 0.8,
			maxOutputTokens: 220,
			sendMessageSchema: { shape: "schema" },
			mustSpeak: false,
		})

		expect(result).toEqual({ action: "silent", text: "" })
	})

	it("offers recommend_loops as a tool distinct from plan_notes", async () => {
		const generateText = vi.fn(async () => ({ toolCalls: [] }))
		const toolBuilder = vi.fn((config) => config)

		await requestLoopRecommendation({
			generateTextImpl: generateText,
			toolBuilder,
			recommendLoopsImpl: vi.fn(async () => []),
			model: "model",
			system: "system",
			prompt: "prompt",
			agentName: "PULSE",
			loopQuerySchema: { shape: "schema" },
		})

		const toolNames = toolBuilder.mock.calls.map((call) => call[0].name ?? "unnamed")
		expect(toolNames).toContain("recommend_loops")
		expect(toolNames).not.toContain("plan_notes")
	})

	it("forwards model tool-call args to the retrieval client", async () => {
		const queryArgs = { text: "dark bass", role: "bass", bpm_target: 140, top_k: 3 }
		const generateText = vi.fn(async () => ({
			toolCalls: [{ toolName: "recommend_loops", input: queryArgs }],
		}))
		const fakeResults = [{ id: "bass-1", overall_score: 0.9 }]
		const recommendLoopsImpl = vi.fn(async () => fakeResults)

		const result = await requestLoopRecommendation({
			generateTextImpl: generateText,
			toolBuilder: (config) => config,
			recommendLoopsImpl,
			model: "model",
			system: "system",
			prompt: "prompt",
			agentName: "PULSE",
			loopQuerySchema: { shape: "schema" },
		})

		expect(recommendLoopsImpl).toHaveBeenCalledWith(expect.objectContaining(queryArgs))
		expect(result).toEqual(fakeResults)
	})

	it("returns null when the retrieval client throws", async () => {
		const generateText = vi.fn(async () => ({
			toolCalls: [{ toolName: "recommend_loops", input: { text: "bass" } }],
		}))
		const recommendLoopsImpl = vi.fn(async () => {
			throw new Error("loop-oracle request failed: 503")
		})

		const result = await requestLoopRecommendation({
			generateTextImpl: generateText,
			toolBuilder: (config) => config,
			recommendLoopsImpl,
			model: "model",
			system: "system",
			prompt: "prompt",
			agentName: "PULSE",
			loopQuerySchema: { shape: "schema" },
		})

		expect(result).toBeNull()
	})

	it("returns null when the model chooses skip_loops", async () => {
		const generateText = vi.fn(async () => ({
			toolCalls: [{ toolName: "skip_loops", input: {} }],
		}))

		const result = await requestLoopRecommendation({
			generateTextImpl: generateText,
			toolBuilder: (config) => config,
			recommendLoopsImpl: vi.fn(),
			model: "model",
			system: "system",
			prompt: "prompt",
			agentName: "PULSE",
			loopQuerySchema: { shape: "schema" },
		})

		expect(result).toBeNull()
	})
})
