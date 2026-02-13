# PulseLab: Quantum Pulse Calibration Advisor

A Cloudflare Agent that helps quantum hardware engineers decide between pulse optimization methods (Gaussian, DRAG, GRAPE) for transmon single-qubit gates. Based on the systematic comparison published in [arXiv:2511.12799](https://arxiv.org/abs/2511.12799).

## What it does

PulseLab answers a specific question that experimentalists face during gate calibration: **when does numerical pulse optimization (GRAPE) actually provide meaningful advantage over properly calibrated analytical methods (DRAG)?**

The agent combines:
- **Real physics computations** (error budget decomposition, decoherence floor estimates, robustness analysis) using formulas derived from the paper
- **LLM-powered explanation** (Llama 3.3 70B on Workers AI) that interprets the computed results and provides calibration guidance
- **Persistent memory** (Durable Objects with SQLite) that stores hardware configurations across sessions

This is not an LLM wrapper. The physics functions compute actual error budgets; the LLM explains them.

## Key findings from the research

1. **Properly calibrated DRAG is often sufficient.** At 20ns gate time with typical transmon parameters, DRAG operates within 1.2x of the decoherence floor. GRAPE eliminates all coherent error to machine precision, but the practical improvement is marginal when decoherence dominates.

2. **DRAG is more robust to detuning than GRAPE.** Over +/-5 MHz frequency detuning, DRAG maintains minimum fidelity 0.990 while GRAPE drops to 0.931. GRAPE's richer spectral content makes it more sensitive to frequency shifts.

3. **GRAPE is necessary at short gate times (< ~15 ns).** Below 15ns, DRAG's first-order perturbative correction fails and only numerical optimization can suppress higher-order leakage.

4. **T2 dephasing dominates the error budget.** For any pulse that has solved the coherent error problem, improving T2 has more impact than better pulse optimization.

## Architecture

| Component | Cloudflare Primitive | Purpose |
|-----------|---------------------|---------|
| LLM | Workers AI (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`) | Conversational understanding and result explanation |
| Agent | Agents SDK + Durable Object (`PulseLabAgent`) | Session state, tool execution, WebSocket handling |
| Memory | Durable Object SQLite (`this.sql`) | Persistent hardware configuration storage |
| UI | Static HTML served via Workers Assets | Chat interface with hardware presets |

```
┌───────────────────────────────────────────┐
│  Browser (Chat UI)                        │
│  - WebSocket connection                   │
│  - Hardware preset buttons                │
└──────────────┬────────────────────────────┘
               │ WebSocket
┌──────────────▼────────────────────────────┐
│  Worker (fetch handler)                   │
│  - Routes /ws to Durable Object           │
│  - Serves /api/error-budget (REST)        │
└──────────────┬────────────────────────────┘
               │
┌──────────────▼────────────────────────────┐
│  PulseLabAgent (Durable Object)           │
│  ┌─────────────┐  ┌────────────────────┐  │
│  │ Chat history │  │ Saved HW configs   │  │
│  │ (state)      │  │ (SQLite)           │  │
│  └──────┬──────┘  └────────────────────┘  │
│         │                                  │
│  ┌──────▼──────────────────────────────┐  │
│  │ Tool execution layer               │  │
│  │  - compute_error_budget (physics)   │  │
│  │  - estimate_robustness  (physics)   │  │
│  │  - save_config / list_configs (DB)  │  │
│  └──────┬──────────────────────────────┘  │
│         │                                  │
│  ┌──────▼──────────────────────────────┐  │
│  │ Workers AI (Llama 3.3 70B)         │  │
│  │  - System prompt with paper context │  │
│  │  - Tool-calling for computations    │  │
│  │  - Natural language explanations    │  │
│  └─────────────────────────────────────┘  │
└────────────────────────────────────────────┘
```

## Running locally

### Prerequisites
- Node.js >= 18
- A Cloudflare account (free tier works)
- Wrangler CLI (`npm install -g wrangler`)

### Setup

```bash
# Clone the repository
git clone https://github.com/rylanmalarchick/cf_ai_rylanmalarchick.git
cd cf_ai_rylanmalarchick

# Install dependencies
npm install

# Log in to Cloudflare (needed for Workers AI access)
npx wrangler login

# Run local dev server
npm run dev
```

The app will be available at `http://localhost:8787`.

**Note:** Workers AI requires a Cloudflare account even in local dev mode, because model inference runs on Cloudflare's infrastructure. The free tier includes Workers AI usage.

### Deploy to production

```bash
npm run deploy
```

This deploys to your Cloudflare Workers subdomain (e.g., `cf-ai-pulse-lab.<your-subdomain>.workers.dev`).

## REST API

You can also compute error budgets directly without the chat interface:

```bash
curl -X POST https://your-worker.workers.dev/api/error-budget \
  -H "Content-Type: application/json" \
  -d '{
    "alpha_mhz": -200,
    "t1_us": 37,
    "t2_us": 9.6,
    "gate_time_ns": 20
  }'
```

Returns a JSON error budget with decoherence floor breakdown, estimated infidelities for all three methods, regime classification, and a calibration recommendation.

## Project structure

```
cf_ai_rylanmalarchick/
├── src/
│   ├── index.ts      # Worker entrypoint + PulseLabAgent class
│   ├── physics.ts    # Error budget computations (pure functions, no LLM)
│   └── prompt.ts     # System prompt and tool definitions
├── public/
│   └── index.html    # Chat UI (vanilla HTML/CSS/JS)
├── wrangler.toml     # Cloudflare configuration
├── package.json
├── tsconfig.json
├── README.md
├── PROMPTS.md         # AI prompts used during development
└── .gitignore
```

## The physics

All computations in `src/physics.ts` are derived from the error budget analysis in the paper:

- **Decoherence floor**: `epsilon_T1 = T/(2*T1)`, `epsilon_phi = T/T2 - T/(2*T1)` (Wood & Gambetta, 2018)
- **DRAG coherent error**: Empirical scaling from the gate-time sweep data, proportional to `(Omega/alpha)^4`
- **DRAG beta**: `beta = -1/(2*alpha)` where alpha is in rad/ns (amplitude-independent, per Motzoi et al. 2009)
- **Robustness**: Interpolated from the paper's detuning/amplitude sweep data at 20ns reference point

These are analytical estimates. For production calibration, run the full numerical simulation using the [QubitPulseOpt](https://github.com/rylanmalarchick/QubitPulseOpt) framework.

## Author

Rylan Malarchick — [rylanmalarchick.com](https://rylanmalarchick.com) — Engineering Physics, Embry-Riddle Aeronautical University

## References

- R. Malarchick, "When does numerical pulse optimization actually help? Error budgets, robustness tradeoffs, and calibration guidance for transmon single-qubit gates," [arXiv:2511.12799](https://arxiv.org/abs/2511.12799) (2025).
- F. Motzoi et al., "Simple pulses for elimination of leakage in weakly nonlinear qubits," [Phys. Rev. Lett. 103, 110501](https://doi.org/10.1103/PhysRevLett.103.110501) (2009).
- N. Khaneja et al., "Optimal control of coupled spin dynamics," [J. Magn. Reson. 172, 296](https://doi.org/10.1016/j.jmr.2004.11.004) (2005).
