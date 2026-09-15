/**
 * Direct NVIDIA BioNeMo NIM provider: calls build.nvidia.com with the key the
 * user configured (Settings → API or NVIDIA_API_KEY). Cost, if any, is billed
 * by NVIDIA to the user; ChatMol is not involved.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

import {
  designProteinSequenceMPNN,
  generateMoleculesGenMol,
  generateMoleculesMolMIM,
  generateProteinRFdiffusion,
  generateSequenceEvo2,
  msaSearchColabFold,
  predictComplexOpenFold3Simple,
  predictDockingDiffDock,
  predictStructureBoltz2,
  predictStructureOpenFold2,
} from "../nvidia-bio";
import { getChatSession } from "../session-db";
import { getUserNvidiaApiKey } from "../settings";
import { describeRfdiffusionOutput } from "../structure-report";
import { safeResolvePath } from "../workspace";
import { terminalJob, type ProviderJob, type ComputeProvider, type ComputeRequest } from "./provider";

export const NVIDIA_CAPABILITIES = [
  "nvidia_openfold2",
  "nvidia_openfold3",
  "nvidia_boltz2",
  "nvidia_rfdiffusion",
  "nvidia_diffdock",
  "nvidia_colabfold_msa",
  "nvidia_proteinmpnn",
  "nvidia_genmol",
  "nvidia_molmim",
  "nvidia_evo2",
] as const;

async function getNvidiaApiKey(sessionId: string): Promise<string> {
  // Look up the user who owns this session, then get their per-user key
  let userId: string | null = null;
  try {
    const session = await getChatSession(sessionId);
    userId = session?.userId ?? null;
  } catch { }
  const key = await getUserNvidiaApiKey(userId);
  if (!key) throw new Error("NVIDIA API key is not set. Configure it in Settings > API, or set the NVIDIA_API_KEY environment variable. Get one at https://build.nvidia.com/");
  return key;
}

function nvidiaOutputPath(workspace: string, tool: string, ext: string): string {
  const ts = Date.now();
  const hash = crypto.createHash("md5").update(`${tool}${ts}${Math.random()}`).digest("hex").slice(0, 4);
  return path.join(workspace, `${tool}_${ts}_${hash}.${ext}`);
}



async function execute(name: string, input: Record<string, unknown>, sessionWorkspace: string, sessionId: string): Promise<{ output: string; success: boolean }> {
  switch (name) {
  case "nvidia_openfold2": {
    try {
      const token = await getNvidiaApiKey(sessionId);
      const result = await predictStructureOpenFold2(token, input.sequence as string, input.msa as string | undefined, input.template as string | undefined);
      if (!result.structure) return { output: `OpenFold2 returned no structure: ${JSON.stringify(result).slice(0, 500)}`, success: false };
      const outPath = nvidiaOutputPath(sessionWorkspace, "openfold2", "pdb");
      fs.writeFileSync(outPath, result.structure);
      return { output: `OpenFold2 structure saved to ${outPath} (format: ${result.format || "pdb"})`, success: true };
    } catch (err: any) {
      return { output: `OpenFold2 error: ${err.message}`, success: false };
    }
  }

  case "nvidia_openfold3": {
    try {
      const token = await getNvidiaApiKey(sessionId);
      const result = await predictComplexOpenFold3Simple(
        token,
        input.protein_sequences as string[] | undefined,
        input.dna_sequences as string[] | undefined,
        input.rna_sequences as string[] | undefined,
        input.ligand_smiles as string[] | undefined,
        input.ligand_ccds as string[] | undefined,
      );
      if (!result.structure) return { output: `OpenFold3 returned no structure: ${JSON.stringify(result).slice(0, 500)}`, success: false };
      const ext = result.format === "pdb" ? "pdb" : "cif";
      const outPath = nvidiaOutputPath(sessionWorkspace, "openfold3", ext);
      fs.writeFileSync(outPath, result.structure);
      const metrics = [
        result.confidence != null ? `confidence=${result.confidence}` : null,
        result.ptm != null ? `pTM=${result.ptm}` : null,
        result.iptm != null ? `ipTM=${result.iptm}` : null,
        result.plddt != null ? `pLDDT=${result.plddt}` : null,
      ].filter(Boolean).join(", ");
      return { output: `OpenFold3 structure saved to ${outPath}${metrics ? ` (${metrics})` : ""}`, success: true };
    } catch (err: any) {
      return { output: `OpenFold3 error: ${err.message}`, success: false };
    }
  }

  case "nvidia_boltz2": {
    try {
      const token = await getNvidiaApiKey(sessionId);
      const rawPolymers = input.polymers as Array<Record<string, unknown>>;
      if (!rawPolymers || rawPolymers.length === 0) return { output: "Boltz-2 requires at least one polymer", success: false };

      // Resolve file paths to content for each polymer
      const polymers = rawPolymers.map((p) => {
        const resolved: Record<string, unknown> = { ...p };

        // sequence_file → sequence
        if (p.sequence_file && typeof p.sequence_file === "string") {
          const seqPath = safeResolvePath(p.sequence_file as string, sessionWorkspace);
          if (!seqPath) return { ...resolved, _error: `Access denied: ${p.sequence_file}` };
          if (!fs.existsSync(seqPath)) return { ...resolved, _error: `Sequence file not found: ${p.sequence_file}` };
          let content = fs.readFileSync(seqPath, "utf-8").trim();
          // Strip FASTA header if present
          if (content.startsWith(">")) {
            content = content.split("\n").filter((l: string) => !l.startsWith(">")).join("").replace(/\s/g, "");
          }
          resolved.sequence = content;
          delete resolved.sequence_file;
        }

        // msa_file → msa
        if (p.msa_file && typeof p.msa_file === "string") {
          const msaPath = safeResolvePath(p.msa_file as string, sessionWorkspace);
          if (!msaPath) return { ...resolved, _error: `Access denied: ${p.msa_file}` };
          if (!fs.existsSync(msaPath)) return { ...resolved, _error: `MSA file not found: ${p.msa_file}` };
          const msaContent = fs.readFileSync(msaPath, "utf-8");
          resolved.msa = { Uniref30_2302: { a3m: { alignment: msaContent, format: "a3m" } } };
          delete resolved.msa_file;
        }

        // template_files → structural_templates
        if (p.template_files && Array.isArray(p.template_files)) {
          const templates: Array<Record<string, string>> = [];
          for (const tf of p.template_files as string[]) {
            const tPath = safeResolvePath(tf, sessionWorkspace);
            if (!tPath) return { ...resolved, _error: `Access denied: ${tf}` };
            if (!fs.existsSync(tPath)) return { ...resolved, _error: `Template file not found: ${tf}` };
            const content = fs.readFileSync(tPath, "utf-8");
            const format = tf.endsWith(".pdb") ? "pdb" : "cif";
            templates.push({ structure: content, format, name: path.basename(tf) });
          }
          resolved.structural_templates = templates;
          delete resolved.template_files;
        }

        return resolved;
      });

      // Check for file resolution errors
      for (const p of polymers) {
        if (p._error) return { output: `Boltz-2 input error: ${p._error}`, success: false };
      }

      if (!polymers.every((p) => p.sequence)) return { output: "Boltz-2: each polymer needs a sequence (via sequence or sequence_file)", success: false };

      const result = await predictStructureBoltz2(token, polymers, {
        ligands: input.ligands as Array<Record<string, unknown>> | undefined,
        constraints: input.constraints as Array<Record<string, unknown>> | undefined,
        recycling_steps: input.recycling_steps as number | undefined,
        sampling_steps: input.sampling_steps as number | undefined,
        diffusion_samples: input.diffusion_samples as number | undefined,
        step_scale: input.step_scale as number | undefined,
        without_potentials: input.without_potentials as boolean | undefined,
        concatenate_msas: input.concatenate_msas as boolean | undefined,
        sampling_steps_affinity: input.sampling_steps_affinity as number | undefined,
        diffusion_samples_affinity: input.diffusion_samples_affinity as number | undefined,
        affinity_mw_correction: input.affinity_mw_correction as boolean | undefined,
        write_full_pae: input.write_full_pae as boolean | undefined,
      });
      if (!result.structure) return { output: `Boltz-2 returned no structure: ${JSON.stringify(result).slice(0, 500)}`, success: false };
      const ext = result.format === "pdb" ? "pdb" : "cif";
      const outPath = nvidiaOutputPath(sessionWorkspace, "boltz2", ext);
      fs.writeFileSync(outPath, result.structure);
      const metrics = [
        result.confidence != null ? `confidence=${result.confidence}` : null,
        result.ptm != null ? `pTM=${result.ptm}` : null,
        result.iptm != null ? `ipTM=${result.iptm}` : null,
        result.plddt != null ? `pLDDT=${result.plddt}` : null,
        result.affinity != null ? `affinity=${result.affinity}` : null,
      ].filter(Boolean).join(", ");
      return { output: `Boltz-2 structure saved to ${outPath}${metrics ? ` (${metrics})` : ""}`, success: true };
    } catch (err: any) {
      return { output: `Boltz-2 error: ${err.message}`, success: false };
    }
  }

  case "nvidia_rfdiffusion": {
    try {
      const token = await getNvidiaApiKey(sessionId);
      let pdbContent: string | undefined;
      if (input.input_pdb_path) {
        const pdbPath = safeResolvePath(input.input_pdb_path as string, sessionWorkspace);
        if (!pdbPath) return { output: "Access denied: PDB path outside workspace", success: false };
        if (!fs.existsSync(pdbPath)) return { output: `Input PDB not found: ${pdbPath}`, success: false };
        pdbContent = fs.readFileSync(pdbPath, "utf-8");
      }
      const result = await generateProteinRFdiffusion(token, input.contigs as string, {
        input_pdb: pdbContent,
        hotspot_res: input.hotspot_residues as string[] | undefined,
        diffusion_steps: input.diffusion_steps as number | undefined,
        random_seed: input.random_seed as number | undefined,
      });
      const pdbOut = result.output_pdb || result.structure;
      if (!pdbOut) return { output: `RFdiffusion returned no structure: ${JSON.stringify(result).slice(0, 500)}`, success: false };
      const outPath = nvidiaOutputPath(sessionWorkspace, "rfdiffusion", "pdb");
      fs.writeFileSync(outPath, pdbOut);
      const report = describeRfdiffusionOutput(pdbOut, {
        inputPdb: pdbContent,
        hotspots: input.hotspot_residues as string[] | undefined,
      });
      return { output: `RFdiffusion structure saved to ${outPath}${result.elapsed_ms ? ` (${result.elapsed_ms}ms)` : ""}.\n${report}`, success: true };
    } catch (err: any) {
      return { output: `RFdiffusion error: ${err.message}`, success: false };
    }
  }

  case "nvidia_diffdock": {
    try {
      const token = await getNvidiaApiKey(sessionId);
      const pdbPath = safeResolvePath(input.protein_pdb_path as string, sessionWorkspace);
      if (!pdbPath) return { output: "Access denied: PDB path outside workspace", success: false };
      if (!fs.existsSync(pdbPath)) return { output: `Protein PDB not found: ${pdbPath}`, success: false };
      const proteinPdb = fs.readFileSync(pdbPath, "utf-8");
      const result = await predictDockingDiffDock(
        token,
        proteinPdb,
        input.ligand as string,
        input.ligand_file_type as string | undefined,
        (input.num_poses as number) || 10,
      );
      // DiffDock returns poses in various formats; write each pose as a separate SDF
      const poses = result.poses || result.ligand_positions || (Array.isArray(result) ? result : null);
      if (poses && Array.isArray(poses)) {
        const paths: string[] = [];
        for (let i = 0; i < poses.length; i++) {
          const poseContent = typeof poses[i] === "string" ? poses[i] : (poses[i].sdf || poses[i].structure || JSON.stringify(poses[i]));
          const posePath = nvidiaOutputPath(sessionWorkspace, `diffdock_pose${i + 1}`, "sdf");
          fs.writeFileSync(posePath, poseContent);
          paths.push(posePath);
        }
        return { output: `DiffDock generated ${paths.length} poses:\n${paths.join("\n")}`, success: true };
      }
      // Fallback: write raw result
      const outPath = nvidiaOutputPath(sessionWorkspace, "diffdock", "json");
      fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
      return { output: `DiffDock result saved to ${outPath}`, success: true };
    } catch (err: any) {
      return { output: `DiffDock error: ${err.message}`, success: false };
    }
  }

  case "nvidia_colabfold_msa": {
    try {
      const token = await getNvidiaApiKey(sessionId);
      const result = await msaSearchColabFold(token, input.sequence as string);
      // Extract alignment text from nested response
      // API returns: { alignments: { "Uniref30_2302": { a3m: { alignment: "..." } } } }
      let msaText: string | null = null;
      if (result.alignments) {
        const keys = Object.keys(result.alignments);
        for (const key of keys) {
          const entry = result.alignments[key];
          // Handle nested a3m object: { a3m: { alignment: "..." } }
          if (entry?.a3m?.alignment) {
            msaText = entry.a3m.alignment;
            break;
          }
          // Handle flat alignment: { alignment: "..." }
          if (entry?.alignment && typeof entry.alignment === "string") {
            msaText = entry.alignment;
            break;
          }
        }
      }
      if (!msaText && typeof result.structure === "string") {
        msaText = result.structure; // raw A3M text
      }
      if (!msaText && result.raw_response) {
        msaText = result.raw_response;
      }
      if (!msaText) return { output: `ColabFold MSA returned unexpected format: ${JSON.stringify(result).slice(0, 500)}`, success: false };
      const outPath = nvidiaOutputPath(sessionWorkspace, "colabfold_msa", "a3m");
      fs.writeFileSync(outPath, msaText);
      const seqCount = (msaText.match(/^>/gm) || []).length;
      return { output: `ColabFold MSA saved to ${outPath} (${seqCount} sequences)`, success: true };
    } catch (err: any) {
      return { output: `ColabFold MSA error: ${err.message}`, success: false };
    }
  }

  case "nvidia_proteinmpnn": {
    try {
      const token = await getNvidiaApiKey(sessionId);
      const pdbPath = safeResolvePath(input.input_pdb_path as string, sessionWorkspace);
      if (!pdbPath) return { output: "Access denied: PDB path outside workspace", success: false };
      if (!fs.existsSync(pdbPath)) return { output: `Input PDB not found: ${pdbPath}`, success: false };
      const pdbContent = fs.readFileSync(pdbPath, "utf-8");
      const result = await designProteinSequenceMPNN(token, pdbContent, {
        input_pdb_chains: input.input_pdb_chains as string[] | undefined,
        ca_only: input.ca_only as boolean | undefined,
        use_soluble_model: input.use_soluble_model as boolean | undefined,
        random_seed: input.random_seed as number | undefined,
        num_seq_per_target: input.num_seq_per_target as number | undefined,
        sampling_temp: input.sampling_temp as number[] | undefined,
        fixed_positions_jsonl: input.fixed_positions_jsonl as string | undefined,
        omit_AAs: input.omit_AAs as string[] | undefined,
        omit_AA_jsonl: input.omit_AA_jsonl as string | undefined,
        bias_AA_jsonl: input.bias_AA_jsonl as string | undefined,
        bias_by_res_jsonl: input.bias_by_res_jsonl as string | undefined,
        tied_positions_jsonl: input.tied_positions_jsonl as string | undefined,
        pssm_jsonl: input.pssm_jsonl as string | undefined,
        pssm_multi: input.pssm_multi as number | undefined,
        pssm_threshold: input.pssm_threshold as number | undefined,
        pssm_bias_flag: input.pssm_bias_flag as boolean | undefined,
        pssm_log_odds_flag: input.pssm_log_odds_flag as boolean | undefined,
      });
      if (result.raw_fasta) {
        const outPath = nvidiaOutputPath(sessionWorkspace, "proteinmpnn", "fasta");
        fs.writeFileSync(outPath, result.raw_fasta);
        const seqSummary = result.sequences?.map((s: any, i: number) =>
          `Seq ${i + 1}: score=${s.score.toFixed(3)}, global_score=${s.global_score.toFixed(3)}${s.seq_recovery != null ? `, recovery=${s.seq_recovery.toFixed(3)}` : ""}`
        ).join("\n") || "";
        return { output: `ProteinMPNN designed ${result.sequences?.length || 0} sequences, saved to ${outPath}\n${seqSummary}`, success: true };
      }
      return { output: `ProteinMPNN result: ${JSON.stringify(result).slice(0, 500)}`, success: true };
    } catch (err: any) {
      return { output: `ProteinMPNN error: ${err.message}`, success: false };
    }
  }

  case "nvidia_genmol": {
    try {
      const token = await getNvidiaApiKey(sessionId);
      const result = await generateMoleculesGenMol(
        token,
        input.smiles as string,
        (input.num_molecules as number) || 30,
        (input.temperature as number) || 1.0,
        0.0,
        1,
        (input.scoring as "QED" | "LogP") || "QED",
      );
      const mols = result.molecules || [];
      if (Array.isArray(mols) && mols.length > 0) {
        const summary = mols.slice(0, 10).map((m: any, i: number) =>
          `${i + 1}. ${m.smiles || m.sample || m} (score: ${m.score ?? "N/A"})`
        ).join("\n");
        return { output: `GenMol generated ${mols.length} molecules:\n${summary}${mols.length > 10 ? `\n... and ${mols.length - 10} more` : ""}`, success: true };
      }
      return { output: `GenMol result: ${JSON.stringify(result).slice(0, 500)}`, success: true };
    } catch (err: any) {
      return { output: `GenMol error: ${err.message}`, success: false };
    }
  }

  case "nvidia_molmim": {
    try {
      const token = await getNvidiaApiKey(sessionId);
      const result = await generateMoleculesMolMIM(
        token,
        input.smiles as string,
        (input.num_molecules as number) || 10,
        (input.algorithm as string) || "CMA-ES",
        (input.property_name as string) || "QED",
        (input.iterations as number) || 10,
      );
      const mols = result.molecules || [];
      if (Array.isArray(mols) && mols.length > 0) {
        const summary = mols.slice(0, 10).map((m: any, i: number) =>
          `${i + 1}. ${m.smiles} (score: ${m.score ?? "N/A"})`
        ).join("\n");
        return { output: `MolMIM generated ${mols.length} molecules (scoring: ${result.scoreType || "N/A"}):\n${summary}${mols.length > 10 ? `\n... and ${mols.length - 10} more` : ""}`, success: true };
      }
      return { output: `MolMIM result: ${JSON.stringify(result).slice(0, 500)}`, success: true };
    } catch (err: any) {
      return { output: `MolMIM error: ${err.message}`, success: false };
    }
  }

  case "nvidia_evo2": {
    try {
      const token = await getNvidiaApiKey(sessionId);
      const result = await generateSequenceEvo2(
        token,
        input.sequence as string,
        (input.num_tokens as number) || 100,
        (input.top_k as number) || 3,
        0.0,
        (input.temperature as number) || 0.7,
      );
      if (result.sequence) {
        return { output: `Evo2 generated sequence (${result.sequence.length} bp):\n${result.sequence.slice(0, 500)}${result.sequence.length > 500 ? "..." : ""}`, success: true };
      }
      return { output: `Evo2 result: ${JSON.stringify(result).slice(0, 500)}`, success: true };
    } catch (err: any) {
      return { output: `Evo2 error: ${err.message}`, success: false };
    }
  }

    default:
      return { output: `Unknown NVIDIA capability: ${name}`, success: false };
  }
}

export const nvidiaDirectProvider: ComputeProvider = {
  id: "nvidia-direct",
  label: "NVIDIA BioNeMo NIM (your key)",
  kind: "direct",
  capabilities: () => NVIDIA_CAPABILITIES,
  async availability({ userId }) {
    const key = await getUserNvidiaApiKey(userId).catch(() => "");
    return key
      ? { ok: true }
      : { ok: false, reason: "NVIDIA API key is not set. Configure it in Settings > API (https://build.nvidia.com/)." };
  },
  async submit(request: ComputeRequest): Promise<ProviderJob> {
    const result = await execute(request.capability, request.inputs, request.sessionWorkspace, request.sessionId);
    const artifacts = Array.from(result.output.matchAll(/saved to (\S+)/g)).map((m) => m[1]);
    return terminalJob(this.id, request.capability, { ...result, artifacts });
  },
  async getJob() { return null; },
  async cancel() {},
};
