/**
 * index.ts — PulseLab: Quantum Pulse Calibration Advisor
 *
 * A Cloudflare Agent that helps experimentalists decide between
 * Gaussian, DRAG, and GRAPE pulse optimization methods for transmon
 * single-qubit gates. Based on arXiv:2511.12799.
 *
 * Architecture:
 *   - Workers AI (Llama 3.3 70B) for conversational understanding
 *   - Durable Object (Agent class) for per-session state and memory
 *   - Tool-calling for real physics computations (not LLM hallucination)
 *   - WebSocket chat interface served from static HTML
 */

import { Agent, type Connection, type ConnectionContext, type WSMessage, type AgentNamespace, routeAgentRequest } from "agents";
import {
  computeErrorBudget,
  estimateRobustness,
  formatErrorBudget,
  type HardwareParams,
} from "./physics";
import { SYSTEM_PROMPT, TOOL_DESCRIPTIONS } from "./prompt";

// ─── Types ───────────────────────────────────────────────────────────

interface Env {
  AI: Ai;
  PULSE_LAB_AGENT: AgentNamespace<PulseLabAgent>;
}

interface ChatMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface SavedConfig {
  name: string;
  params: HardwareParams;
  created_at: string;
}

interface AgentState {
  messages: ChatMessage[];
  configs: SavedConfig[];
}

// ─── Tool execution ──────────────────────────────────────────────────

function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  state: AgentState
): string {
  switch (toolName) {
    case "compute_error_budget": {
      const params: HardwareParams = {
        alpha_mhz: args.alpha_mhz as number,
        t1_us: args.t1_us as number,
        t2_us: args.t2_us as number,
        gate_time_ns: args.gate_time_ns as number,
      };

      // Input validation
      if (params.t2_us > 2 * params.t1_us) {
        return `Warning: T2 (${params.t2_us} us) exceeds 2*T1 (${2 * params.t1_us} us). This is physically impossible; T2 <= 2*T1 always. Please check your values.`;
      }
      if (params.alpha_mhz > 0) {
        return `Warning: Positive anharmonicity (${params.alpha_mhz} MHz) is unusual for transmons. Transmons typically have alpha < 0 (e.g., -200 MHz). Did you mean ${-Math.abs(params.alpha_mhz)} MHz?`;
      }
      if (params.gate_time_ns <= 0 || params.t1_us <= 0 || params.t2_us <= 0) {
        return `Error: All time parameters must be positive.`;
      }

      const budget = computeErrorBudget(params);
      return formatErrorBudget(budget);
    }

    case "estimate_robustness": {
      const params: HardwareParams = {
        alpha_mhz: args.alpha_mhz as number,
        t1_us: args.t1_us as number,
        t2_us: args.t2_us as number,
        gate_time_ns: args.gate_time_ns as number,
      };
      const robustness = estimateRobustness(params);
      const lines = [
        `=== Robustness Estimates (±5 MHz detuning, ±5% amplitude) ===`,
        `Gate time: ${params.gate_time_ns} ns`,
        ``,
      ];
      for (const r of robustness) {
        lines.push(
          `${r.method}:`,
          `  Detuning min fidelity:  ${r.detuning_min_fidelity.toFixed(4)} ${r.detuning_robust ? "(robust)" : "(sensitive)"}`,
          `  Amplitude min fidelity: ${r.amplitude_min_fidelity.toFixed(4)} ${r.amplitude_robust ? "(robust)" : "(sensitive)"}`,
          ``
        );
      }
      lines.push(
        `Note: DRAG's superior detuning robustness is a key finding. GRAPE's`,
        `richer spectral content makes it more sensitive to frequency shifts.`
      );
      return lines.join("\n");
    }

    case "save_config": {
      const config: SavedConfig = {
        name: args.name as string,
        params: {
          alpha_mhz: args.alpha_mhz as number,
          t1_us: args.t1_us as number,
          t2_us: args.t2_us as number,
          gate_time_ns: args.gate_time_ns as number,
        },
        created_at: new Date().toISOString(),
      };
      state.configs.push(config);
      return `Saved configuration "${config.name}": alpha=${config.params.alpha_mhz} MHz, T1=${config.params.t1_us} us, T2=${config.params.t2_us} us, T_gate=${config.params.gate_time_ns} ns`;
    }

    case "list_configs": {
      if (state.configs.length === 0) {
        return "No saved configurations yet. Use save_config to store hardware parameters.";
      }
      const lines = ["Saved configurations:"];
      for (const c of state.configs) {
        lines.push(
          `  - "${c.name}": alpha=${c.params.alpha_mhz} MHz, T1=${c.params.t1_us} us, T2=${c.params.t2_us} us, T_gate=${c.params.gate_time_ns} ns`
        );
      }
      return lines.join("\n");
    }

    default:
      return `Unknown tool: ${toolName}`;
  }
}

// ─── Agent ───────────────────────────────────────────────────────────

export class PulseLabAgent extends Agent<Env, AgentState> {
  initialState: AgentState = {
    messages: [],
    configs: [],
  };

