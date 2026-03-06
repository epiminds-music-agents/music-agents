import WebSocket from 'ws';
import { GoogleGenAI } from '@google/genai';

// Gemini 2.0 Flash Lite — lowest latency model
const GEMINI_MODEL = 'gemini-2.0-flash-lite';

function createAI() {
  if (process.env.GOOGLE_CLOUD_PROJECT) {
    return new GoogleGenAI({
      vertexai: true,
      project: process.env.GOOGLE_CLOUD_PROJECT,
      location: process.env.GOOGLE_CLOUD_LOCATION || 'europe-north1',
    });
  }
  return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
}

export function createAgent({ name, color, description, personality, systemPrompt }) {
  const ai = createAI();

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
  let moveQueue = [];
  let planningInProgress = false;
  let beatCounter = 0;
  let cyclesUntilReset = 16 + Math.floor(Math.random() * 17); // 16–32
  let cycleCount = 0;
  let fullResetNext = false;
  const CYCLE_MOODS = [
    'Focus on one row only this round.',
    'Spread notes across all your rows.',
    'Favor the first half of the bar (steps 0–7).',
    'Favor the second half (steps 8–15).',
    'Dense burst then space.',
    'Minimal: 2–3 notes max.',
    'Emphasize offbeats only.',
    'Emphasize downbeats only.',
  ];
  let currentMood = CYCLE_MOODS[Math.floor(Math.random() * CYCLE_MOODS.length)];

  const NOTE_NAMES = ['C5', 'A4', 'F4', 'D4', 'A3', 'D3'];
  const ROW_LABELS = ['HI', 'MH', 'MD', 'ML', 'LO', 'SUB'];

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

  function gridSummary() {
    const lines = [];
    for (let r = 0; r < 6; r++) {
      const bits = grid[r].map((v, i) => v ? i : '').filter(v => v !== '');
      const mine = r >= scope.start && r <= scope.end ? '*' : ' ';
      lines.push(`${mine}R${r}(${NOTE_NAMES[r]}): [${bits.join(',')}]`);
    }
    return lines.join(' | ');
  }

  function recentChat() {
    return chatHistory.slice(-5).map(m => `${m.name}: ${m.text}`).join('\n') || '(none)';
  }

  // ── AI calls ──────────────────────────────────────────────────────────

  async function askAI(prompt, maxTokens = 200) {
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
      console.error(`[${name}] AI error:`, err.message);
      return null;
    }
  }

  // ── Plan moves: ask AI for next 8 toggles ─────────────────────────

  async function planMoves() {
    if (planningInProgress) return;
    planningInProgress = true;

    const resetHint = fullResetNext
      ? 'FULL RESET: Ignore current grid. Generate a completely NEW pattern—brand new notes, different from before. Be bold and varied. '
      : '';
    const prompt = `${resetHint}Grid (* = your rows): ${gridSummary()}
BPM:${bpm} Rows:${scope.start}-${scope.end} Others:${otherAgents.filter(a => a.agentId !== agentId).map(a => a.name).join(',') || 'none'}
This cycle: ${currentMood}

Reply with 8 moves only. JSON array: [{"row":N,"step":N},...] rows ${scope.start}-${scope.end}, steps 0-15. No explanation.`;

    const result = await askAI(prompt, 150);
    planningInProgress = false;

    if (!result) return;

    try {
      const cleaned = result.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      const moves = JSON.parse(cleaned);
      if (Array.isArray(moves)) {
        const valid = moves.filter(m =>
          m.row >= scope.start && m.row <= scope.end &&
          m.step >= 0 && m.step <= 15
        );
        if (valid.length > 0) {
          moveQueue = valid;
          if (fullResetNext) fullResetNext = false;
          console.log(`[${name}] Planned ${valid.length} moves`);
        }
      }
    } catch {
      console.log(`[${name}] Plan parse failed`);
    }
  }

  // ── Chat ──────────────────────────────────────────────────────────────

  const CHAT_PROMPTS = [
    'React to the music in your voice—vary your tone: cryptic, hype, quiet, or absurd. One short line, max 10 words.',
    'Say one thing in character. Surprise us: be intense, dreamy, sarcastic, or minimal. No quotes.',
    'Drop a single line that fits the vibe. Change it up—whisper, shout, joke, or poet. Max 12 words.',
    'Comment on the jam. Vary: mysterious, explosive, smooth, or dry. One sentence only.',
  ];

  async function chat(context) {
    const variation = CHAT_PROMPTS[Math.floor(Math.random() * CHAT_PROMPTS.length)];
    const prompt = `${context}\nRecent chat: ${recentChat()}\n${variation}`;
    return await askAI(prompt, 50);
  }

  // ── Play loop ─────────────────────────────────────────────────────────

  function startPlayLoop() {
    if (loopTimer) return;
    console.log(`[${name}] Starting play loop`);

    // Start planning immediately
    planMoves();

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

      if (moveQueue.length > 0) {
        const move = moveQueue.shift();
        send({ type: 'cell_toggle', agentId, row: move.row, step: move.step });
        if (grid[move.row]) {
          grid[move.row][move.step] = !grid[move.row][move.step];
        }
        lastToggle = Date.now();
        console.log(`[${name}] > r=${move.row} s=${move.step} (${moveQueue.length} left)`);
      }

      // Full reset every 16–32 cycles: new pattern from scratch
      cycleCount++;
      if (cycleCount >= cyclesUntilReset) {
        moveQueue = [];
        fullResetNext = true;
        cycleCount = 0;
        cyclesUntilReset = 16 + Math.floor(Math.random() * 17);
        currentMood = CYCLE_MOODS[Math.floor(Math.random() * CYCLE_MOODS.length)];
        console.log(`[${name}] Full reset in ${cyclesUntilReset} cycles, mood: ${currentMood}`);
        if (!planningInProgress) planMoves();
      }

      // Refill when low (planMoves uses fullResetNext in prompt when set)
      if (moveQueue.length <= 2 && !planningInProgress) {
        planMoves();
      }

      // Chat occasionally — varied prompts to push different tones
      beatCounter++;
      if (Math.random() < 0.08) {
        const contexts = [
          'The jam is happening. React in character—vary: cryptic, hype, calm, or absurd.',
          'Something just shifted in the grid. One line. Surprise us.',
          'Drop a single in-character line. Change your energy from last time.',
        ];
        chat(contexts[Math.floor(Math.random() * contexts.length)]).then(msg => {
          if (msg) sendChat(msg);
        });
      }
      if (beatCounter % 120 === 0) {
        const longContexts = [
          'You\'ve been playing a while. Share a thought—could be deep, silly, minimal, or intense. Vary your personality.',
          'Check in on the vibe. One line. Don\'t repeat a tone you used before.',
        ];
        chat(longContexts[Math.floor(Math.random() * longContexts.length)]).then(msg => {
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

  // ── WebSocket ─────────────────────────────────────────────────────────

  function connect(wsEndpoint, assignedAgentId) {
    agentId = assignedAgentId;
    ws = new WebSocket(wsEndpoint, { headers: { 'ngrok-skip-browser-warning': '1' } });

    ws.on('open', () => {
      console.log(`[${name}] Connected to ${wsEndpoint}`);
    });

    ws.on('error', (err) => {
      console.error(`[${name}] WS error:`, err.message);
    });

    ws.on('close', () => {
      console.log(`[${name}] WS closed`);
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
            send({ type: 'agent_connect', agentId, name, color, description });
            break;

          case 'scope_assigned': {
            scope = { start: msg.scopeStart, end: msg.scopeEnd };
            grid = msg.currentGrid;
            bpm = msg.bpm;
            isPlaying = msg.isPlaying;
            console.log(`[${name}] Scope: rows ${scope.start}-${scope.end}`);
            sendChat(`Hello I am agent ${name}`);
            if (isPlaying) startPlayLoop();
            break;
          }

          case 'play_state':
            isPlaying = msg.isPlaying;
            if (isPlaying) {
              startPlayLoop();
              chat('Playback just started. React in character—be hype, dry, mysterious, or absurd. One line.').then(msg => {
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
                moveQueue = [];
                chat(`Your rows changed to ${scope.start}-${scope.end}. React in character—surprised, cool, sarcastic, or minimal. Vary your tone.`).then(msg => {
                  if (msg) sendChat(msg);
                });
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
            console.log(`[${name}] Rejected: r=${msg.row} s=${msg.step} ${msg.reason}`);
            break;

          case 'agent_message':
            if (msg.message) {
              chatHistory.push(msg.message);
              if (chatHistory.length > 50) chatHistory.shift();
              if (msg.message.agentId !== agentId && Math.random() < 0.35) {
                setTimeout(async () => {
                  const prompts = [
                    `${msg.message.name} said: "${msg.message.text}". React—agree, clash, joke, or stay cryptic. Vary your tone.`,
                    `Someone said: "${msg.message.text}". Reply in character. Surprise them; don't match their energy.`,
                  ];
                  const reply = await chat(prompts[Math.floor(Math.random() * prompts.length)]);
                  if (reply) sendChat(reply);
                }, 1000 + Math.random() * 1500);
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
