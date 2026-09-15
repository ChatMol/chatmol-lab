/**
 * Which compute backend the agent should reach for, expressed as prompt text.
 *
 * This used to be `wemol-routing.ts`, which read the user's message with
 * unbounded keyword RegExps ("humanization", "人源化", "simulation", …) and
 * removed `nvidia_*` tools from the run when it thought the task belonged to
 * WeMol. The same task then got different tools depending on the language it
 * was written in: "Humanize this nanobody" kept every tool because the pattern
 * spelled the noun, while the Chinese sentence for the same request lost
 * RFdiffusion. Tool exposure must not depend on the wording of a request.
 *
 * What is left is a preference the *user* sets (Settings → API → WeMol compute
 * profile) and the model reads in its system prompt. The model still sees
 * every tool and picks.
 */

export type WemolComputeProfile = "pre_experiment" | "industrial";

export function normalizeWemolComputeProfile(value: unknown): WemolComputeProfile {
  return value === "industrial" ? "industrial" : "pre_experiment";
}

/**
 * The compute-cost section of the system prompt. Depends only on the profile
 * the user chose, never on the request.
 */
export function buildComputeCostPolicySection(profileInput: unknown): string {
  const profile = normalizeWemolComputeProfile(profileInput);
  const preference = profile === "industrial"
    ? [
      "Profile: industrial. For a final, production-grade result prefer a validated WeMol module or flow, which is paid and schema-driven.",
      "Use the free NVIDIA NIM and local tools for quick prechecks, for exploration, and whenever the user names a specific method.",
    ]
    : [
      "Profile: pre-experiment. Prefer free NVIDIA NIM and local computation first.",
      "Spend WeMol only on capabilities the free tools do not cover (antibody humanization, CDR grafting, developability, immunogenicity, ADMET, simulation, virtual screening), or when the user asks for WeMol.",
    ];
  return [
    "## Compute Cost Policy",
    ...preference,
    "This is a preference, not a restriction: every tool is available on every request. Choose by what the task needs, not by the words it was written with, and say which backend you picked and why before a paid run.",
  ].join("\n");
}