  async onConnect(connection: Connection, ctx: ConnectionContext) {
    // Initialize SQL table for persistent config storage
    this.sql`
      CREATE TABLE IF NOT EXISTS configs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        alpha_mhz REAL NOT NULL,
        t1_us REAL NOT NULL,
        t2_us REAL NOT NULL,
        gate_time_ns REAL NOT NULL,
        created_at TEXT NOT NULL
      )
    `;

    // Load saved configs into state
    const rows = this.sql<{
      name: string;
      alpha_mhz: number;
      t1_us: number;
      t2_us: number;
      gate_time_ns: number;
      created_at: string;
    }>`SELECT * FROM configs ORDER BY created_at`;

    const configs: SavedConfig[] = rows.map((row) => ({
      name: row.name,
      params: {
        alpha_mhz: row.alpha_mhz,
        t1_us: row.t1_us,
        t2_us: row.t2_us,
        gate_time_ns: row.gate_time_ns,
      },
      created_at: row.created_at,
    }));

    this.setState({ ...this.state, configs });
  }

  async onMessage(connection: Connection, message: WSMessage) {
    if (typeof message !== "string") return;

    try {
      const data = JSON.parse(message);

      if (data.type === "chat") {
        await this.handleChat(connection, data.content);
      } else if (data.type === "clear") {
        this.setState({ messages: [], configs: this.state.configs });
        connection.send(JSON.stringify({ type: "cleared" }));
      }
    } catch (err) {
      connection.send(
        JSON.stringify({
          type: "error",
          content: `Error: ${err instanceof Error ? err.message : String(err)}`,
        })
      );
    }
  }

  private async handleChat(connection: Connection, userMessage: string) {
    // Add user message to history
    const messages: ChatMessage[] = [
      ...this.state.messages,
      { role: "user", content: userMessage },
    ];

    // Build the messages array for the LLM
    const llmMessages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      ...messages,
    ];

    // Call Workers AI with tool definitions
    const tools = Object.values(TOOL_DESCRIPTIONS).map((t) => ({
      type: "function" as const,
      function: t,
    }));

    // Stream indicator
    connection.send(JSON.stringify({ type: "thinking" }));

    const response = (await this.env.AI.run(
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast" as Parameters<Ai["run"]>[0],
      {
        messages: llmMessages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        tools,
        max_tokens: 2048,
      }
    )) as { response?: string; tool_calls?: ToolCall[] };

    // Handle tool calls
    if (response?.tool_calls && response.tool_calls.length > 0) {
      const toolCalls = response.tool_calls;

      // Add assistant message with tool calls
      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: "",
        tool_calls: toolCalls,
      };
      messages.push(assistantMsg);

      // Execute each tool call
      for (const tc of toolCalls) {
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(tc.function.arguments);
        } catch {
          args = {};
        }

        const result = executeTool(tc.function.name, args, this.state);

        // Persist config saves to SQL
        if (tc.function.name === "save_config" && args.name) {
          const now = new Date().toISOString();
          const name = args.name as string;
          const alpha = args.alpha_mhz as number;
          const t1 = args.t1_us as number;
          const t2 = args.t2_us as number;
          const gt = args.gate_time_ns as number;
          this.sql`INSERT INTO configs (name, alpha_mhz, t1_us, t2_us, gate_time_ns, created_at) VALUES (${name}, ${alpha}, ${t1}, ${t2}, ${gt}, ${now})`;
        }

        messages.push({
          role: "tool",
          content: result,
          tool_call_id: tc.id,
          name: tc.function.name,
        });
      }

      // Second LLM call with tool results
      const followUp = (await this.env.AI.run(
        "@cf/meta/llama-3.3-70b-instruct-fp8-fast" as Parameters<Ai["run"]>[0],
        {
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            ...messages.map((m) => ({
              role: m.role,
              content: m.content,
            })),
          ],
          max_tokens: 2048,
        }
      )) as { response?: string };

      const assistantContent = followUp?.response ??
        "I computed the error budget but had trouble formatting the response. The tool results above contain the raw data.";

      messages.push({ role: "assistant", content: assistantContent });
      this.setState({ ...this.state, messages });

      connection.send(
        JSON.stringify({ type: "response", content: assistantContent })
      );
    } else {
      // Direct response (no tool calls)
      const content = response?.response ??
        "I could not generate a response. Please try rephrasing your question.";

      messages.push({ role: "assistant", content });
      this.setState({ ...this.state, messages });

      connection.send(JSON.stringify({ type: "response", content }));
    }
  }
}

// ─── Worker entrypoint ───────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // API: compute error budget directly (no LLM, just physics)
    if (url.pathname === "/api/error-budget" && request.method === "POST") {
      try {
        const body = (await request.json()) as HardwareParams;
        const budget = computeErrorBudget(body);
        return new Response(JSON.stringify(budget, null, 2), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(
          JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    // Route WebSocket and agent requests via the Agents SDK
    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) return agentResponse;

    // Serve static files (handled by [assets] in wrangler.toml)
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
