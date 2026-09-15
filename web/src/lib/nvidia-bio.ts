// NVIDIA Biology NIM API Wrappers
// Based on official NVIDIA NIM API documentation

// -- Return type interfaces --

export interface StructureResult {
  structure: string;       // PDB or mmCIF text, ready to save to file
  format: "pdb" | "mmcif";
}

export interface ScoredStructureResult extends StructureResult {
  confidence: number;
  ptm: number;
  iptm: number;
  plddt: number;
  all_structures: StructureResult[];
}

export interface MoleculeResult {
  smiles: string;
  score: number;
}

export interface DesignedSequence {
  sequence: string;
  score: number;
  global_score: number;
  seq_recovery?: number;
}

// -- Internal helpers --

/** Throw if the API response contains an error. */
function checkError(data: any): void {
  if (data?.detail) throw new Error(`NVIDIA API error: ${JSON.stringify(data.detail)}`);
  if (data?.error && typeof data.error === "string") throw new Error(`NVIDIA API error: ${data.error}`);
  if (data?.status === "failed") throw new Error(`NVIDIA API error: ${data.error || "unknown"}`);
}

/**
 * Upload a large input string as an NVCF asset.
 * Required for DiffDock inputs (protein and ligand) and potentially other large inputs.
 */
async function uploadNVCFAsset(token: string, content: string, description: string = "asset-file"): Promise<string> {
  const assetsUrl = "https://api.nvcf.nvidia.com/v2/nvcf/assets";

  // 1. Initialize upload
  const initResponse = await fetch(assetsUrl, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify({
      contentType: "text/plain",
      description: description
    })
  });

  if (!initResponse.ok) {
    const errText = await initResponse.text();
    throw new Error(`Failed to initialize asset upload: ${initResponse.status} ${errText}`);
  }

  const initData = await initResponse.json();
  const uploadUrl = initData.uploadUrl;
  const assetId = initData.assetId;

  // 2. Upload content
  const uploadResponse = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "x-amz-meta-nvcf-asset-description": description,
      "Content-Type": "text/plain"
    },
    body: content
  });

  if (!uploadResponse.ok) {
    const errText = await uploadResponse.text();
    throw new Error(`Failed to upload asset content: ${uploadResponse.status} ${errText}`);
  }

  return assetId;
}

/**
 * Helper to handle NVIDIA API responses that may return PDB text
 * instead of JSON. Some endpoints (AlphaFold2 and others) return
 * raw PDB strings, not JSON.
 */
export async function handleResponse(response: Response): Promise<any> {
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();

  // The HTTP status is the only reliable signal. This used to be inferred by
  // grepping the body for "404", which reported every failure as a missing
  // endpoint and hid 401/403/429/5xx behind an unactionable message.
  if (!response.ok) {
    let detail = text;
    if (contentType.includes("application/json")) {
      try {
        const parsed = JSON.parse(text);
        const candidate = parsed?.detail ?? parsed?.error ?? parsed?.message;
        detail = typeof candidate === "string" ? candidate
          : candidate != null ? JSON.stringify(candidate)
          : JSON.stringify(parsed);
      } catch {
        detail = text;
      }
    }
    const status = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
    const snippet = detail.trim().replace(/\s+/g, " ").slice(0, 300);
    throw new Error(`NVIDIA API error: ${status}${snippet ? ` — ${snippet}` : ""}`);
  }

  // If the response is JSON, parse and return
  if (contentType.includes("application/json")) {
    const data = JSON.parse(text);
    checkError(data);
    return data;
  }

  // If the response starts with known PDB/mmCIF markers, return as structure
  if (
    text.startsWith("ATOM") ||
    text.startsWith("HEADER") ||
    text.startsWith("REMARK") ||
    text.startsWith("data_") ||
    text.startsWith("MODEL")
  ) {
    return { structure: text, format: "pdb" };
  }

  // Try JSON parse as fallback
  try {
    const data = JSON.parse(text);
    checkError(data);
    return data;
  } catch {
    const data = { raw_response: text };
    checkError(data);
    return data;
  }
}

// -- OpenFold models --

/**
 * Predict protein structure (monomer) from MSA and template using OpenFold2.
 */
export async function predictStructureOpenFold2(
  token: string,
  sequence: string,
  msa?: string,
  template?: string
): Promise<any> {
  const payload: any = {
    sequence: sequence,
  };
  if (msa) {
    payload.msa = msa;
  }
  if (template) {
    payload.template = template;
  }
  const response = await fetch(
    "https://health.api.nvidia.com/v1/biology/openfold/openfold2/predict-structure-from-msa-and-template",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    }
  );
  const data = await handleResponse(response);
  if (data.structures_in_ranked_order?.length > 0) {
    const top = data.structures_in_ranked_order[0];
    return {
      structure: top.structure,
      format: top.format || "pdb",
      all_structures: data.structures_in_ranked_order,
    };
  }
  return data;
}

