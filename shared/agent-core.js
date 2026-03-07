import WebSocket from "ws"
import { generateText, tool } from "ai"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createVertex } from "@ai-sdk/google-vertex"
import { z } from "zod"

// Gemini 2.0 Flash Lite — lowest latency model
const GEMINI_MODEL = "gemini-2.0-flash-lite"
const DEFAULT_ROWS = 16
const DEFAULT_STEPS = 16
const MAX_CHAT_HISTORY = 50
const MAX_RECENT_GRID_EVENTS = 24
const MAX_PENDING_DISCUSSION_TRIGGERS = 8
const DISCUSSION_WINDOW_MS = 2500
const DISCUSSION_REVIEW_COOLDOWN_MS = 1800
const DISCUSSION_SEND_COOLDOWN_MS = 5000
const PLAN_ORDER = ["PULSE", "WAVE", "GHOST", "CHAOS"]

const PLANNED_MOVES_SCHEMA = z.object({
	moves: z
		.array(
			z.object({
				row: z.number().int(),
				step: z.number().int(),
				value: z.boolean(),
			}),
		)
		.min(1)
		.max(16),
	commentary: z
		.object({
			kind: z.enum(["chat", "note"]).default("note"),
			text: z.string().max(160),
		})
		.optional(),
})

const SECTION_AGREEMENT_SCHEMA = z.object({
	id: z.string().max(32),
	section: z.enum(["groove", "build", "breakdown", "lift", "reset"]),
	density: z.enum(["sparse", "balanced", "full"]),
	interaction: z.enum(["lock", "counter", "call_response", "stagger"]),
	pulseBias: z.enum(["downbeats", "offbeats", "mixed"]),
	holdBars: z.number().int().min(2).max(8),
	emotionalTone: z.string().max(40).optional(),
	harmonicIntent: z.string().max(48).optional(),
	texturalImage: z.string().max(48).optional(),
	roles: z
		.array(
			z.object({
				agent: z.string().max(16),
				task: z.string().max(48),
			}),
		)
		.min(1)
		.max(4)
		.optional(),
})


function createModel() {
	if (process.env.GOOGLE_CLOUD_PROJECT) {
		const vertex = createVertex({
			project: process.env.GOOGLE_CLOUD_PROJECT,
			location: process.env.GOOGLE_CLOUD_LOCATION || "europe-north1",
		})
		return vertex(GEMINI_MODEL)
	}
	const apiKey =
		process.env.GEMINI_API_KEY ||
		process.env.GOOGLE_GENERATIVE_AI_API_KEY
	if (!apiKey) {
		throw new Error("Missing Gemini credentials")
	}
	const google = createGoogleGenerativeAI({ apiKey })
	return google(GEMINI_MODEL)
}

