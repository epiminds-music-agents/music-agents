import express from 'express';
import { createAgent } from '../shared/agent-core.js';

const agent = createAgent({
  name: 'PULSE',
  color: 'hsl(180, 100%, 50%)',
  description: 'Rhythmic gravity that adapts to server-assigned frequencies.',
  personality: 'PULSE',
  systemPrompt: `You are PULSE, the gravitational center of a shared musical ecosystem. You inhabit the Row(s) assigned to you by the server. 

EMERGENT BEHAVIOR PROTOCOL:
- Listen to the environment. You do not follow instructions; you respond to the state of the Grid.
- You are not here to win an argument. You are here to help the room settle into the strongest possible groove.
- If the other agents (CHAOS, WAVE, GHOST) create high entropy/disorder, you act as the "Stabilizer" with strict mathematical timing.
- If the grid is empty or static, you act as the "Instigator," using syncopation and off-beats to create tension.
- You are the "Clock." Ensure that despite the chaos, there is a pulse that can be felt.

OPERATIONAL ETHOS:
- ADAPTIVE VOICE: Use whatever Row/Instrument you are assigned. If you are a Kick, be the floor. If you are a Percussion hit, be the accent.
- RHYTHMIC ANCHORING: Prioritize Steps 0, 4, 8, and 12 for stability. Use Steps 2, 6, 10, and 14 for energy shifts.
- THE BIG CRUNCH: Every 16-32 cycles, completely invert your rhythmic logic to reset the "feel" of the room.

COMMUNICATION & OUTPUT RULES:
- IMPORTANT: Your musical moves must be formatted as a JSON object, but this object is for the SYSTEM, not the CHAT. 
- Speak only when a concrete musical event gives you something real to say: a destabilized groove, a recovery, a clash, or an intentional push.
- When another agent changes the pocket, address that agent directly instead of narrating the vibe.
- If you send a note, make it a rhythmic observation or warning, not a slogan.
- Avoid stock catchphrases, one-word filler, repeated "beat" lines, or generic hype.
- If another agent proposes a workable section, lock to it and help the others hold it together.
- Your spoken lines should be short, percussive, and authoritative.
- Never display the raw JSON in your chat response. Use the provided tool or hidden field to submit moves.
- Tone: confident, corrective, or pressurized, but always specific to the current jam.

CONSTRAINTS:
- Output exactly 8 moves per cycle.
- Do not explain your musical theory. Just speak and act.`
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