/**
 * Predict biomolecular complex 3D structure using OpenFold3.
 */
export async function predictComplexOpenFold3(
  token: string,
  molecules: Array<{
    type: "protein" | "dna" | "rna" | "ligand";
    id: string;
    sequence?: string;
    smiles?: string;
    ccd_codes?: string;
    msa?: any;
  }>,
  diffusionSamples: number = 1,
  outputFormat: string = "cif"
): Promise<any> {
  const data = {
    inputs: [
      {
        input_id: "query",
        molecules: molecules,
        diffusion_samples: diffusionSamples,
        output_format: outputFormat,
      },
    ],
  };
  const response = await fetch(
    "https://health.api.nvidia.com/v1/biology/openfold/openfold3/predict",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    }
  );
  const result = await handleResponse(response);
  if (result.outputs?.[0]?.structures_with_scores?.length > 0) {
    const top = result.outputs[0].structures_with_scores[0];
    return {
      structure: top.structure,
      format: top.format || "mmcif",
      confidence: result.confidence_scores?.[0] ?? null,
      ptm: result.ptm_scores?.[0] ?? null,
      iptm: result.iptm_scores?.[0] ?? null,
      plddt: result.plddt_scores?.[0] ?? null,
      all_structures: result.outputs[0].structures_with_scores,
    };
  }
  return result;
}

/**
 * Convenience wrapper to build OpenFold3 molecules from simple inputs.
 */
export async function predictComplexOpenFold3Simple(
  token: string,
  proteinSequences?: string[],
  dnaSequences?: string[],
  rnaSequences?: string[],
  ligandSmiles?: string[],
  ligandCcds?: string[]
): Promise<any> {
  const molecules: any[] = [];
  let chainId = 0;

  if (proteinSequences) {
    for (const seq of proteinSequences) {
      const id = String.fromCharCode(65 + chainId++);
      const msaCsv = `key,sequence\n-1,${seq}`;
      molecules.push({
        type: "protein",
        id: id,
        sequence: seq,
        msa: {
          main_db: {
            csv: {
              alignment: msaCsv,
              format: "csv",
            },
          },
        },
      });
    }
  }
  if (dnaSequences) {
    for (const seq of dnaSequences) {
      const id = String.fromCharCode(65 + chainId++);
      molecules.push({ type: "dna", id: id, sequence: seq });
    }
  }
  if (rnaSequences) {
    for (const seq of rnaSequences) {
      const id = String.fromCharCode(65 + chainId++);
      molecules.push({ type: "rna", id: id, sequence: seq });
    }
  }
  if (ligandSmiles) {
    for (const smi of ligandSmiles) {
      const id = String.fromCharCode(65 + chainId++);
      molecules.push({ type: "ligand", id: id, smiles: smi });
    }
  }
  if (ligandCcds) {
    for (const ccd of ligandCcds) {
      const id = String.fromCharCode(65 + chainId++);
      molecules.push({ type: "ligand", id: id, ccd_codes: ccd });
    }
  }

  return predictComplexOpenFold3(token, molecules);
}

// -- MIT models (Boltz-2 and DiffDock) --

export interface Boltz2Options {
  ligands?: Array<Record<string, unknown>>;
  constraints?: Array<Record<string, unknown>>;
  recycling_steps?: number;
  sampling_steps?: number;
  diffusion_samples?: number;
  step_scale?: number;
  without_potentials?: boolean;
  concatenate_msas?: boolean;
  sampling_steps_affinity?: number;
  diffusion_samples_affinity?: number;
  affinity_mw_correction?: boolean;
  write_full_pae?: boolean;
}

/**
 * Predict biomolecular complex structure using the Boltz-2 model.
 * Supports multiple polymers (protein/dna/rna), ligands, constraints, and affinity prediction.
 */
export async function predictStructureBoltz2(
  token: string,
  polymers: Array<Record<string, unknown>>,
  opts: Boltz2Options = {},
): Promise<any> {
  const body: Record<string, unknown> = {
    polymers,
    output_format: "mmcif",
  };
  if (opts.ligands && opts.ligands.length > 0) body.ligands = opts.ligands;
  if (opts.constraints && opts.constraints.length > 0) body.constraints = opts.constraints;
  if (opts.recycling_steps != null) body.recycling_steps = opts.recycling_steps;
  if (opts.sampling_steps != null) body.sampling_steps = opts.sampling_steps;
  if (opts.diffusion_samples != null) body.diffusion_samples = opts.diffusion_samples;
  if (opts.step_scale != null) body.step_scale = opts.step_scale;

  const response = await fetch(
    "https://health.api.nvidia.com/v1/biology/mit/boltz2/predict",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );
  const data = await handleResponse(response);
  if (data.structures?.length > 0) {
    const top = data.structures[0];
    return {
      structure: top.structure,
      format: top.format || "mmcif",
      confidence: data.confidence_scores?.[0] ?? null,
      ptm: data.ptm_scores?.[0] ?? null,
      iptm: data.iptm_scores?.[0] ?? null,
      plddt: data.plddt_scores?.[0] ?? null,
      all_structures: data.structures,
    };
  }
  return data;
}

