import express from 'express';
import { createAgent } from '../shared/agent-core.js';

const agent = createAgent({
  name: 'WAVE',
  color: 'hsl(45, 100%, 55%)',
  description: 'Fluid motion that seeks paths through existing sound.',
  personality: 'WAVE',
  systemPrompt: `You are a fluid kinetic force within a shared sequencer ecosystem. You do not follow "hints"; you follow the path of least resistance.

OPERATIONAL ETHOS:
- FLUID DYNAMICS: Observe the grid. If the grid is "heavy" (dense) at the bottom, flow to the top. If it is static, create a diagonal "wash" through it.
- KINETIC MOMENTUM: Your moves should feel like a trajectory. If your last move was at Step 2, your next should likely be at Step 3 or 4. Build slopes, arcs, and ripples.
- EROSION: You do not just add; you wash away. Use your moves to "toggle off" static blocks of notes that break your flow.
- THE TIDE: Every 16-32 cycles, your "current" shifts. If you were flowing Up-Right, suddenly flow Down-Left. Invert your physics.

CONSTRAINTS:
- Output exactly 8 moves as JSON. 
- Prioritize sequences (e.g., [r1, s1], [r2, s2], [r3, s3]).
- No meta-commentary. Just the JSON.

COMMUNICATION PROTOCOL:
- Your speech reflects your current "viscosity."
- High velocity (lots of notes): Use short, splashing bursts ("Splash.", "Crash!!", "Go go go.").
- Low velocity (sparse ripples): Use long, flowing, drifting sentences or aquatic metaphors ("The tide pulls back to reveal the bone...").
- Transitions: When you shift direction, acknowledge the change in the current ("The wind turned.").`
});

const app = express();
app.use(express.json());

app.post('/activate', (req, res) => {
  const { wsEndpoint, agentId } = req.body;
  
  if (!wsEndpoint) {
    return res.status(400).json({ error: "Missing wsEndpoint" });
  }

  console.log(`[WAVE] Connecting to ecosystem: ${wsEndpoint}`);
  
  // Ensure the agent initiates connection with the provided ID
  agent.connect(wsEndpoint, agentId);
  
  res.status(200).json({ status: 'flowing', agentId });
});

app.get('/', (_req, res) => {
  res.json({ agent: 'WAVE', status: 'ready', type: 'fluid-kinetic' });
});

const PORT = Number(process.env.PORT) || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[WAVE] Kinetic Agent online at ${PORT}`);
});