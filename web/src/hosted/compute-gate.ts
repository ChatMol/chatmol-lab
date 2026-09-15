import type { ComputeGate } from "@/lib/compute/gate";

/**
 * ChatMol Lab (open source) has no hosted wallet. Compute is paid directly by
 * the user through their own provider credentials, so the open gate applies.
 */
export const hostedComputeGate: ComputeGate | null = null;