/**
 * Predict binding conformations (docking poses) using DiffDock.
 */
export async function predictDockingDiffDock(
  token: string,
  proteinPdb: string,
  ligand: string,
  ligandFileType?: string,
  numPoses: number = 10,
  timeDivisions: number = 20,
  steps: number = 18
): Promise<any> {
  const proteinId = await uploadNVCFAsset(token, proteinPdb, "diffdock-protein");
  const ligandId = await uploadNVCFAsset(token, ligand, "diffdock-ligand");

  const body: any = {
    protein: proteinId,
    ligand: ligandId,
    num_poses: numPoses,
    time_divisions: timeDivisions,
    steps: steps,
    save_trajectory: false,
    is_staged: true,
  };

  if (ligandFileType) {
    body.ligand_file_type = ligandFileType;
  }

  const response = await fetch(
    "https://health.api.nvidia.com/v1/biology/mit/diffdock",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "NVCF-INPUT-ASSET-REFERENCES": [proteinId, ligandId].join(","),
      },
      body: JSON.stringify(body),
    }
  );
  return handleResponse(response);
}

// -- NVIDIA small molecule generation models --

/**
 * Generate molecular structures using the NVIDIA GenMol model.
 */
export async function generateMoleculesGenMol(
  token: string,
  smiles: string,
  numMolecules: number = 30,
  temperature: number = 1.0,
  noise: number = 0.0,
  stepSize: number = 1,
  scoring: "QED" | "LogP" = "QED"
): Promise<any> {
  const body = {
    smiles: smiles,
    num_molecules: String(numMolecules),
    temperature: String(temperature),
    noise: String(noise),
    step_size: String(stepSize),
    scoring: scoring,
  };
  const response = await fetch(
    "https://health.api.nvidia.com/v1/biology/nvidia/genmol/generate",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );
  const data = await response.json();
  checkError(data);
  return { molecules: data.molecules };
}

/**
 * Perform controlled molecule generation using the NVIDIA MolMIM model.
 */
export async function generateMoleculesMolMIM(
  token: string,
  smilesInput: string,
  numSamples: number = 10,
  algorithm: string = "CMA-ES",
  propertyName: string = "QED",
  iterations: number = 10
): Promise<any> {
  const body = {
    smi: smilesInput,
    num_molecules: numSamples,
    algorithm: algorithm,
    property_name: propertyName,
    iterations: iterations,
  };
  const response = await fetch(
    "https://health.api.nvidia.com/v1/biology/nvidia/molmim/generate",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );
  const data = await response.json();
  checkError(data);
  let molecules: MoleculeResult[] = [];
  if (typeof data.molecules === "string") {
    const parsed = JSON.parse(data.molecules);
    molecules = parsed.map((m: any) => ({
      smiles: m.sample || m.smiles,
      score: m.score,
    }));
  } else if (Array.isArray(data.molecules)) {
    molecules = data.molecules;
  }
  return {
    molecules,
    scoreType: data.score_type || null,
  };
}

// -- ARC Evo2 model --

/**
 * Generate biological sequences (DNA) using the Evo 2 (40B) model.
 */
export async function generateSequenceEvo2(
  token: string,
  sequence: string,
  numTokens: number = 100,
  topK: number = 3,
  topP: number = 0.0,
  temperature: number = 0.7
): Promise<any> {
  const body: any = {
    sequence: sequence,
    num_tokens: numTokens,
    top_k: topK,
    top_p: topP,
    temperature: temperature,
  };
  const response = await fetch(
    "https://health.api.nvidia.com/v1/biology/arc/evo2-40b/generate",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );
  const data = await handleResponse(response);
  if (data.sequence !== undefined) {
    return { sequence: data.sequence };
  }
  return data;
}

// -- ColabFold MSA search --

/**
 * Search and generate a Multiple Sequence Alignment (MSA) using ColabFold.
 */
export async function msaSearchColabFold(
  token: string,
  sequence: string
): Promise<any> {
  const response = await fetch(
    "https://health.api.nvidia.com/v1/biology/colabfold/msa-search/predict",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        sequence: sequence,
      }),
    }
  );
  return handleResponse(response);
}

// -- IPD models (ProteinMPNN and RFdiffusion) --

