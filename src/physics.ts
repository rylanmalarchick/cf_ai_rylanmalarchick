/**
 * physics.ts — Error budget computations for transmon single-qubit gates.
 *
 * All formulas derived from:
 *   Malarchick, "When does numerical pulse optimization actually help?"
 *   arXiv:2511.12799
 *
 * These are pure functions. No LLM, no network calls. The agent calls these
 * as tools and feeds the results to the LLM for explanation.
 */

export interface HardwareParams {
  alpha_mhz: number;   // anharmonicity in MHz (negative, e.g. -200)
  t1_us: number;       // T1 in microseconds
  t2_us: number;       // T2 in microseconds
  gate_time_ns: number; // gate duration in nanoseconds
}

export interface ErrorBudget {
  params: HardwareParams;
  decoherence_floor: {
    t1_contribution: number;
    t2_contribution: number;
    total: number;
  };
  estimated_infidelity: {
    gaussian: number;
    drag: number;
    grape: number;
  };
  regime: "drag_sufficient" | "grape_needed" | "short_gate_regime";
  recommendation: string;
  t2_over_t_ratio: number;
  drag_beta: number;
}

export interface RobustnessEstimate {
  method: string;
  detuning_min_fidelity: number;
  amplitude_min_fidelity: number;
  detuning_robust: boolean;
  amplitude_robust: boolean;
}

/**
 * Compute the decoherence floor for a given gate time and coherence times.
 *
 * From Wood & Gambetta (2018) and the error budget analysis in the paper:
 *   epsilon_T1 ≈ T / (2 * T1)
 *   epsilon_phi ≈ T/T2 - T/(2*T1)   (pure dephasing contribution)
 *   epsilon_total ≈ T/T2 + T/(2*T1)  (approximate, ignoring cross terms)
 *
 * More precisely, the total decoherence-limited infidelity is the sum of
 * relaxation and dephasing channels, which gives the floor that no pulse
 * optimization can beat.
 */
export function computeDecoherenceFloor(
  gate_time_ns: number,
  t1_us: number,
  t2_us: number
): { t1_contribution: number; t2_contribution: number; total: number } {
  const t_ns = gate_time_ns;
  const t1_ns = t1_us * 1000;
  const t2_ns = t2_us * 1000;

  const eps_t1 = t_ns / (2 * t1_ns);
  // Pure dephasing rate: 1/T_phi = 1/T2 - 1/(2*T1)
  // Dephasing infidelity contribution ≈ T * (1/T2 - 1/(2*T1))
  const eps_t2 = t_ns / t2_ns - t_ns / (2 * t1_ns);
  // Ensure non-negative (if T2 > 2*T1, pure dephasing is zero)
  const eps_phi = Math.max(0, eps_t2);

  return {
    t1_contribution: eps_t1,
    t2_contribution: eps_phi,
    total: eps_t1 + eps_phi,
  };
}

/**
 * Estimate DRAG coherent error based on gate time and anharmonicity.
 *
 * DRAG suppresses leakage to first order. The residual coherent error scales
 * roughly as (Omega/|alpha|)^4 for the first-order correction, where
 * Omega ~ pi/T is the peak Rabi frequency for a pi-pulse.
 *
 * From the paper's gate-time sweep data (Table I), we fit the empirical
 * scaling. At T=20ns with alpha=-200MHz, DRAG coherent error is ~4.9e-4.
 * The scaling is approximately (20/T)^4 * 4.9e-4, modulated by the
 * anharmonicity ratio.
 */
export function estimateDragCoherentError(
  gate_time_ns: number,
  alpha_mhz: number
): number {
  const abs_alpha = Math.abs(alpha_mhz);
  // Reference point: T=20ns, alpha=-200MHz gives epsilon_coh = 4.9e-4
  const ref_error = 4.9e-4;
  const ref_gate = 20;
  const ref_alpha = 200;

  // Scaling: error ~ (1/T)^4 * (1/alpha)^2 approximately
  // (Rabi frequency ~ 1/T, DRAG residual ~ (Omega/alpha)^2 after first-order)
  const ratio = (ref_gate / gate_time_ns) ** 4 * (ref_alpha / abs_alpha) ** 2;
  return ref_error * ratio;
}

/**
 * Estimate Gaussian (uncorrected) coherent error.
 * From the paper: at T=20ns, alpha=-200MHz, Gaussian infidelity is ~2.8e-2.
 * Scales roughly as (1/T)^2 * (1/alpha)^2.
 */
export function estimateGaussianCoherentError(
  gate_time_ns: number,
  alpha_mhz: number
): number {
  const abs_alpha = Math.abs(alpha_mhz);
  const ref_error = 2.8e-2;
  const ref_gate = 20;
  const ref_alpha = 200;

  const ratio = (ref_gate / gate_time_ns) ** 2 * (ref_alpha / abs_alpha) ** 2;
  return ref_error * ratio;
}

/**
 * Compute the DRAG parameter beta = -1/(2*alpha).
 * alpha must be in rad/ns: alpha_rad = alpha_mhz * 2*pi / 1000
 * Returns beta in ns.
 */
export function computeDragBeta(alpha_mhz: number): number {
  const alpha_rad_per_ns = alpha_mhz * 2 * Math.PI / 1000;
  return -1 / (2 * alpha_rad_per_ns);
}

/**
 * Full error budget computation.
 */
