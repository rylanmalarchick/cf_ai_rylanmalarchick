# PROMPTS.md — AI Prompts Used in Development

This document records the AI prompts and interactions used during the development of PulseLab, as required by the Cloudflare assignment instructions.

## Development Environment

- **AI Tool**: Claude (Anthropic), used via the [pi coding agent](https://github.com/mariozechner/pi-coding-agent)
- **Model**: Claude Opus 4.6
- **Usage**: Architecture planning, code generation, debugging, documentation

## Prompts

### 1. Architecture and Planning

**Prompt (paraphrased):**
> I need to build a Cloudflare AI application for an internship assignment. Requirements: LLM (Llama 3.3 on Workers AI), Workflow/coordination (Workers or Durable Objects), user input via chat, memory/state. The repo must be prefixed cf_ai_ and include README.md and PROMPTS.md. I want to build something based on my quantum computing research rather than a generic chatbot.

**Outcome:** We decided on PulseLab, a quantum pulse calibration advisor that turns the findings from my published paper (arXiv:2511.12799) into an interactive tool. The key architectural decision was separating physics computations (pure functions) from LLM explanation (Workers AI), so the agent computes real error budgets rather than hallucinating numbers.

### 2. Physics Module

**Prompt (paraphrased):**
> Build the physics computation module. It needs to compute decoherence floors from T1/T2/gate time, estimate DRAG coherent error scaling from the paper's data, compute the DRAG beta parameter, and classify the optimization regime. All pure functions, no LLM calls.

**Outcome:** `src/physics.ts` with functions for `computeDecoherenceFloor`, `estimateDragCoherentError`, `computeErrorBudget`, and `estimateRobustness`. The scaling laws are empirical fits to the paper's numerical data (Table I and Table III).

### 3. Agent Implementation

**Prompt (paraphrased):**
> Implement the Cloudflare Agent using the agents SDK. It should handle WebSocket connections for real-time chat, call Workers AI with tool definitions so the LLM can invoke the physics functions, and persist hardware configurations to the Durable Object's built-in SQLite.

**Outcome:** `src/index.ts` with the `PulseLabAgent` class extending `Agent`. The tool-calling flow: user sends message, LLM decides whether to call a tool, agent executes the tool (physics computation), feeds the result back to the LLM for explanation.

### 4. Chat UI

**Prompt (paraphrased):**
> Build a clean chat UI as a single HTML file. Dark theme. Include hardware preset buttons in a sidebar (IQM Garnet, IBM Eagle, etc.) and example questions. WebSocket connection to the agent. No framework dependencies; vanilla HTML/CSS/JS.

**Outcome:** `public/index.html` with a responsive chat interface, hardware presets, and example prompts.

### 5. System Prompt Engineering

**Prompt (paraphrased):**
> Write the system prompt for the LLM. It should contain the key findings from arXiv:2511.12799 distilled into actionable guidance. The LLM should use tools for computation and explain results, not guess at numbers. Be direct and technically precise.

**Outcome:** `src/prompt.ts` with the system prompt and tool definitions. The prompt emphasizes using tools for computation and includes the five key findings from the paper.

### 6. Documentation

**Prompt (paraphrased):**
> Write the README with architecture diagram, setup instructions, and project structure. Keep it technical and direct.

**Outcome:** `README.md` with architecture diagram, running instructions, and physics documentation.

## What I wrote vs. what AI generated

- **Research content (my work):** The paper (arXiv:2511.12799), the physics formulas, the key findings, the calibration guidelines, and the decision about what to build
- **AI-assisted:** Code structure, TypeScript implementation, CSS styling, wrangler configuration, documentation formatting
- **Reviewed and edited by me:** Everything. AI-generated code was reviewed for correctness, especially the physics module where getting the formulas right matters.

## Notes

AI-assisted coding was explicitly encouraged by the assignment instructions. The domain expertise (quantum pulse optimization, transmon physics, error budget analysis) comes from my own published research. The AI helped translate that knowledge into a Cloudflare Workers application.
