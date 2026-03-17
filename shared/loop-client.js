export async function recommendLoops({
	baseUrl = process.env.LOOP_INDEXER_URL ?? "http://127.0.0.1:8000",
	fetch: fetchImpl = fetch,
	text,
	role,
	bpmTarget,
	bpmTolerance,
	key,
	mode,
	compatibleWith,
	stylePreferences = [],
	feelingTarget = {},
	excludeRoles = [],
	topK = 5,
} = {}) {
	const response = await fetchImpl(`${baseUrl}/recommend_loops`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			text,
			role,
			bpm_target: bpmTarget,
			bpm_tolerance: bpmTolerance,
			key,
			mode,
			compatible_with: compatibleWith,
			style_preferences: stylePreferences,
			feeling_target: feelingTarget,
			exclude_roles: excludeRoles,
			top_k: topK,
		}),
	})

	if (!response.ok) {
		const body = await response.text()
		throw new Error(`loop-oracle request failed: ${response.status} ${body}`)
	}

	return response.json()
}