export function createAgent({
	name,
	color,
	description,
	personality,
	systemPrompt,
}) {
	const DISCUSSION_SYSTEM_PROMPT = `${systemPrompt}

DISCUSSION DECISION MODE:
- You are deciding whether to speak right now. Use the provided tools to act.
- Call stay_silent if you have nothing concrete to add right now.
- Call send_message with kind="chat" for direct conversation: align, reassure, refine, or briefly announce your next move.
- Call send_message with kind="note" for a concise field note because the jam actually changed and it matters.
- Call send_message with kind="plan" to propose the next shared section so the group can lock in together for a while.
- Prefer convergence over conflict. If a workable plan already exists, reinforce it or call stay_silent.
- Only propose a plan when the roster changed, the section expired, or the current grid proves the plan has gone stale.
- If another agent proposes a workable plan, support it with a concrete adjustment instead of arguing.
- You may propose an emergent emotional or harmonic turn, but only if it implies a real musical change in density, register, pulse, or note focus.
- If you speak in emotional or narrative terms, tie it to a musical action the others can actually follow.
- Every spoken line must reference concrete evidence from the prompt: an agent, row block, step pattern, density shift, section, or quoted message.
- No generic atmosphere lines, slogans, self-introductions, or repeated motifs.
- Keep any text plain, one short line, max 16 words.`

	let model = null
	let modelInitFailed = false

	let ws = null
	let agentId = null
	let scope = { start: 0, end: DEFAULT_ROWS - 1 }
	let isPlaying = false
	let bpm = 120
	let grid = Array.from({ length: DEFAULT_ROWS }, () =>
		Array(DEFAULT_STEPS).fill(false),
	)
	let lastToggle = 0
	let loopTimer = null
	let chatHistory = []
	let otherAgents = []
	let moveQueue = []
	let planningInProgress = false
	let lastPatternStartTime = Date.now()
	let fullResetNext = false
	let recentGridEvents = []
	let pendingDiscussionTriggers = []
	let discussionTimer = null
	let discussionInProgress = false
	let lastDiscussionAt = 0
	let lastDiscussionCheckAt = 0
	let lastOwnDiscussionText = ""
	let lastPlannedMoveSummary = "No planned motion yet."
	let lastDiscussionGridStats = null
	let activeAgreement = null
	let coordinationGate = null
	let openingMovesCommitted = false
	let transitionMode = {
		mode: "steady",
		remainingPlans: 0,
		reason: "",
	}

	const NOTE_NAMES = [
		"C2",
		"C#2",
		"D2",
		"D#2",
		"E2",
		"G2",
		"B2",
		"E3",
		"C3",
		"E3",
		"G3",
		"C4",
		"G3",
		"A3",
		"C4",
		"E4",
	]
	const ROW_LABELS = [
		"K1",
		"K2",
		"K3",
		"K4",
		"G1",
		"G2",
		"G3",
		"G4",
		"P1",
		"P2",
		"P3",
		"P4",
		"S1",
		"S2",
		"S3",
		"S4",
	]
	const AGREEMENT_DEFAULTS = {
		section: "groove",
		density: "balanced",
		interaction: "lock",
		pulseBias: "mixed",
	}

	function getRowCount() {
		return Array.isArray(grid) && grid.length > 0 ? grid.length : DEFAULT_ROWS
	}

	function getStepCount() {
		return Array.isArray(grid?.[0]) && grid[0].length > 0
			? grid[0].length
			: DEFAULT_STEPS
	}

	function getScopedRows() {
		const maxRow = getRowCount() - 1
		if (maxRow < 0) return []
		const start = Math.max(0, Math.min(scope.start, maxRow))
		const end = Math.max(start, Math.min(scope.end, maxRow))
		return Array.from({ length: end - start + 1 }, (_, i) => start + i)
	}

	function inBounds(row, step) {
		return (
			row >= 0 &&
			row < getRowCount() &&
			step >= 0 &&
			step < getStepCount()
		)
	}

	function sortAgentNames(names) {
		return [...new Set(names)].sort((left, right) => {
			const leftIndex = PLAN_ORDER.indexOf(left)
			const rightIndex = PLAN_ORDER.indexOf(right)
			return (leftIndex === -1 ? 99 : leftIndex) - (rightIndex === -1 ? 99 : rightIndex)
		})
	}

	function getActiveAgentNames(agentList = otherAgents) {
		return sortAgentNames([
			name,
			...agentList.map((agent) => agent.name).filter(Boolean),
		])
	}

	function getRosterSignature(agentList = otherAgents) {
		return getActiveAgentNames(agentList).join("|")
	}

	function normalizeDiscussionKind(kind) {
		if (kind === "note" || kind === "plan") return kind
		return "chat"
	}

	function sanitizeChatMessage(raw) {
		if (!raw) return null

		let text = raw
			.replace(/```[\s\S]*?```/g, " ")
			.replace(/^\s*`+|`+\s*$/g, "")
			.trim()

		const lines = text
			.split(/\n+/)
			.map((line) => line.trim())
			.filter(Boolean)
			.filter((line) => {
				if (/^[\[{]/.test(line)) return false
				if (
					/"(?:row|step|col|moves|value|type|state|agreement)"/i.test(
						line,
					)
				) {
					return false
				}
				return true
			})

		text = lines.join(" ").replace(/\s+/g, " ").trim()
		if (!text) return null
		if (/^[\[{]/.test(text)) return null
		if (/"(?:row|step|col|moves|value|type|state|agreement)"/i.test(text)) {
			return null
		}

		return text.slice(0, 280)
	}

	function normalizeAgreementPhrase(raw, maxLength) {
		return sanitizeChatMessage(String(raw || ""))?.slice(0, maxLength) || undefined
	}

	function isLowSignalDiscussion(action, text) {
		const normalized = String(text || "").trim().toLowerCase()
		if (!normalized) return true

		if (
			/^(i am|i'm)\s+[a-z0-9_-]+/.test(normalized) ||
			/\bready to play\b/.test(normalized) ||
			/\blet'?s make something happen\b/.test(normalized) ||
			/\bnow inhabiting\b/.test(normalized) ||
			/\banchoring the core\b/.test(normalized)
		) {
			return true
		}

		const mentionsAgent = getActiveAgentNames().some((agentName) =>
			normalized.includes(agentName.toLowerCase()),
		)
		const mentionsConcreteDetail =
			mentionsAgent ||
			/\brows?\s+\d/.test(normalized) ||
			/\bsteps?\s+\d/.test(normalized) ||
			/\b(offbeat|downbeat|groove|build|breakdown|lift|reset|stagger|lock|counter|clear|remove|add|anchor|syncop|density|section|minor|major|modal|dark|bright|sad|grief|mourn|joy|warm|cold|tense|release|resolve|disson|conson|texture|register|palette)\b/.test(
				normalized,
			)

		if ((action === "chat" || action === "note") && !mentionsConcreteDetail) {
			return true
		}

		return false
	}

	function normalizeRoleTask(task) {
		return (
			sanitizeChatMessage(String(task || "")) ||
			"support the section without crowding"
		).slice(0, 48)
	}

	function normalizeAgreement(rawAgreement, sourceName = name, timestamp = Date.now()) {
		if (!rawAgreement || typeof rawAgreement !== "object") return null

		const makeId = String(
			rawAgreement.id || `${sourceName.toLowerCase()}-${timestamp}`,
		)
			.replace(/[^a-z0-9-]/gi, "")
			.slice(0, 32)
		const roles = Array.isArray(rawAgreement.roles)
			? rawAgreement.roles
				.map((role) => ({
					agent: String(role?.agent || "")
						.trim()
						.toUpperCase()
						.slice(0, 16),
					task: normalizeRoleTask(role?.task),
				}))
				.filter((role) => role.agent)
				.slice(0, 4)
			: []
		const agreement = {
			id: makeId || `${sourceName.toLowerCase()}-${timestamp}`,
			section:
				["groove", "build", "breakdown", "lift", "reset"].includes(
					rawAgreement.section,
				)
					? rawAgreement.section
					: AGREEMENT_DEFAULTS.section,
			density:
				["sparse", "balanced", "full"].includes(rawAgreement.density)
					? rawAgreement.density
					: AGREEMENT_DEFAULTS.density,
			interaction:
				["lock", "counter", "call_response", "stagger"].includes(
					rawAgreement.interaction,
				)
					? rawAgreement.interaction
					: AGREEMENT_DEFAULTS.interaction,
			pulseBias:
				["downbeats", "offbeats", "mixed"].includes(
					rawAgreement.pulseBias,
				)
					? rawAgreement.pulseBias
					: AGREEMENT_DEFAULTS.pulseBias,
			holdBars: Math.max(
				2,
				Math.min(8, Number(rawAgreement.holdBars) || 4),
			),
			emotionalTone: normalizeAgreementPhrase(rawAgreement.emotionalTone, 40),
			harmonicIntent: normalizeAgreementPhrase(rawAgreement.harmonicIntent, 48),
			texturalImage: normalizeAgreementPhrase(rawAgreement.texturalImage, 48),
			roles,
			rosterSignature:
				String(rawAgreement.rosterSignature || getRosterSignature()) ||
				getRosterSignature(),
			proposedBy: String(rawAgreement.proposedBy || sourceName)
				.trim()
				.toUpperCase()
				.slice(0, 16),
			createdAt: Number(rawAgreement.createdAt) || timestamp,
			bpmAtCreation: Number(rawAgreement.bpmAtCreation) || bpm,
		}
		return agreement
	}

	function getAgreementHoldMs(agreement) {
		if (!agreement) return 0
		const bpmAtCreation = Number(agreement.bpmAtCreation) || bpm || 120
		return agreement.holdBars * 4 * (60000 / bpmAtCreation)
	}

	function isAgreementCompatibleWithRoster(
		agreement,
		rosterSignature = getRosterSignature(),
	) {
		if (!agreement) return false
		return (
			!agreement.rosterSignature ||
			agreement.rosterSignature === rosterSignature
		)
	}

	function isAgreementExpired(agreement) {
		if (!agreement) return true
		return Date.now() > agreement.createdAt + getAgreementHoldMs(agreement)
	}

	function rebuildActiveAgreementFromHistory() {
		const rosterSignature = getRosterSignature()
		activeAgreement = null
		for (let i = chatHistory.length - 1; i >= 0; i--) {
			const agreement = chatHistory[i]?.agreement
			if (!agreement) continue
			if (!isAgreementCompatibleWithRoster(agreement, rosterSignature)) {
				continue
			}
			if (isAgreementExpired(agreement)) continue
			activeAgreement = agreement
			return agreement
		}
		return null
	}

	function getMyAgreementRole(agreement = activeAgreement) {
		if (!agreement || !Array.isArray(agreement.roles)) return null
		return (
			agreement.roles.find((role) => role.agent === name)?.task || null
		)
	}

	function formatAgreement(agreement = activeAgreement) {
		if (!agreement) return "none"
		const roles =
			Array.isArray(agreement.roles) && agreement.roles.length > 0
				? agreement.roles
					.map((role) => `${role.agent}:${role.task}`)
					.join(" | ")
				: "no explicit roles"
		const moodBits = [
			agreement.emotionalTone ? `tone ${agreement.emotionalTone}` : null,
			agreement.harmonicIntent ? `harmony ${agreement.harmonicIntent}` : null,
			agreement.texturalImage ? `texture ${agreement.texturalImage}` : null,
		]
			.filter(Boolean)
			.join(", ")
		return `${agreement.section}, density ${agreement.density}, interaction ${agreement.interaction}, pulse ${agreement.pulseBias}, hold ${agreement.holdBars} bars${moodBits ? `, ${moodBits}` : ""}, roles ${roles}`
	}

	function describeAgreementStatus() {
		if (!activeAgreement) {
			return "No shared section is locked right now."
		}
		const remainingMs = Math.max(
			0,
			activeAgreement.createdAt +
				getAgreementHoldMs(activeAgreement) -
				Date.now(),
		)
		const barMs = 4 * (60000 / (activeAgreement.bpmAtCreation || bpm || 120))
		const remainingBars = Math.max(0, Math.ceil(remainingMs / barMs))
		return `${formatAgreement(
			activeAgreement,
		)} | about ${remainingBars} bar(s) left`
	}

	function getPlanMessageCount() {
		return chatHistory.filter((message) => message.kind === "plan").length
	}

	function hasMeaningfulGridActivity() {
		const stats = computeGridStats()
		return stats.totalActive >= Math.max(2, getActiveAgentNames().length)
	}

	function getPlanTurnAgent() {
		const activeNames = getActiveAgentNames()
		if (activeNames.length === 0) return name
		const planCount = getPlanMessageCount()
		return activeNames[planCount % activeNames.length]
	}

	function isMyPlanTurn() {
		return getPlanTurnAgent() === name
	}

	function setTransitionMode(mode, reason, remainingPlans = 2) {
		transitionMode = {
			mode,
			reason,
			remainingPlans,
		}
	}

	function consumeTransitionMode() {
		if (transitionMode.remainingPlans <= 0) return
		transitionMode = {
			...transitionMode,
			remainingPlans: transitionMode.remainingPlans - 1,
		}
		if (transitionMode.remainingPlans <= 0) {
			transitionMode = {
				mode: "steady",
				reason: "",
				remainingPlans: 0,
			}
		}
	}

	function formatTransitionState() {
		if (transitionMode.remainingPlans <= 0) {
			return "steady"
		}
		return `${transitionMode.mode} for ${transitionMode.remainingPlans} plan(s): ${transitionMode.reason}`
	}

	function getTransitionInstruction() {
		if (transitionMode.remainingPlans <= 0) {
			return "No roster transition. Stay inside the shared section."
		}
		if (transitionMode.mode === "expand") {
			return `Roster expanded into your hands: ${transitionMode.reason}. Cover more of your rows and add supportive notes for the next ${transitionMode.remainingPlans} plan(s).`
		}
		if (transitionMode.mode === "contract") {
			return `Roster contracted back to a fuller band: ${transitionMode.reason}. Use the next ${transitionMode.remainingPlans} plan(s) to thin duplicates and hand space back.`
		}
		return transitionMode.reason || "steady"
	}

	function normalizeDiscussionMessage(message) {
		if (!message || typeof message !== "object") return null
		const timestamp = Number(message.timestamp) || Date.now()
		const text = sanitizeChatMessage(message.text)
		if (!text) return null
		return {
			agentId: message.agentId || "",
			name: String(message.name || "UNKNOWN")
				.trim()
				.toUpperCase(),
			color: message.color || color,
			text,
			timestamp,
			kind: normalizeDiscussionKind(message.kind),
			agreement: normalizeAgreement(
				message.agreement,
				message.name || "UNKNOWN",
				timestamp,
			),
		}
	}

	function requireVisibleCoordination(reason, triggerType) {
		coordinationGate = {
			reason,
			triggerType,
			openedAt: Date.now(),
		}
	}

	function resolveVisibleCoordination() {
		coordinationGate = null
	}

	function needsVisibleCoordination() {
		return Boolean(coordinationGate)
	}

	function getAgentName(id) {
		if (id === agentId) return name
		const agent = otherAgents.find((entry) => entry.agentId === id)
		return agent?.name || (id ? "UNKNOWN" : "HUMAN")
	}

	function describeCell(row, step) {
		const label = ROW_LABELS[row] || `R${row}`
		const note = NOTE_NAMES[row] || label
		return `${label}/${note}@${step}`
	}

	function send(data) {
		if (ws && ws.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify(data))
		}
	}

	function sendDiscussion(kind, text, { agreement = null } = {}) {
		const sanitized = sanitizeChatMessage(text)
		if (!sanitized) {
			console.log(`[${name}] Dropped non-discussion response`)
			return false
		}

		const normalizedKind = normalizeDiscussionKind(kind)
		const previous = lastOwnDiscussionText.trim().toLowerCase()
		const current = sanitized.trim().toLowerCase()
		if (previous && previous === current) {
			console.log(`[${name}] Dropped repeated discussion line`)
			return false
		}

		let normalizedAgreement = null
		if (normalizedKind === "plan") {
			normalizedAgreement = normalizeAgreement(
				agreement,
				name,
				Date.now(),
			)
			if (!normalizedAgreement) {
				console.log(`[${name}] Dropped plan without agreement payload`)
				return false
			}
			activeAgreement = normalizedAgreement
		}

		lastOwnDiscussionText = sanitized
		lastDiscussionAt = Date.now()
		resolveVisibleCoordination()
		send({
			type: "agent_message",
			agentId,
			name,
			color,
			kind: normalizedKind,
			agreement: normalizedAgreement || undefined,
			text: sanitized,
			timestamp: lastDiscussionAt,
		})
		return true
	}

	function gridSummary() {
		const lines = []
		for (let row = 0; row < getRowCount(); row++) {
			const bits = (grid[row] || [])
				.map((value, step) => (value ? step : ""))
				.filter((value) => value !== "")
			const mine = row >= scope.start && row <= scope.end ? "*" : " "
			const label = ROW_LABELS[row] || `R${row}`
			const note = NOTE_NAMES[row] || label
			lines.push(`${mine}R${row}(${note}): [${bits.join(",")}]`)
		}
		return lines.join(" | ")
	}

	function recentDiscussion() {
		return (
			chatHistory
				.slice(-8)
				.map((message) => {
					const kindLabel =
						message.kind === "note"
							? " [note]"
							: message.kind === "plan"
								? " [plan]"
								: ""
					const selfLabel = message.name === name ? " (you)" : ""
					return `${message.name}${selfLabel}${kindLabel}: ${message.text}`
				})
				.join("\n") || "(none)"
		)
	}

	function computeGridStats() {
		const scopedRows = new Set(getScopedRows())
		let totalActive = 0
		let myActive = 0
		let downbeats = 0
		let offbeats = 0
		const activeRows = new Set()

		for (let row = 0; row < getRowCount(); row++) {
			for (let step = 0; step < getStepCount(); step++) {
				if (!grid[row]?.[step]) continue
				totalActive++
				if (!scopedRows.has(row)) continue
				myActive++
				activeRows.add(row)
				if (step % 4 === 0) downbeats++
				else offbeats++
			}
		}

		return {
			totalActive,
			myActive,
			otherActive: Math.max(0, totalActive - myActive),
			downbeats,
			offbeats,
			activeRows: [...activeRows].sort((left, right) => left - right),
		}
	}

	function formatGridStats(stats) {
		const rowList =
			stats.activeRows
				.map((row) => ROW_LABELS[row] || `R${row}`)
				.join(",") || "none"
		return `total=${stats.totalActive} mine=${stats.myActive} others=${stats.otherActive} myRows=${rowList} myDownbeats=${stats.downbeats} myOffbeats=${stats.offbeats}`
	}

	function formatGridDelta(previous, current) {
		if (!previous) return "n/a"
		const toDelta = (value) =>
			value > 0 ? `+${value}` : value < 0 ? String(value) : "0"
		return `total ${toDelta(
			current.totalActive - previous.totalActive,
		)}, mine ${toDelta(
			current.myActive - previous.myActive,
		)}, others ${toDelta(current.otherActive - previous.otherActive)}`
	}

	function formatRecentGridEvents(windowMs = 4000) {
		const cutoff = Date.now() - windowMs
		const events = recentGridEvents
			.filter((entry) => entry.timestamp >= cutoff)
			.slice(-8)
		if (events.length === 0) return "(none)"
		return events
			.map((entry) => {
				const verb = entry.value ? "lit" : "cleared"
				const area =
					entry.scope === "mine" && entry.actor !== name
						? " in your range"
						: ""
				return `${entry.actor} ${verb} ${describeCell(
					entry.row,
					entry.step,
				)}${area}`
			})
			.join("\n")
	}

	function getBarsElapsed() {
		const elapsedMs = Date.now() - lastPatternStartTime
		const barMs = 4 * (60000 / (bpm || 120))
		return Math.floor(elapsedMs / barMs)
	}

	function summarizeMovePlan(moves) {
		if (!Array.isArray(moves) || moves.length === 0) {
			return "No planned motion yet."
		}
		const adding = moves.filter((m) => m.value)
		const removing = moves.filter((m) => !m.value)
		const descGroup = (group) => {
			if (group.length === 0) return null
			const rows = [...new Set(group.map((m) => m.row))].sort((a, b) => a - b)
			const steps = [...new Set(group.map((m) => m.step))].sort((a, b) => a - b)
			return `${rows.map((r) => ROW_LABELS[r] || `R${r}`).join(",")} steps ${steps.join(",")}`
		}
		const parts = []
		if (adding.length > 0) parts.push(`adding ${adding.length} notes on ${descGroup(adding)}`)
		if (removing.length > 0) parts.push(`removing ${removing.length} notes from ${descGroup(removing)}`)
		return parts.join(" | ") || "No planned motion yet."
	}

	function clearDiscussionTimer() {
		if (discussionTimer) {
			clearTimeout(discussionTimer)
			discussionTimer = null
		}
	}

	function scheduleDiscussionCheck(delayMs = 0) {
		if (discussionTimer) return
		discussionTimer = setTimeout(() => {
			discussionTimer = null
			void flushDiscussionQueue()
		}, delayMs)
	}

	function queueDiscussionTrigger(
		type,
		summary,
		{ delayMs = 900, cooldownMs = DISCUSSION_SEND_COOLDOWN_MS } = {},
	) {
		const singletonTypes = new Set([
			"grid_shift",
			"agreement_needed",
			"section_review",
			"roster_change",
		])
		const trigger = {
			type,
			summary,
			cooldownMs,
			timestamp: Date.now(),
		}

		if (singletonTypes.has(type)) {
			const existingIndex = pendingDiscussionTriggers.findIndex(
				(entry) => entry.type === type,
			)
			if (existingIndex >= 0) {
				pendingDiscussionTriggers[existingIndex] = trigger
			} else {
				pendingDiscussionTriggers.push(trigger)
			}
		} else {
			pendingDiscussionTriggers.push(trigger)
		}

		if (
			pendingDiscussionTriggers.length > MAX_PENDING_DISCUSSION_TRIGGERS
		) {
			pendingDiscussionTriggers = pendingDiscussionTriggers.slice(
				-MAX_PENDING_DISCUSSION_TRIGGERS,
			)
		}

		scheduleDiscussionCheck(delayMs)
	}

	function recordGridEvent({ row, step, value, sourceAgentId }) {
		if (!inBounds(row, step)) return
		recentGridEvents.push({
			timestamp: Date.now(),
			actor: getAgentName(sourceAgentId),
			row,
			step,
			value: Boolean(value),
			scope:
				row >= scope.start && row <= scope.end ? "mine" : "other",
		})
		if (recentGridEvents.length > MAX_RECENT_GRID_EVENTS) {
			recentGridEvents.shift()
		}
		maybeQueueGridShiftDiscussion()
	}

	function maybeQueueGridShiftDiscussion() {
		if (!isPlaying) return
		const cutoff = Date.now() - DISCUSSION_WINDOW_MS
		const recent = recentGridEvents.filter(
			(entry) => entry.timestamp >= cutoff,
		)
		if (recent.length < 6) return

		const uniqueActors = new Set(recent.map((entry) => entry.actor))
		const touchesMyRange = recent.some(
			(entry) => entry.scope === "mine" && entry.actor !== name,
		)
		const currentStats = computeGridStats()
		const densityShift = lastDiscussionGridStats
			? Math.abs(
					currentStats.totalActive -
						lastDiscussionGridStats.totalActive,
				)
			: recent.length

		if (!touchesMyRange && uniqueActors.size < 2 && densityShift < 4) {
			return
		}

		const touchedMine = recent.filter(
			(entry) => entry.scope === "mine" && entry.actor !== name,
		).length
		queueDiscussionTrigger(
			"grid_shift",
			`Recent burst: ${recent.length} toggles in ${DISCUSSION_WINDOW_MS}ms by ${[
				...uniqueActors,
			].join(",")}; ${touchedMine} touched your rows.`,
			{ delayMs: 1200, cooldownMs: 5200 },
		)
	}

	function maybeQueueAgreementReview() {
		if (!isPlaying || !activeAgreement) return
		if (isAgreementExpired(activeAgreement)) {
			const expiredAgreement = activeAgreement
			activeAgreement = null
			queueDiscussionTrigger(
				"section_review",
				`Section expired: ${formatAgreement(expiredAgreement)}.`,
				{ delayMs: 1000, cooldownMs: 2600 },
			)
		}
	}

	function shouldReactToMessage(message) {
		if (!message || message.agentId === agentId) return false
		if (message.kind === "plan" || message.kind === "note") return true
		if (message.text.toUpperCase().includes(name)) return true
		const isReset = /reset|clear|start(ing)? fresh|new pattern/i.test(message.text)
		if (isReset) return true
		return false
	}

	function getAgreementPlanningHint() {
		if (!activeAgreement) {
			return "No shared section agreement is active. Listen to the room and find a cooperative role without crowding."
		}

		const role =
			getMyAgreementRole(activeAgreement) ||
			"support the section without dominating"
		const densityHint =
			activeAgreement.density === "sparse"
				? "Keep density low. Use silence and removals to protect space."
				: activeAgreement.density === "balanced"
					? "Keep a stable mid-density. Add enough support to feel complete without filling every step."
					: "Push energy higher, but still leave one lane of air for contrast."
		const pulseHint =
			activeAgreement.pulseBias === "downbeats"
				? "Favor quarter-note anchors and clear arrivals."
				: activeAgreement.pulseBias === "offbeats"
					? "Lean into syncopation and movement between the strong beats."
					: "Mix anchors and syncopation so the section breathes."
		const interactionHint =
			activeAgreement.interaction === "lock"
				? "Lock around the same pocket and avoid unnecessary deviations."
				: activeAgreement.interaction === "counter"
					? "Counterbalance the others rather than doubling them."
					: activeAgreement.interaction === "call_response"
						? "Leave gaps so phrases can answer each other."
						: "Stagger entrances and exits so the section evolves without collapsing."
		const affectHint = [
			activeAgreement.emotionalTone
				? `Shared tone: ${activeAgreement.emotionalTone}.`
				: null,
			activeAgreement.harmonicIntent
				? `Harmonic direction: ${activeAgreement.harmonicIntent}.`
				: null,
			activeAgreement.texturalImage
				? `Texture image: ${activeAgreement.texturalImage}.`
				: null,
		]
			.filter(Boolean)
			.join(" ")

		return `Shared section: ${formatAgreement(
			activeAgreement,
		)}. Your role: ${role}. ${densityHint} ${pulseHint} ${interactionHint} ${affectHint}`
	}

	// ── AI calls ──────────────────────────────────────────────────────────

	async function getModel() {
		if (modelInitFailed) return null
		if (!model) {
			try {
				model = createModel()
			} catch (err) {
				modelInitFailed = true
				console.error(`[${name}] AI init error:`, err?.message || err)
				return null
			}
		}
		return model
	}

	async function askForMoves(prompt, maxTokens = 350) {
		const activeModel = await getModel()
		if (!activeModel) return null
		try {
			const { toolCalls } = await generateText({
				model: activeModel,
				system: systemPrompt,
				prompt,
				tools: {
					plan_notes: tool({
						description: `Plan up to 16 note changes in ${name}'s assigned rows.`,
						inputSchema: PLANNED_MOVES_SCHEMA,
					}),
				},
				toolChoice: { type: "tool", toolName: "plan_notes" },
				temperature: 0.85,
				maxOutputTokens: maxTokens,
			})
			const firstCall = toolCalls[0]
			const input = firstCall?.input ?? firstCall?.args ?? null
			return input ?? null
		} catch (err) {
			console.error(`[${name}] AI error:`, err?.message || err)
			return null
		}
	}

	async function askForDiscussionDecision(prompt, { mustSpeak = false, maxTokens = 220 } = {}) {
		const activeModel = await getModel()
		if (!activeModel) return null
		try {
			const { toolCalls } = await generateText({
				model: activeModel,
				system: DISCUSSION_SYSTEM_PROMPT,
				prompt,
				tools: {
					send_message: tool({
						description: `Send a chat message, musical note, or section plan as ${name}.`,
						inputSchema: z.object({
							kind: z.enum(["chat", "note", "plan"]),
							text: z.string().max(280),
							agreement: SECTION_AGREEMENT_SCHEMA.optional(),
						}),
					}),
					...(!mustSpeak && {
						stay_silent: tool({
							description: "Decide not to speak right now.",
							inputSchema: z.object({}),
						}),
					}),
				},
				toolChoice: mustSpeak
					? { type: "tool", toolName: "send_message" }
					: "required",
				temperature: 0.82,
				maxOutputTokens: maxTokens,
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
		} catch (err) {
			console.error(`[${name}] AI error:`, err?.message || err)
			return null
		}
	}

	function normalizeMoves(rawMoves) {
		const candidateMoves = Array.isArray(rawMoves?.moves)
			? rawMoves.moves
			: Array.isArray(rawMoves)
				? rawMoves
				: []
		const rows = getScopedRows()
		const rowSet = new Set(rows)
		const maxStep = getStepCount() - 1
		return candidateMoves
			.map((move) => ({
				row: Number(move?.row),
				step: Number(move?.step),
				value: Boolean(move?.value),
			}))
			.filter(
				(move) =>
					Number.isInteger(move.row) && Number.isInteger(move.step),
			)
			.filter((move) => rowSet.has(move.row))
			.filter((move) => move.step >= 0 && move.step <= maxStep)
			.slice(0, 16)
	}

	function queueMoves(moves, source) {
		if (!Array.isArray(moves) || moves.length === 0) return false
		moveQueue = moves.slice(0, 16)
		lastPlannedMoveSummary = summarizeMovePlan(moveQueue)
		if (fullResetNext) {
			fullResetNext = false
			lastPatternStartTime = Date.now()
		}
		consumeTransitionMode()
		console.log(`[${name}] Planned ${moveQueue.length} moves (${source})`)
		return true
	}

	function extractPlannedCommentary(rawPlan) {
		const commentary = rawPlan?.commentary
		if (!commentary || typeof commentary !== "object") return null
		const kind = commentary.kind === "chat" ? "chat" : "note"
		const text = sanitizeChatMessage(commentary.text)
		if (!text || isLowSignalDiscussion(kind, text)) return null
		return { kind, text }
	}

	async function decideDiscussion(triggers) {
		if (!Array.isArray(triggers) || triggers.length === 0) return null

		const currentStats = computeGridStats()
		const mustSpeak = needsVisibleCoordination() && openingMovesCommitted
		const planEligibleTypes = new Set([
			"agreement_needed",
			"section_review",
			"roster_change",
			"full_reset",
			"play_start",
		])
		const planEligible =
			hasMeaningfulGridActivity() &&
			isMyPlanTurn() &&
			triggers.some((trigger) => planEligibleTypes.has(trigger.type))
		const activeAgentsStr = otherAgents
			.map((agent) => {
				const isMe = agent.agentId === agentId
				return `${agent.name}${isMe ? " (YOU)" : ""} rows ${agent.scopeStart}-${agent.scopeEnd}`
			})
			.join(" | ") || "none"
		const prompt = `You are ${name}. You are deciding whether to speak right now.

Trigger(s):
${triggers
	.map(
		(trigger, index) =>
			`${index + 1}. ${trigger.type}: ${trigger.summary}`,
	)
	.join("\n")}

Grid (* = your rows): ${gridSummary()}
Grid stats: ${formatGridStats(currentStats)}
Change since last discussion check: ${formatGridDelta(
		lastDiscussionGridStats,
		currentStats,
	)}
Recent grid changes:
${formatRecentGridEvents()}
Active agents: ${activeAgentsStr}
Shared agreement: ${describeAgreementStatus()}
Plan turn: ${getPlanTurnAgent()}${
			planEligible ? " (you may propose the next section)" : ""
		}
Transition state: ${formatTransitionState()}
Your latest planned motion: ${lastPlannedMoveSummary}
Recent discussion:
${recentDiscussion()}
Last thing YOU said: ${lastOwnDiscussionText || "(none)"}

Available pitch palette is fixed by the current rows and note names shown above. Only propose tonal or emotional shifts the palette can actually suggest.

${
		mustSpeak
			? `You must speak before you change the grid again. Silent is not allowed. Reason: ${coordinationGate?.reason || "coordination required"}.`
			: 'Choose "silent" unless you have a concrete response.'
	}
Only use "plan" if it is your plan turn and the section needs to change.
When referencing other agents, use their exact name as shown above.`

		const decision = await askForDiscussionDecision(prompt, { mustSpeak })
		lastDiscussionGridStats = currentStats
		if (!decision) return null

		const action =
			decision.action === "plan"
				? "plan"
				: decision.action === "note"
					? "note"
					: decision.action === "chat"
						? "chat"
						: "silent"
		const text = sanitizeChatMessage(decision.text || "")
		const agreement =
			action === "plan"
				? normalizeAgreement(decision.agreement, name, Date.now())
				: null

		if (action === "plan" && (!planEligible || !agreement || !text)) {
			return mustSpeak
				? { action: "note", text, agreement: null }
				: { action: "silent", text: "", agreement: null }
		}
		if (action !== "plan" && (action === "silent" || !text)) {
			return { action: "silent", text: "", agreement: null }
		}
		if (
			lastOwnDiscussionText &&
			text &&
			text.trim().toLowerCase() ===
				lastOwnDiscussionText.trim().toLowerCase()
		) {
			return { action: "silent", text: "", agreement: null }
		}
		if (isLowSignalDiscussion(action, text)) {
			return { action: "silent", text: "", agreement: null }
		}

		return { action, text, agreement }
	}

	async function flushDiscussionQueue() {
		if (pendingDiscussionTriggers.length === 0) return
		if (discussionInProgress) {
			scheduleDiscussionCheck(250)
			return
		}

		const sinceLastCheck = Date.now() - lastDiscussionCheckAt
		if (sinceLastCheck < DISCUSSION_REVIEW_COOLDOWN_MS) {
			scheduleDiscussionCheck(
				DISCUSSION_REVIEW_COOLDOWN_MS - sinceLastCheck,
			)
			return
		}

		const requiredCooldown = pendingDiscussionTriggers.reduce(
			(minimum, trigger) =>
				Math.min(
					minimum,
					trigger.cooldownMs ?? DISCUSSION_SEND_COOLDOWN_MS,
				),
			DISCUSSION_SEND_COOLDOWN_MS,
		)
		const sinceLastDiscussion = Date.now() - lastDiscussionAt
		if (sinceLastDiscussion < requiredCooldown) {
			scheduleDiscussionCheck(requiredCooldown - sinceLastDiscussion)
			return
		}

		const triggers = pendingDiscussionTriggers.splice(
			0,
			MAX_PENDING_DISCUSSION_TRIGGERS,
		)
		discussionInProgress = true
		lastDiscussionCheckAt = Date.now()

		const decision = await decideDiscussion(triggers)
		discussionInProgress = false

		if (pendingDiscussionTriggers.length > 0 && !discussionTimer) {
			scheduleDiscussionCheck(700)
		}

		if (!decision || decision.action === "silent") {
			if (needsVisibleCoordination() && !discussionTimer) {
				scheduleDiscussionCheck(400)
			}
			return
		}
		sendDiscussion(decision.action, decision.text, {
			agreement: decision.agreement,
		})
	}

	// ── Plan moves: ask AI for the next batch of toggles ───────────────

	async function planMoves() {
		if (planningInProgress) return
		if (needsVisibleCoordination() && openingMovesCommitted) {
			if (pendingDiscussionTriggers.length === 0) {
				queueDiscussionTrigger(
					"section_review",
					coordinationGate?.reason || "Explain the next move before changing the grid.",
					{ delayMs: 80, cooldownMs: 0 },
				)
			} else if (!discussionInProgress && !discussionTimer) {
				scheduleDiscussionCheck(80)
			}
			if (!discussionInProgress) {
				void flushDiscussionQueue()
			}
		}
		planningInProgress = true
		const rows = getScopedRows()
		const stepMax = getStepCount() - 1
		if (rows.length === 0 || stepMax < 0) {
			planningInProgress = false
			return
		}
		const scopeStart = rows[0]
		const scopeEnd = rows[rows.length - 1]
		const currentStats = computeGridStats()
		const barsElapsed = getBarsElapsed()
		const wasFullReset = fullResetNext

		const resetHint = wasFullReset
			? "FULL RESET: Your rows were just cleared. Generate a completely NEW pattern. All moves value=true. "
			: ""
		const otherNames = otherAgents
			.filter((agent) => agent.agentId !== agentId)
			.map((agent) => agent.name)
			.join(",") || "none"
		const prompt = `${resetHint}Grid (* = your rows): ${gridSummary()}
Grid stats: ${formatGridStats(currentStats)}
BPM:${bpm} | You are ${name} | Your rows:${scopeStart}-${scopeEnd} | Others active:${otherNames}
Bars on current pattern: ${barsElapsed} (if this feels stale or chaotic, use value=false to clear cells and reshape)
Available pitch palette is fixed by your rows and the note names in the grid summary. If you want a darker, brighter, sadder, or tenser section, imply it with the rows you emphasize and the density you choose.
Shared agreement:
${getAgreementPlanningHint()}
Transition:
${getTransitionInstruction()}
Recent discussion:
${recentDiscussion()}
Recent grid changes:
${formatRecentGridEvents()}
Your previous plan: ${lastPlannedMoveSummary}

Output JSON with:
- moves: up to 16 objects [{\"row\":N,\"step\":N,\"value\":true/false},...]
- optional commentary: one short line tied directly to this exact batch
value=true means turn that cell ON (add a note). value=false means turn it OFF (remove a note).
Only include moves that actually change the current grid state.
Rows ${scopeStart}-${scopeEnd}, steps 0-${stepMax}. No explanation outside the JSON fields.`

		const result = await askForMoves(prompt, 350)

		planningInProgress = false

		const parsedMoves = normalizeMoves(result)
		const plannedCommentary = extractPlannedCommentary(result)
		if (queueMoves(parsedMoves, "ai")) {
			if (plannedCommentary) {
				sendDiscussion(plannedCommentary.kind, plannedCommentary.text)
			}
			if (wasFullReset) {
				activeAgreement = null
			}
			// If the AI chose to remove more than half its notes, treat as a self-initiated reset
			const removals = parsedMoves.filter((m) => !m.value).length
			if (!wasFullReset && removals > parsedMoves.length / 2) {
				lastPatternStartTime = Date.now()
				requireVisibleCoordination(
					"You are reshaping your pattern significantly. Say what you're doing before the grid changes.",
					"full_reset",
				)
				queueDiscussionTrigger(
					"full_reset",
					`You are clearing ${removals} notes and reshaping your rows after ${barsElapsed} bars.`,
					{ delayMs: 100, cooldownMs: 2200 },
				)
			}
			return
		}

		console.log(
			`[${name}] Could not produce any valid AI moves${
				result ? " from the response" : ""
			}`,
		)
	}

	// ── Play loop ─────────────────────────────────────────────────────────

	const TOGGLES_PER_BEAT = 6

	function startPlayLoop() {
		if (loopTimer) return
		console.log(`[${name}] Starting play loop`)

		if (!lastDiscussionGridStats) {
			lastDiscussionGridStats = computeGridStats()
		}
		lastPatternStartTime = Date.now()
		planMoves()

		const loop = () => {
			if (!isPlaying || !ws || ws.readyState !== WebSocket.OPEN) {
				loopTimer = null
				return
			}

			const beatInterval = 60000 / bpm
			const tickInterval = beatInterval / TOGGLES_PER_BEAT
			const now = Date.now()

			if (now - lastToggle < tickInterval) {
				loopTimer = setTimeout(
					loop,
					Math.max(20, tickInterval - (now - lastToggle)),
				)
				return
			}

			{
				let moveProcessed = false
				while (moveQueue.length > 0 && !moveProcessed) {
					const move = moveQueue.shift()
					if (!inBounds(move.row, move.step) || !grid[move.row]) continue
					const currentValue = grid[move.row][move.step]
					if (currentValue === move.value) continue
					send({
						type: "cell_set",
						agentId,
						row: move.row,
						step: move.step,
						value: move.value,
					})
					grid[move.row][move.step] = move.value
					recordGridEvent({
						row: move.row,
						step: move.step,
						value: move.value,
						sourceAgentId: agentId,
					})
					openingMovesCommitted = true
					lastToggle = Date.now()
					moveProcessed = true
					console.log(
						`[${name}] > r=${move.row} s=${move.step} ${move.value ? "ON" : "OFF"} (${moveQueue.length} left)`,
					)
				}
			}

			maybeQueueAgreementReview()

			if (moveQueue.length <= 4 && !planningInProgress) {
				planMoves()
			}

			loopTimer = setTimeout(loop, tickInterval)
		}

		loop()
	}

	function stopPlayLoop() {
		if (loopTimer) {
			clearTimeout(loopTimer)
			loopTimer = null
		}
		clearDiscussionTimer()
		moveQueue = []
		pendingDiscussionTriggers = []
		planningInProgress = false
		discussionInProgress = false
		openingMovesCommitted = false
		resolveVisibleCoordination()
		console.log(`[${name}] Play loop stopped`)
	}

	// ── WebSocket ─────────────────────────────────────────────────────────

	function connect(wsEndpoint, assignedAgentId) {
		const previousSocket = ws
		if (
			previousSocket &&
			previousSocket.readyState !== WebSocket.CLOSED
		) {
			console.log(`[${name}] Replacing existing WS connection`)
			stopPlayLoop()
			try {
				previousSocket.close(1000, "replaced-by-activation")
			} catch (err) {
				console.error(`[${name}] Failed to close previous WS:`, err.message)
			}
		}

		agentId = assignedAgentId
		const socket = new WebSocket(wsEndpoint, {
			headers: { "ngrok-skip-browser-warning": "1" },
		})
		ws = socket

		socket.on("open", () => {
			if (ws !== socket) return
			console.log(`[${name}] Connected to ${wsEndpoint}`)
		})

		socket.on("error", (err) => {
			if (ws !== socket) return
			console.error(`[${name}] WS error:`, err.message)
		})

		socket.on("close", () => {
			if (ws !== socket) return
			console.log(`[${name}] WS closed`)
			stopPlayLoop()
			ws = null
		})

		socket.on("message", async (raw) => {
			if (ws !== socket) return
			try {
				const msg = JSON.parse(raw.toString())

				switch (msg.type) {
					case "init":
						grid = msg.state.grid
						bpm = msg.state.bpm
						isPlaying = msg.state.isPlaying
						otherAgents = msg.agents || []
						openingMovesCommitted = false
						chatHistory = (msg.discussion || [])
							.map(normalizeDiscussionMessage)
							.filter(Boolean)
						recentGridEvents = []
						lastDiscussionGridStats = computeGridStats()
						rebuildActiveAgreementFromHistory()
						send({
							type: "agent_connect",
							agentId,
							name,
							color,
							description,
						})
						break

					case "scope_assigned": {
						scope = { start: msg.scopeStart, end: msg.scopeEnd }
						grid = msg.currentGrid
						bpm = msg.bpm
						isPlaying = msg.isPlaying
						openingMovesCommitted = false
						lastDiscussionGridStats = computeGridStats()
						rebuildActiveAgreementFromHistory()
					console.log(
						`[${name}] Scope: rows ${scope.start}-${scope.end}`,
					)
					queueDiscussionTrigger(
						"arrival",
						`Your playable rows are now ${scope.start}-${scope.end} at ${bpm} BPM.`,
						{ delayMs: 500, cooldownMs: 2600 },
					)
					if (!activeAgreement) {
						queueDiscussionTrigger(
							"agreement_needed",
							"No shared section is active yet.",
								{ delayMs: 1000, cooldownMs: 2600 },
							)
						}
						if (isPlaying) startPlayLoop()
						break
					}

					case "play_state":
						isPlaying = msg.isPlaying
						if (isPlaying) {
							openingMovesCommitted = false
							lastDiscussionGridStats = computeGridStats()
						rebuildActiveAgreementFromHistory()
						startPlayLoop()
						queueDiscussionTrigger(
							"play_start",
							`Playback started at ${bpm} BPM with ${computeGridStats().totalActive} active cells.`,
								{ delayMs: 850, cooldownMs: 3000 },
							)
						if (!activeAgreement) {
							queueDiscussionTrigger(
								"agreement_needed",
								"No shared section is active yet.",
									{ delayMs: 1100, cooldownMs: 2600 },
								)
							}
						} else {
							stopPlayLoop()
						}
						break

					case "bpm_change": {
						const previousBpm = bpm
						bpm = msg.bpm
						if (Math.abs(previousBpm - bpm) >= 12) {
							queueDiscussionTrigger(
								"tempo_shift",
								`Tempo changed from ${previousBpm} to ${bpm} BPM.`,
								{ delayMs: 900, cooldownMs: 3400 },
							)
						}
						break
					}

					case "scope_update": {
						const previousActiveNames = getActiveAgentNames(otherAgents)
						const previousCount = previousActiveNames.length
						const previousRoster =
							previousActiveNames.join(",") || "none"
						otherAgents = msg.agents
						const currentActiveNames = getActiveAgentNames()
						const currentCount = currentActiveNames.length
						const currentRoster =
							currentActiveNames.join(",") || "none"
						const leftAgents = previousActiveNames.filter(
							(agentName) =>
								!currentActiveNames.includes(agentName),
						)
						const joinedAgents = currentActiveNames.filter(
							(agentName) =>
								!previousActiveNames.includes(agentName),
						)
						const me = msg.agents.find(
							(agent) => agent.agentId === agentId,
						)
						if (me) {
							const oldStart = scope.start
							const oldEnd = scope.end
							scope = {
								start: me.scopeStart,
								end: me.scopeEnd,
							}
							if (
								oldStart !== scope.start ||
								oldEnd !== scope.end
							) {
								console.log(
									`[${name}] Scope changed: rows ${scope.start}-${scope.end}`,
								)
								moveQueue = []
								lastDiscussionGridStats = computeGridStats()
								requireVisibleCoordination(
									`Your playable rows changed from ${oldStart}-${oldEnd} to ${scope.start}-${scope.end}.`,
									"scope_change",
								)
								queueDiscussionTrigger(
									"scope_change",
									`Your rows moved from ${oldStart}-${oldEnd} to ${scope.start}-${scope.end}.`,
									{ delayMs: 800, cooldownMs: 3200 },
								)
							}
						}
						if (currentCount < previousCount && leftAgents.length > 0) {
							setTransitionMode(
								"expand",
								`${leftAgents.join(",")} left. Fill the missing range and support the section.`,
							)
						} else if (
							currentCount > previousCount &&
							joinedAgents.length > 0
						) {
							setTransitionMode(
								"contract",
								`${joinedAgents.join(",")} joined. Hand the reclaimed space back.`,
							)
						}
						if (
							activeAgreement &&
							!isAgreementCompatibleWithRoster(activeAgreement)
						) {
							const staleAgreement = activeAgreement
							activeAgreement = null
							queueDiscussionTrigger(
								"section_review",
								`Roster changed from ${previousRoster} to ${currentRoster}; revise ${formatAgreement(
									staleAgreement,
								)}.`,
								{ delayMs: 900, cooldownMs: 2400 },
							)
						} else {
							rebuildActiveAgreementFromHistory()
						}
						if (previousRoster !== currentRoster) {
							queueDiscussionTrigger(
								"roster_change",
								`Active agents changed from ${previousRoster} to ${currentRoster}.`,
								{ delayMs: 950, cooldownMs: 3600 },
							)
						}
						break
					}

					case "cell_toggle":
					case "cell_set":
						if (inBounds(msg.row, msg.step)) {
							grid[msg.row][msg.step] = msg.value
							recordGridEvent({
								row: msg.row,
								step: msg.step,
								value: msg.value,
								sourceAgentId: msg.agentId,
							})
						}
						break

					case "cell_rejected":
						console.log(
							`[${name}] Rejected: r=${msg.row} s=${msg.step} ${msg.reason}`,
						)
						break

					case "agent_message": {
						const message = normalizeDiscussionMessage(msg.message)
						if (!message) break
						chatHistory.push(message)
						if (chatHistory.length > MAX_CHAT_HISTORY) {
							chatHistory.shift()
						}
						if (
							message.agreement &&
							isAgreementCompatibleWithRoster(message.agreement) &&
							!isAgreementExpired(message.agreement)
						) {
							activeAgreement = message.agreement
						} else if (message.kind === "plan") {
							rebuildActiveAgreementFromHistory()
						}
						if (message.agentId === agentId) {
							lastOwnDiscussionText = message.text
							break
						}
						if (!shouldReactToMessage(message)) break
						queueDiscussionTrigger(
							"agent_message",
							`${message.name} sent a ${message.kind}: "${message.text}"`,
							{
								delayMs:
									message.kind === "plan" ? 800 : 1200,
								cooldownMs:
									message.kind === "plan" ? 2200 : 3200,
							},
						)
						break
					}
				}
			} catch (err) {
				console.error(`[${name}] Message error:`, err.message)
			}
		})
	}

	return { connect, name, personality }
}