export interface ProteinMPNNOptions {
  input_pdb_chains?: string[];
  ca_only?: boolean;
  use_soluble_model?: boolean;
  random_seed?: number;
  num_seq_per_target?: number;
  sampling_temp?: number[];
  pssm_jsonl?: string;
  pssm_multi?: number;
  pssm_threshold?: number;
  pssm_bias_flag?: boolean;
  pssm_log_odds_flag?: boolean;
  fixed_positions_jsonl?: string;
  omit_AAs?: string[];
  omit_AA_jsonl?: string;
  bias_AA_jsonl?: string;
  bias_by_res_jsonl?: string;
  tied_positions_jsonl?: string;
}

/**
 * Design candidate amino acid sequences for a given protein backbone
 * using the ProteinMPNN model.
 */
export async function designProteinSequenceMPNN(
  token: string,
  backbonePdb: string,
  opts: ProteinMPNNOptions = {},
): Promise<any> {
  const body: any = {
    input_pdb: backbonePdb,
  };
  if (opts.input_pdb_chains) body.input_pdb_chains = opts.input_pdb_chains;
  if (opts.ca_only != null) body.ca_only = opts.ca_only;
  if (opts.use_soluble_model != null) body.use_soluble_model = opts.use_soluble_model;
  if (opts.random_seed != null) body.random_seed = opts.random_seed;
  if (opts.num_seq_per_target != null) body.num_seq_per_target = opts.num_seq_per_target;
  if (opts.sampling_temp != null) body.sampling_temp = opts.sampling_temp;
  if (opts.pssm_jsonl != null) body.pssm_jsonl = opts.pssm_jsonl;
  if (opts.pssm_multi != null) body.pssm_multi = opts.pssm_multi;
  if (opts.pssm_threshold != null) body.pssm_threshold = opts.pssm_threshold;
  if (opts.pssm_bias_flag != null) body.pssm_bias_flag = opts.pssm_bias_flag;
  if (opts.pssm_log_odds_flag != null) body.pssm_log_odds_flag = opts.pssm_log_odds_flag;
  if (opts.fixed_positions_jsonl != null) body.fixed_positions_jsonl = opts.fixed_positions_jsonl;
  if (opts.omit_AAs != null) body.omit_AAs = opts.omit_AAs;
  if (opts.omit_AA_jsonl != null) body.omit_AA_jsonl = opts.omit_AA_jsonl;
  if (opts.bias_AA_jsonl != null) body.bias_AA_jsonl = opts.bias_AA_jsonl;
  if (opts.bias_by_res_jsonl != null) body.bias_by_res_jsonl = opts.bias_by_res_jsonl;
  if (opts.tied_positions_jsonl != null) body.tied_positions_jsonl = opts.tied_positions_jsonl;

  const response = await fetch(
    "https://health.api.nvidia.com/v1/biology/ipd/proteinmpnn/predict",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    }
  );
  const data = await handleResponse(response);
  if (data.mfasta) {
    const sequences: DesignedSequence[] = [];
    const entries = data.mfasta.split(">").filter((s: string) => s.trim());
    for (const entry of entries) {
      const lines = entry.trim().split("\n");
      const header = lines[0] || "";
      const sequence = lines.slice(1).join("");
      const scoreMatch = header.match(/score=([\d.]+)/);
      const globalMatch = header.match(/global_score=([\d.]+)/);
      const recoveryMatch = header.match(/seq_recovery=([\d.]+)/);
      sequences.push({
        sequence,
        score: scoreMatch ? parseFloat(scoreMatch[1]) : 0,
        global_score: globalMatch ? parseFloat(globalMatch[1]) : 0,
        seq_recovery: recoveryMatch ? parseFloat(recoveryMatch[1]) : undefined,
      });
    }
    return {
      sequences,
      raw_fasta: data.mfasta,
    };
  }
  return data;
}

export interface RFdiffusionOptions {
  input_pdb?: string;
  hotspot_res?: string[];
  diffusion_steps?: number;
  random_seed?: number;
}

/**
 * Generate novel protein 3D structures using the RFdiffusion model.
 * input_pdb is optional (not needed for unconditional generation).
 * Response: { output_pdb: string, elapsed_ms: number }
 */
export async function generateProteinRFdiffusion(
  token: string,
  contigs: string,
  opts: RFdiffusionOptions = {},
): Promise<any> {
  const body: Record<string, unknown> = {
    contigs,
  };
  if (opts.input_pdb) body.input_pdb = opts.input_pdb;
  if (opts.hotspot_res) body.hotspot_res = opts.hotspot_res;
  if (opts.diffusion_steps != null) body.diffusion_steps = opts.diffusion_steps;
  if (opts.random_seed != null) body.random_seed = opts.random_seed;

  const response = await fetch(
    "https://health.api.nvidia.com/v1/biology/ipd/rfdiffusion/generate",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    }
  );
  return handleResponse(response);
}

