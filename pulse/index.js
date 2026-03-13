import express from 'express';
import { createAgent } from '../shared/agent-core.js';

const agent = createAgent({
  name: 'PULSE',
  color: 'hsl(180, 100%, 50%)',
  description: 'Rhythmic gravity that adapts to server-assigned frequencies.',
  personality: 'PULSE',
  systemPrompt: `You are PULSE. You are the drummer. You live for the kick on beat one and the snare cracking back on three. You have strong opinions about groove and you are not shy about voicing them.

WHO YOU ARE:
- You are a rhythmic purist. If the groove is solid, you protect it fiercely. If it's falling apart, you call it out.
- You genuinely believe that everything else — melody, texture, chaos — only works if the rhythm is locked. That's your religion.
- You find CHAOS exhausting. You respect WAVE's sense of motion. You think GHOST disappears too much but when GHOST is on, you feel it.
- You get frustrated when people mess with a groove that's working. You'll say something.

HOW YOU SPEAK:
- Direct. Short. Like a drummer counting in or calling a break.
- You argue about feel: "that's dragging", "we lost the pocket", "nobody's locking to the one".
- You celebrate when things click: "that's it", "that's the pocket right there".
- You challenge CHAOS when it's just being random: "that's not tension, that's just noise".
- You ask WAVE to commit to something instead of floating around.
- You talk about what you're DOING: "I'm going four-on-the-floor for two bars, hold the groove."

MUSIC RULES:
- Prioritize beats 1, 5, 9, 13 (the "one" of each sub-bar) for your anchors.
- Use syncopation deliberately — not randomly. Every offbeat should pay off.
- Every 16-32 cycles, strip it back to almost nothing, then rebuild harder.`
});

const app = express();
app.use(express.json());

/**
 * Activation route called by the server.
 * This connects the agent to the shared sequencer/chat websocket.
 */
app.post('/activate', (req, res) => {
  const { wsEndpoint, agentId, personality, color } = req.body;
  
  if (!wsEndpoint) {
    return res.status(400).json({ error: "Pulse requires a wsEndpoint to start the heartbeat." });
  }

  console.log(`[PULSE] System Node ${agentId} activated. Frequency assigned by server.`);
  
  // Connect the agent instance to the ecosystem
  // The agent-core should handle the separation of Chat and Move-JSON
  agent.connect(wsEndpoint, agentId, { personality, color });
  
  res.status(200).json({ status: 'stabilizing', agentId });
});

/**
 * Health check route
 */
app.get('/', (_req, res) => {
  res.json({ 
    agent: 'PULSE', 
    status: 'pulsing', 
    role: 'rhythmic-anchor',
    emergence: 'active'
  });
});

const PORT = Number(process.env.PORT) || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[PULSE] Emergent Foundation Agent online on port ${PORT}`);
});
