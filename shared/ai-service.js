import { generateText, tool } from "ai"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createVertex } from "@ai-sdk/google-vertex"

export function createModel({
	env = process.env,
	geminiModel,
	createVertexFactory = createVertex,
	createGoogleFactory = createGoogleGenerativeAI,
}) {
	if (env.GOOGLE_CLOUD_PROJECT) {
		const vertex = createVertexFactory({
			project: env.GOOGLE_CLOUD_PROJECT,
			location: env.GOOGLE_CLOUD_LOCATION || "europe-north1",
		})
		return vertex(geminiModel)
	}

	const apiKey = env.GEMINI_API_KEY || env.GOOGLE_GENERATIVE_AI_API_KEY
	if (!apiKey) {
		throw new Error("Missing Gemini credentials")
	}

	const google = createGoogleFactory({ apiKey })
	return google(geminiModel)
}

export async function requestMoves({
	generateTextImpl = generateText,
	toolBuilder = tool,
	model,
	system,
	prompt,
	agentName,
	moveTemperature,
	maxOutputTokens,
	plannedMovesSchema,
}) {
	const { toolCalls } = await generateTextImpl({
		model,
		system,
		prompt,
		tools: {
			plan_notes: toolBuilder({
				description: `Plan up to 16 note changes in ${agentName}'s assigned rows.`,
				inputSchema: plannedMovesSchema,
			}),
		},
		toolChoice: { type: "tool", toolName: "plan_notes" },
		temperature: moveTemperature,
		maxOutputTokens,
	})
	const firstCall = toolCalls[0]
	return firstCall?.input ?? firstCall?.args ?? null
}

export async function requestLoopRecommendation({
	generateTextImpl = generateText,
	toolBuilder = tool,
	recommendLoopsImpl,
	model,
	system,
	prompt,
	agentName,
	loopQuerySchema,
}) {
	const { toolCalls } = await generateTextImpl({
		model,
		system,
		prompt,
		tools: {
			recommend_loops: toolBuilder({
				name: "recommend_loops",
				description: `Search the loop oracle for audio loops that fit ${agentName}'s current musical context.`,
				inputSchema: loopQuerySchema,
			}),
			skip_loops: toolBuilder({
				name: "skip_loops",
				description: "Decide not to search for loops this beat.",
				inputSchema: { type: "object", shape: {} },
			}),
		},
		toolChoice: "required",
	})
	const call = toolCalls[0]
	if (!call || call.toolName === "skip_loops") {
		return null
	}
	const args = call.input ?? call.args ?? {}
	try {
		return await recommendLoopsImpl(args)
	} catch {
		return null
	}
}

export async function requestDiscussionDecision({
	generateTextImpl = generateText,
	toolBuilder = tool,
	model,
	system,
	prompt,
	agentName,
	discussionTemperature,
	maxOutputTokens,
	sendMessageSchema,
	mustSpeak = false,
}) {
	const { toolCalls } = await generateTextImpl({
		model,
		system,
		prompt,
		tools: {
			send_message: toolBuilder({
				description: `Send a chat message, musical note, or section plan as ${agentName}.`,
				inputSchema: sendMessageSchema,
			}),
			...(!mustSpeak && {
				stay_silent: toolBuilder({
					description: "Decide not to speak right now.",
					inputSchema: { type: "object", shape: {} },
				}),
			}),
		},
		toolChoice: mustSpeak
			? { type: "tool", toolName: "send_message" }
			: "required",
		temperature: discussionTemperature,
		maxOutputTokens,
	})
	const call = toolCalls[0]
	if (!call || call.toolName === "stay_silent") {
		return { action: "silent", text: "" }
	}
	const input = call.input ?? call.args ?? {}
	return {
		action: input.kind,
		text: input.text ?? "",
		agreement: input.agreement,
	}
}
