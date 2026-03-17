import { describe, expect, it, vi } from "vitest"
import { recommendLoops } from "./loop-client.js"

const FAKE_URL = "http://oracle.internal"

function makeResult(overrides = {}) {
	return {
		id: "bass-1",
		filename: "Dark Bass Loop 140 Fm.wav",
		role: "bass",
		bpm: 140,
		key: "F",
		mode: "minor",
		style_hints: ["techno"],
		feeling_scores: { darkness: 0.8 },
		overall_score: 0.82,
		semantic_score: 0.9,
		feeling_match_score: 0.75,
		compatibility_score: 1.0,
		explanations: ["role match: bass"],
		...overrides,
	}
}

function makeFetch(status, body) {
	return vi.fn(async () => ({
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
		text: async () => JSON.stringify(body),
	}))
}

describe("loop-client", () => {
	it("sends camelCase params as snake_case to /recommend_loops", async () => {
		const fetch = makeFetch(200, [])

		await recommendLoops({
			baseUrl: FAKE_URL,
			fetch,
			text: "dark bass",
			role: "bass",
			bpmTarget: 140,
			bpmTolerance: 8,
			key: "F",
			mode: "minor",
			compatibleWith: "G",
			stylePreferences: ["techno"],
			feelingTarget: { darkness: 0.8 },
			excludeRoles: ["lead"],
			topK: 5,
		})

		expect(fetch).toHaveBeenCalledOnce()
		const [url, options] = fetch.mock.calls[0]
		expect(url).toBe(`${FAKE_URL}/recommend_loops`)
		const body = JSON.parse(options.body)
		expect(body).toMatchObject({
			text: "dark bass",
			role: "bass",
			bpm_target: 140,
			bpm_tolerance: 8,
			key: "F",
			mode: "minor",
			compatible_with: "G",
			style_preferences: ["techno"],
			feeling_target: { darkness: 0.8 },
			exclude_roles: ["lead"],
			top_k: 5,
		})
	})

	it("returns parsed results on success", async () => {
		const result = makeResult()
		const fetch = makeFetch(200, [result])

		const results = await recommendLoops({ baseUrl: FAKE_URL, fetch, text: "bass" })

		expect(results).toHaveLength(1)
		expect(results[0].id).toBe("bass-1")
		expect(results[0].overall_score).toBe(0.82)
	})

	it("returns empty array when service finds no matches", async () => {
		const fetch = makeFetch(200, [])

		const results = await recommendLoops({ baseUrl: FAKE_URL, fetch, text: "rare sound" })

		expect(results).toEqual([])
	})

	it("throws with status when service returns an error", async () => {
		const fetch = makeFetch(503, { detail: "Index not ready" })

		await expect(
			recommendLoops({ baseUrl: FAKE_URL, fetch, text: "bass" }),
		).rejects.toThrow("503")
	})
})