export function computeErrorBudget(params: HardwareParams): ErrorBudget {
  const { alpha_mhz, t1_us, t2_us, gate_time_ns } = params;

  const floor = computeDecoherenceFloor(gate_time_ns, t1_us, t2_us);
  const drag_coherent = estimateDragCoherentError(gate_time_ns, alpha_mhz);
  const gaussian_coherent = estimateGaussianCoherentError(gate_time_ns, alpha_mhz);

  // GRAPE eliminates coherent error; infidelity = decoherence floor
  const grape_total = floor.total;
  // DRAG total = coherent + decoherence (approximately additive)
  const drag_total = drag_coherent + floor.total;
  // Gaussian total = coherent dominates
  const gaussian_total = gaussian_coherent + floor.total;

  const t2_over_t = (t2_us * 1000) / gate_time_ns;
  const beta = computeDragBeta(alpha_mhz);

  // Regime classification
  let regime: ErrorBudget["regime"];
  let recommendation: string;

  if (gate_time_ns < 15) {
    regime = "short_gate_regime";
    recommendation =
      `At ${gate_time_ns}ns gate time, DRAG's perturbative correction breaks down. ` +
      `GRAPE (or another numerical method) is needed for high fidelity. ` +
      `The first-order DRAG correction cannot suppress higher-order leakage ` +
      `pathways that become significant when Omega/|alpha| is large.`;
  } else if (drag_coherent < floor.total * 0.5) {
    regime = "drag_sufficient";
    recommendation =
      `Properly calibrated DRAG is sufficient here. DRAG coherent error ` +
      `(${drag_coherent.toExponential(2)}) is well below the decoherence floor ` +
      `(${floor.total.toExponential(2)}). GRAPE would eliminate the residual ` +
      `coherent error, but the improvement is marginal: ` +
      `${(drag_total / grape_total).toFixed(2)}x above GRAPE's decoherence-limited performance. ` +
      `Your highest-leverage improvement is increasing T2 ` +
      `(currently ${t2_us} us, contributing ${floor.t2_contribution.toExponential(2)} to infidelity).`;
  } else {
    regime = "grape_needed";
    recommendation =
      `DRAG coherent error (${drag_coherent.toExponential(2)}) is comparable to or exceeds ` +
      `the decoherence floor (${floor.total.toExponential(2)}). GRAPE can provide meaningful ` +
      `improvement by eliminating coherent error entirely. ` +
      `Consider numerical optimization for this parameter regime.`;
  }

  return {
    params,
    decoherence_floor: floor,
    estimated_infidelity: {
      gaussian: gaussian_total,
      drag: drag_total,
      grape: grape_total,
    },
    regime,
    recommendation,
    t2_over_t_ratio: t2_over_t,
    drag_beta: beta,
  };
}

/**
 * Robustness estimates based on the paper's sweep data.
 *
 * From Table III: over +/-5 MHz detuning and +/-5% amplitude error at T=20ns.
 * These are interpolated for different gate times (robustness generally
 * improves with longer gates as the bandwidth narrows).
 */
export function estimateRobustness(params: HardwareParams): RobustnessEstimate[] {
  const t = params.gate_time_ns;
  // Robustness degrades at shorter gate times (broader bandwidth)
  // Scale factors relative to 20ns reference
  const gate_factor = Math.min(1, 20 / t);

  return [
    {
      method: "Gaussian",
      detuning_min_fidelity: 0.937 * (1 - 0.03 * gate_factor),
      amplitude_min_fidelity: 0.965 * (1 - 0.02 * gate_factor),
      detuning_robust: false,
      amplitude_robust: false,
    },
    {
      method: "DRAG",
      detuning_min_fidelity: 0.990 * (1 - 0.01 * gate_factor),
      amplitude_min_fidelity: 0.990 * (1 - 0.01 * gate_factor),
      detuning_robust: true,
      amplitude_robust: true,
    },
    {
      method: "GRAPE",
      detuning_min_fidelity: 0.931 * (1 - 0.04 * gate_factor),
      amplitude_min_fidelity: 0.994 * (1 - 0.005 * gate_factor),
      detuning_robust: false,
      amplitude_robust: true,
    },
  ];
}

/**
 * Format an error budget as a readable text block for the LLM to incorporate.
 */
export function formatErrorBudget(budget: ErrorBudget): string {
  const p = budget.params;
  const lines = [
    `=== Error Budget Analysis ===`,
    `Hardware: alpha/2pi = ${p.alpha_mhz} MHz, T1 = ${p.t1_us} us, T2 = ${p.t2_us} us`,
    `Gate time: ${p.gate_time_ns} ns`,
    `DRAG beta: ${budget.drag_beta.toFixed(4)} ns`,
    `T2/T ratio: ${budget.t2_over_t_ratio.toFixed(0)}`,
    ``,
    `Decoherence floor:`,
    `  T1 contribution:  ${budget.decoherence_floor.t1_contribution.toExponential(2)}`,
    `  T2 contribution:  ${budget.decoherence_floor.t2_contribution.toExponential(2)}`,
    `  Total floor:      ${budget.decoherence_floor.total.toExponential(2)}`,
    ``,
    `Estimated total infidelity (1 - F):`,
    `  Gaussian: ${budget.estimated_infidelity.gaussian.toExponential(2)}`,
    `  DRAG:     ${budget.estimated_infidelity.drag.toExponential(2)}`,
    `  GRAPE:    ${budget.estimated_infidelity.grape.toExponential(2)}`,
    ``,
    `Regime: ${budget.regime}`,
    ``,
    `Recommendation: ${budget.recommendation}`,
  ];
  return lines.join("\n");
}
