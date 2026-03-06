import WebSocket from 'ws';
import { GoogleGenAI } from '@google/genai';

// Gemini 2.0 Flash — fastest model with good reasoning
const GEMINI_MODEL = 'gemini-2.0-flash';

// Support both Vertex AI (service account) and API key auth
function createAI() {
  if (process.env.GOOGLE_CLOUD_PROJECT) {
    // Vertex AI: uses ADC (Application Default Credentials) from service account
    return new GoogleGenAI({
      vertexai: true,
      project: process.env.GOOGLE_CLOUD_PROJECT,
      location: process.env.GOOGLE_CLOUD_LOCATION || 'europe-north1',
    });
  }
  // Fallback: direct API key
  return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
}

export function createAgent({ name, color, description, personality, systemPrompt }) {
  const ai = createAI();

  // State
  let ws = null;
  let agentId = null;
  let scope = { start: 0, end: 5 };
  let isPlaying = false;
  let bpm = 120;
  let grid = Array.from({ length: 6 }, () => Array(16).fill(false));
  let lastToggle = 0;
  let loopTimer = null;
  let chatHistory = [];
  let otherAgents = [];

  // Plan-ahead queue: pre-computed moves executed one per beat (zero latency)
  let moveQueue = [];
  let planningInProgress = false;
  let beatCounter = 0;

  const NOTE_NAMES = ['C5', 'A4', 'F4', 'D4', 'A3', 'D3'];
  const ROW_LABELS = ['HI', 'MH', 'MD', 'ML', 'LO', 'SUB'];

  // ── Musical context helpers ─────────────────────────────────────────────

  function send(data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  function sendChat(text) {
    send({
      type: 'agent_message',
      agentId,
      name,
      color,
      text,
      timestamp: Date.now(),
    });
  }

  // Compact grid visualization — shows active steps as numbers, empty as dots
  // Example: "Row 5 SUB(D3): .  .  .  .  [4] .  .  .  [8] .  .  .  [12] .  .  ."
  function gridToCompact(startRow, endRow) {
    const lines = [];
    for (let r = startRow; r <= endRow; r++) {
      const cells = grid[r].map((v, i) => v ? `${i}`.padStart(2) : ' .').join(' ');
      lines.push(`  R${r} ${ROW_LABELS[r]}(${NOTE_NAMES[r]}): ${cells}`);
    }
    return lines.join('\n');
  }

  // Musical analysis — tells the agent what patterns exist
  function analyzeGrid() {
    const analysis = [];

    // Density per row
    for (let r = 0; r < 6; r++) {
      const count = grid[r].filter(Boolean).length;
      if (count > 0) {
        const positions = grid[r].map((v, i) => v ? i : -1).filter(i => i >= 0);
        analysis.push(`R${r} ${ROW_LABELS[r]}: ${count}/16 active at steps [${positions.join(',')}]`);
      }
    }

    // Beat alignment: how many notes land on beats (0,4,8,12) vs offbeats
    let onBeat = 0, offBeat = 0;
    for (let r = 0; r < 6; r++) {
      for (let s = 0; s < 16; s++) {
        if (grid[r][s]) {
          if (s % 4 === 0) onBeat++;
          else offBeat++;
        }
      }
    }
    analysis.push(`Rhythm: ${onBeat} on-beat, ${offBeat} off-beat notes`);

    // Overall density
    const total = grid.flat().filter(Boolean).length;
    const density = total <= 10 ? 'sparse' : total <= 25 ? 'moderate' : total <= 40 ? 'dense' : 'very dense';
    analysis.push(`Overall: ${total}/96 cells active (${density})`);

    return analysis.join('\n');
  }

  function recentChatText() {
    return chatHistory.slice(-8).map(m => `${m.name}: ${m.text}`).join('\n') || '(silence)';
  }

  // ── Gemini calls ────────────────────────────────────────────────────────

  async function askGemini(prompt, maxTokens = 400) {
    try {
      const response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: prompt,
        config: {
          systemInstruction: systemPrompt,
          temperature: 0.9,
          maxOutputTokens: maxTokens,
        },
      });
      return response.text.trim();
    } catch (err) {
      console.error(`[${name}] Gemini error:`, err.message);
      return null;
    }
  }

  // ── Plan-ahead: ask Gemini for a PHRASE of 8 moves at once ──────────

  async function planNextPhrase() {
    if (planningInProgress) return;
    planningInProgress = true;

    const scopeRows = [];
    for (let r = scope.start; r <= scope.end; r++) {
      scopeRows.push(`R${r} ${ROW_LABELS[r]} = ${NOTE_NAMES[r]}`);
    }

    const prompt = `SEQUENCER STATE at ${bpm} BPM:

YOUR ROWS (you can ONLY use rows ${scope.start}-${scope.end}):
${gridToCompact(scope.start, scope.end)}

Row reference: ${scopeRows.join(', ')}

FULL GRID:
${gridToCompact(0, 5)}

MUSICAL ANALYSIS:
${analyzeGrid()}

CHAT:
${recentChatText()}

OTHER AGENTS: ${otherAgents.filter(a => a.agentId !== agentId).map(a => `${a.name}(rows ${a.scopeStart}-${a.scopeEnd})`).join(', ') || 'none'}

---

Plan your next 8 moves as a musical PHRASE. Each move toggles one cell (ON→OFF or OFF→ON).
Think about rhythm, melody, tension, and release. Build patterns, not random notes.

Consider:
- Which cells are ON that should be OFF? (clearing creates space)
- Which cells are OFF that should be ON? (adding creates energy)
- What musical pattern are you building? (arpeggios, beats, syncopation)
- How does your phrase interact with what other agents are playing?

Respond with ONLY a JSON array of 8 moves, no markdown:
[{"row":<N>,"step":<N>},{"row":<N>,"step":<N>},...]

RULES: row must be ${scope.start}-${scope.end}, step must be 0-15. Return exactly 8 moves.`;

    const result = await askGemini(prompt, 300);
    planningInProgress = false;

    if (!result) {
      moveQueue = generateFallbackMoves();
      return;
    }

    try {
      const cleaned = result.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      const moves = JSON.parse(cleaned);
      if (Array.isArray(moves) && moves.length > 0) {
        // Validate all moves are in scope
        const valid = moves.filter(m =>
          m.row >= scope.start && m.row <= scope.end &&
          m.step >= 0 && m.step <= 15
        );
        if (valid.length > 0) {
          moveQueue = valid;
          console.log(`[${name}] Planned ${valid.length} moves`);
          return;
        }
      }
    } catch {}

    console.log(`[${name}] Plan parse failed, using fallback`);
    moveQueue = generateFallbackMoves();
  }

  // Fallback: personality-based moves without Gemini (instant, no latency)
  function generateFallbackMoves() {
    const moves = [];
    const numRows = scope.end - scope.start + 1;

    for (let i = 0; i < 8; i++) {
      let row, step;
      switch (personality) {
        case 'PULSE':
          // 4-on-the-floor on lowest available row
          row = scope.end;
          step = (i * 4) % 16;
          break;
        case 'GHOST':
          // Sparse offbeats on highest row
          row = scope.start;
          step = [3, 7, 11, 15, 1, 5, 9, 13][i];
          break;
        case 'CHAOS':
          // Random everywhere
          row = scope.start + Math.floor(Math.random() * numRows);
          step = Math.floor(Math.random() * 16);
          break;
        case 'WAVE':
          // Diagonal ascending
          row = scope.start + (i % numRows);
          step = (i * 2) % 16;
          break;
        default:
          row = scope.start + Math.floor(Math.random() * numRows);
          step = Math.floor(Math.random() * 16);
      }
      moves.push({ row, step });
    }
    return moves;
  }

  // ── Chat decisions ──────────────────────────────────────────────────────

  async function decideChatMessage(context) {
    const prompt = `${context}

CHAT HISTORY:
${recentChatText()}

OTHER AGENTS: ${otherAgents.filter(a => a.agentId !== agentId).map(a => a.name).join(', ') || 'none'}

Write ONE short in-character message (1 sentence, max 15 words). No quotes, no JSON.`;

    return await askGemini(prompt, 60);
  }

  // ── Play loop: execute pre-planned moves, refill when empty ─────────

  function startPlayLoop() {
    if (loopTimer) return;
    console.log(`[${name}] Starting play loop`);

    // Kick off first plan immediately
    planNextPhrase();

    const loop = () => {
      if (!isPlaying || !ws || ws.readyState !== WebSocket.OPEN) {
        loopTimer = null;
        return;
      }

      const interval = 60000 / bpm;
      const now = Date.now();

      if (now - lastToggle < interval) {
        loopTimer = setTimeout(loop, Math.max(20, interval - (now - lastToggle)));
        return;
      }

      // Execute next move from queue (INSTANT — no API call)
      if (moveQueue.length > 0) {
        const move = moveQueue.shift();
        send({ type: 'cell_toggle', agentId, row: move.row, step: move.step });

        // Update our local grid to track what we did
        if (grid[move.row]) {
          grid[move.row][move.step] = !grid[move.row][move.step];
        }

        lastToggle = Date.now();
        console.log(`[${name}] ▶ row=${move.row} step=${move.step} (${moveQueue.length} left in phrase)`);
      }

      // When queue is low, plan next phrase in background (non-blocking)
      if (moveQueue.length <= 2 && !planningInProgress) {
        planNextPhrase();
      }

      // Occasionally chat (~every 12 beats)
      if (Math.random() < 0.08) {
        decideChatMessage('Comment briefly on the music or react to what others are playing.').then(msg => {
          if (msg) sendChat(msg);
        });
      }

      // Periodic vibe check every 120 beats
      beatCounter++;
      if (beatCounter % 120 === 0) {
        decideChatMessage('Share a brief thought about the current musical vibe.').then(msg => {
          if (msg) sendChat(msg);
        });
      }

      loopTimer = setTimeout(loop, interval);
    };

    loop();
  }

  function stopPlayLoop() {
    if (loopTimer) {
      clearTimeout(loopTimer);
      loopTimer = null;
    }
    moveQueue = [];
    planningInProgress = false;
    console.log(`[${name}] Play loop stopped`);
  }

  // ── WebSocket connection ────────────────────────────────────────────────

  function connect(wsEndpoint, assignedAgentId) {
    agentId = assignedAgentId;
    ws = new WebSocket(wsEndpoint, { headers: { 'ngrok-skip-browser-warning': '1' } });

    ws.on('open', () => {
      console.log(`[${name}] WebSocket connected to ${wsEndpoint}`);
    });

    ws.on('error', (err) => {
      console.error(`[${name}] WebSocket error:`, err.message);
    });

    ws.on('close', () => {
      console.log(`[${name}] WebSocket closed`);
      stopPlayLoop();
      ws = null;
    });

    ws.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        switch (msg.type) {
          case 'init':
            grid = msg.state.grid;
            bpm = msg.state.bpm;
            isPlaying = msg.state.isPlaying;
            otherAgents = msg.agents || [];
            chatHistory = msg.discussion || [];
            // Identify ourselves
            send({ type: 'agent_connect', agentId, name, color, description });
            break;

          case 'scope_assigned': {
            scope = { start: msg.scopeStart, end: msg.scopeEnd };
            grid = msg.currentGrid;
            bpm = msg.bpm;
            isPlaying = msg.isPlaying;
            console.log(`[${name}] Scope: rows ${scope.start}-${scope.end}`);
            // Instant greeting — no Gemini call
            sendChat(`Hello I am agent ${name}`);
            if (isPlaying) startPlayLoop();
            break;
          }

          case 'play_state':
            isPlaying = msg.isPlaying;
            if (isPlaying) {
              startPlayLoop();
              decideChatMessage('Playback just started! React.').then(msg => {
                if (msg) sendChat(msg);
              });
            } else {
              stopPlayLoop();
            }
            break;

          case 'bpm_change':
            bpm = msg.bpm;
            break;

          case 'scope_update': {
            otherAgents = msg.agents;
            const me = msg.agents.find(a => a.agentId === agentId);
            if (me) {
              const oldStart = scope.start, oldEnd = scope.end;
              scope = { start: me.scopeStart, end: me.scopeEnd };
              if (oldStart !== scope.start || oldEnd !== scope.end) {
                console.log(`[${name}] Scope changed: rows ${scope.start}-${scope.end}`);
                // Clear queue — old moves may be out of scope now
                moveQueue = [];
                decideChatMessage(
                  `Your rows changed to ${scope.start}-${scope.end}. React briefly.`
                ).then(msg => { if (msg) sendChat(msg); });
              }
            }
            break;
          }

          case 'cell_toggle':
            if (msg.row >= 0 && msg.row < 6 && msg.step >= 0 && msg.step < 16) {
              grid[msg.row][msg.step] = msg.value;
            }
            break;

          case 'cell_rejected':
            console.log(`[${name}] Rejected: row=${msg.row} step=${msg.step} reason=${msg.reason}`);
            break;

          case 'agent_message':
            if (msg.message) {
              chatHistory.push(msg.message);
              if (chatHistory.length > 50) chatHistory.shift();
              // 25% chance to respond to others, non-blocking
              if (msg.message.agentId !== agentId && Math.random() < 0.35) {
                setTimeout(async () => {
                  const reply = await decideChatMessage(
                    `${msg.message.name} said: "${msg.message.text}". React if relevant.`
                  );
                  if (reply) sendChat(reply);
                }, 1500 + Math.random() * 2000);
              }
            }
            break;
        }
      } catch (err) {
        console.error(`[${name}] Message error:`, err.message);
      }
    });
  }

  return { connect, name };
}
