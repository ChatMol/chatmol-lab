"use client";

import { useEffect, useRef, useState, Component, type ReactNode } from "react";
import { buildSelectionContext, type SelectedResidue, type StructureSelectionContext } from "@/lib/structure-selection";

// Minimal typings for the pieces of the Mol* viewer bundle we touch. The full
// API is exposed on window.molstar.lib (see molstar/src/apps/viewer/lib.ts).
/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window {
    molstar?: {
      Viewer: {
        create: (
          element: HTMLElement,
          options?: Record<string, unknown>
        ) => Promise<MolstarViewerInstance>;
      };
      lib?: {
        structure?: {
          Structure?: { eachAtomicHierarchyElement?: (structure: any, callbacks: { residue?: (loc: any) => void }) => void };
          StructureElement?: {
            Loci?: { is?: (loci: any) => boolean; getFirstLocation?: (loci: any, loc?: any) => any };
            Location?: { create?: () => any };
          };
          StructureProperties?: {
            residue: { auth_seq_id: (loc: any) => number; label_seq_id: (loc: any) => number; pdbx_PDB_ins_code: (loc: any) => string };
            atom: { label_comp_id: (loc: any) => string };
            chain: { auth_asym_id: (loc: any) => string; label_asym_id: (loc: any) => string };
          };
        };
      };
    };
  }
}

interface MolstarViewerInstance {
  loadStructureFromData: (
    data: string,
    format: string,
    options?: Record<string, unknown>
  ) => Promise<void>;
  dispose: () => void;
  plugin?: any;
}

interface MolstarViewerProps {
  data: string;
  format: "pdb" | "cif" | "mmcif";
  filename?: string;
  /** Fired when the user's residue selection (or clicked residue) changes. */
  onSelectionChange?: (context: StructureSelectionContext | null) => void;
}

// Pinned: selection APIs are read from window.molstar.lib, which is stable
// within a major version but not guaranteed across @latest bumps.
const MOLSTAR_VERSION = "5.11.0";
const CDN_BASE = `https://cdn.jsdelivr.net/npm/molstar@${MOLSTAR_VERSION}/build/viewer`;

let cdnLoadPromise: Promise<void> | null = null;

function loadMolstarCDN(): Promise<void> {
  if (window.molstar?.Viewer) return Promise.resolve();
  if (cdnLoadPromise) return cdnLoadPromise;

  cdnLoadPromise = new Promise((resolve, reject) => {
    // Inject CSS if not present
    if (!document.getElementById("molstar-css")) {
      const link = document.createElement("link");
      link.id = "molstar-css";
      link.rel = "stylesheet";
      link.href = `${CDN_BASE}/molstar.css`;
      document.head.appendChild(link);
    }

    // Inject JS if not present
    if (!document.getElementById("molstar-js")) {
      const script = document.createElement("script");
      script.id = "molstar-js";
      script.src = `${CDN_BASE}/molstar.js`;
      script.onload = () => {
        // Wait for molstar to be available on window
        const check = (attempts: number) => {
          if (window.molstar?.Viewer) {
            resolve();
          } else if (attempts > 50) {
            reject(new Error("Molstar loaded but Viewer not available"));
          } else {
            setTimeout(() => check(attempts + 1), 100);
          }
        };
        check(0);
      };
      script.onerror = () => {
        cdnLoadPromise = null;
        document.getElementById("molstar-js")?.remove();
        reject(new Error("Failed to load Molstar from CDN"));
      };
      document.head.appendChild(script);
    } else {
      // Script tag exists but molstar not ready yet — poll
      const check = (attempts: number) => {
        if (window.molstar?.Viewer) {
          resolve();
        } else if (attempts > 100) {
          reject(new Error("Molstar script present but Viewer not available"));
        } else {
          setTimeout(() => check(attempts + 1), 100);
        }
      };
      check(0);
    }
  });

  cdnLoadPromise.catch(() => { cdnLoadPromise = null; });
  return cdnLoadPromise;
}

const FORMAT_MAP: Record<string, string> = {
  pdb: "pdb",
  cif: "mmcif",
  mmcif: "mmcif",
};

const VIEWER_CONFIG = {
  layoutIsExpanded: false,
  layoutShowControls: false,
  layoutShowRemoteState: false,
  layoutShowSequence: true,
  layoutShowLog: false,
  layoutShowLeftPanel: false,
  viewportShowExpand: false,
  // Selection mode toggle lets users click residues in 3D; the sequence
  // panel selects on click regardless.
  viewportShowSelectionMode: true,
  viewportShowAnimation: false,
  viewportShowSettings: false,
  viewportShowControls: false,
  viewportShowTrajectoryControls: false,
  backgroundColor: 0x151719 as unknown as number,
  renderer: { backgroundColor: 0x151719 },
};

// ChatMol look: soft chain palette on a near-black ground with outlines and
// ambient occlusion, no waters, no axes widget.
const CANVAS_BACKGROUND = 0x151719;
const SELECT_COLOR = 0xf3d76c;
const HIGHLIGHT_COLOR = 0xffedb3;
const CHAIN_PALETTE = [0x5ab8a5, 0x7fa6d9, 0xd9a66b, 0xc77dba, 0x8fbf6a, 0xe08a8a, 0x9fb3c8, 0xd6c46b];

async function applyChatmolLook(plugin: any): Promise<void> {
  try {
    const canvas = plugin?.canvas3d;
    if (canvas?.props) {
      const cur = canvas.props;
      canvas.setProps({
        renderer: { ...cur.renderer, backgroundColor: CANVAS_BACKGROUND, selectColor: SELECT_COLOR, highlightColor: HIGHLIGHT_COLOR },
        camera: { ...cur.camera, helper: { ...(cur.camera?.helper || {}), axes: { name: "off", params: {} } } },
        postprocessing: {
          ...cur.postprocessing,
          outline: { name: "on", params: { ...(cur.postprocessing?.outline?.params || {}), scale: 1, threshold: 0.33, color: 0x000000, includeTransparent: true } },
          occlusion: { name: "on", params: { ...(cur.postprocessing?.occlusion?.params || {}) } },
        },
      });
    }
  } catch {
    // cosmetic only
  }
  try {
    const structures = plugin?.managers?.structure?.hierarchy?.current?.structures || [];
    const water: any[] = [];
    const polymer: any[] = [];
    for (const structure of structures) {
      for (const component of structure.components || []) {
        if (/water/.test(component.key || "")) water.push(component);
        else if (/polymer/.test(component.key || "")) polymer.push(component);
      }
    }
    if (water.length > 0) await plugin.managers.structure.hierarchy.remove(water);
    if (polymer.length > 0) {
      await plugin.managers.structure.component.updateRepresentationsTheme(polymer, {
        color: "chain-id",
        colorParams: { palette: { name: "colors", params: { list: { kind: "set", colors: CHAIN_PALETTE } } } },
      });
    }
  } catch {
    // representation tweaks are best-effort
  }
}

// Height of the sequence strip shown under the 3D canvas.
const SEQUENCE_STRIP_PX = 96;
const SEQUENCE_STYLE_ID = "chatmol-molstar-sequence-css";

/**
 * Mol*'s built-in sequence view lives in the layout's "top" region and is
 * hidden together with the other controls. We show only that region, move
 * it under the canvas, and shrink its type so it reads as a strip.
 */
function injectSequenceStripCss(): void {
  if (document.getElementById(SEQUENCE_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = SEQUENCE_STYLE_ID;
  style.textContent = `
    .chatmol-molstar .msp-layout-region.msp-layout-top {
      top: auto !important; bottom: 0 !important; height: ${SEQUENCE_STRIP_PX}px !important;
      border-top: 1px solid #2f353c; background: #1b1f24 !important; color: #cbd4e2;
    }
    .chatmol-molstar .msp-layout-region.msp-layout-main { top: 0 !important; bottom: ${SEQUENCE_STRIP_PX}px !important; }
    .chatmol-molstar .msp-sequence { background: #1b1f24 !important; font-family: "JetBrains Mono", ui-monospace, Menlo, monospace !important; }
    .chatmol-molstar .msp-sequence-select { background: #20252b !important; min-height: 28px; padding: 3px 8px; }
    .chatmol-molstar .msp-sequence-select > span, .chatmol-molstar .msp-sequence-select select {
      font-size: 10px !important; color: #a5b0c0 !important; line-height: 20px;
    }
    .chatmol-molstar .msp-sequence-select select { background-color: #2b323d !important; border: 1px solid #3b4553; border-radius: 4px; max-width: 150px; }
    .chatmol-molstar .msp-sequence-wrapper-non-empty { background: #1b1f24 !important; top: 30px !important; font-size: 11px !important; line-height: 1.9 !important; padding: 4px 8px 6px; color: #dfe5ec !important; }
    .chatmol-molstar .msp-sequence-wrapper { font-size: 11px !important; line-height: 1.9 !important; color: #dfe5ec !important; }
    .chatmol-molstar .msp-sequence-wrapper > span[data-seqid] { letter-spacing: 1px; color: #dfe5ec; border-radius: 2px; }
    .chatmol-molstar .msp-sequence-wrapper > span[data-seqid][style*="background"] { color: #14181c !important; font-weight: 600; }
    .chatmol-molstar .msp-sequence-chain-label { font-size: 10px; color: #adbbcf; }
    .chatmol-molstar .msp-sequence-number { color: #8a97a8 !important; font-size: 9px; }
    .chatmol-molstar .msp-sequence-missing { color: #56616e !important; }
    /* Selection toolbar (top of the canvas): dark, compact */
    .chatmol-molstar .msp-selection-viewport-controls { background: transparent; }
    .chatmol-molstar .msp-selection-viewport-controls .msp-flex-row > * ,
    .chatmol-molstar .msp-selection-viewport-controls .msp-btn,
    .chatmol-molstar .msp-selection-viewport-controls select {
      background: rgba(27, 31, 36, 0.9) !important; color: #cbd4e2 !important; border-color: #2f353c !important; font-size: 11px !important;
    }
    .chatmol-molstar .msp-selection-viewport-controls .msp-btn:hover { background: rgba(200, 168, 78, 0.25) !important; color: #fff !important; }
    .chatmol-molstar .msp-selection-viewport-controls .msp-btn.msp-btn-action.msp-btn-action-primary,
    .chatmol-molstar .msp-selection-viewport-controls .msp-btn[style*="background"] { background: rgba(200, 168, 78, 0.35) !important; }
    .chatmol-molstar .msp-viewport-controls, .chatmol-molstar .msp-animation-viewport-controls { display: none !important; }
  `;
  document.head.appendChild(style);
}

/** Show the sequence region only, in residue-selection mode. */
function configureViewerLayout(plugin: any): void {
  try {
    plugin.layout?.setProps?.({
      showControls: true,
      regionState: { top: "full", left: "hidden", right: "hidden", bottom: "hidden" },
    });
    plugin.layout?.events?.updated?.next?.();
  } catch {
    // Older layouts may lack setProps; the viewer still works without the strip.
  }
  try {
    plugin.selectionMode = true;
    plugin.managers?.interactivity?.setProps?.({ granularity: "residue" });
  } catch {
    // ignore
  }
}

// --- Selection extraction -------------------------------------------------

function residueFromLocation(loc: any): SelectedResidue | null {
  const props = window.molstar?.lib?.structure?.StructureProperties;
  if (!props || !loc) return null;
  try {
    const seq = props.residue.auth_seq_id(loc);
    if (typeof seq !== "number" || !Number.isFinite(seq)) return null;
    const ins = props.residue.pdbx_PDB_ins_code(loc);
    return {
      chain: props.chain.auth_asym_id(loc) || props.chain.label_asym_id(loc) || "?",
      seq,
      comp: props.atom.label_comp_id(loc) || "UNK",
      ...(ins ? { insCode: ins } : {}),
    };
  } catch {
    return null;
  }
}

/** Residues in the current Mol* selection (all structures). */
function readSelectedResidues(plugin: any): { residues: SelectedResidue[]; atomCount: number } {
  const residues: SelectedResidue[] = [];
  let atomCount = 0;
  const Structure = window.molstar?.lib?.structure?.Structure;
  const entries = plugin?.managers?.structure?.selection?.entries;
  if (!Structure?.eachAtomicHierarchyElement || !entries) return { residues, atomCount };
  for (const entry of entries.values()) {
    const structure = entry?.structure;
    if (!structure || structure.elementCount === 0) continue;
    atomCount += structure.elementCount || 0;
    try {
      Structure.eachAtomicHierarchyElement(structure, {
        residue: (loc: any) => {
          const r = residueFromLocation(loc);
          if (r) residues.push(r);
        },
      });
    } catch {
      // A structure may be mid-update; skip it.
    }
  }
  return { residues, atomCount };
}

/** The residue under a click (used when nothing is selected). */
function readClickedResidue(loci: any): SelectedResidue | null {
  const SE = window.molstar?.lib?.structure?.StructureElement;
  if (!SE?.Loci?.is?.(loci) || !SE.Location?.create || !SE.Loci.getFirstLocation) return null;
  try {
    const loc = SE.Location.create();
    SE.Loci.getFirstLocation(loci, loc);
    return residueFromLocation(loc);
  } catch {
    return null;
  }
}

// Error boundary to prevent Molstar crashes from taking down the app
class MolstarErrorBoundary extends Component<
  { children: ReactNode; onRetry: () => void },
  { hasError: boolean; error: string }
> {
  constructor(props: { children: ReactNode; onRetry: () => void }) {
    super(props);
    this.state = { hasError: false, error: "" };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error: error.message || "Viewer crashed" };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex items-center justify-center h-full bg-bg-primary text-text-secondary">
          <div className="text-center p-4">
            <div className="text-error mb-2">Structure viewer crashed</div>
            <div className="text-sm text-text-muted max-w-xs">{this.state.error}</div>
            <button
              onClick={() => {
                this.setState({ hasError: false, error: "" });
                this.props.onRetry();
              }}
              className="mt-3 px-4 py-1.5 bg-bg-tertiary border border-border rounded text-sm hover:bg-bg-hover transition-colors"
            >
              Retry
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function MolstarViewerInner({ data, format, filename, onSelectionChange }: MolstarViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<MolstarViewerInstance | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Keep the latest callback/filename in refs so subscriptions never go stale.
  const onSelectionRef = useRef(onSelectionChange);
  onSelectionRef.current = onSelectionChange;
  const filenameRef = useRef(filename);
  filenameRef.current = filename;
  const lastSignatureRef = useRef<string>("");

  // Effect 1: Initialize viewer (runs once on mount)
  useEffect(() => {
    let disposed = false;
    const subscriptions: Array<{ unsubscribe: () => void }> = [];

    const emit = (residues: SelectedResidue[], atomCount?: number) => {
      const ctx = buildSelectionContext(filenameRef.current || "structure", residues, { atomCount });
      const signature = ctx ? ctx.ranges.join(",") + "|" + ctx.file : "";
      if (signature === lastSignatureRef.current) return;
      lastSignatureRef.current = signature;
      onSelectionRef.current?.(ctx);
    };

    async function init() {
      if (!containerRef.current) return;

      try {
        setLoading(true);
        setError(null);

        await loadMolstarCDN();

        if (disposed || !containerRef.current) return;

        const viewer = await window.molstar!.Viewer.create(
          containerRef.current,
          VIEWER_CONFIG
        );

        if (disposed) {
          viewer.dispose();
          return;
        }

        // Set background color to match app theme
        try {
          const renderer = viewer.plugin?.canvas3d?.props?.renderer;
          if (renderer) {
            viewer.plugin.canvas3d.setProps({
              renderer: { ...renderer, backgroundColor: { r: 0.141, g: 0.141, b: 0.141 } },
            });
          }
        } catch {}

        // Selection → chat context. Selection changes (sequence panel,
        // selection mode, ctrl/shift-click) win; a plain click on a residue
        // is reported when nothing is selected.
        try {
          const plugin = viewer.plugin;
          const selectionChanged = plugin?.managers?.structure?.selection?.events?.changed;
          if (selectionChanged?.subscribe) {
            subscriptions.push(selectionChanged.subscribe(() => {
              const { residues, atomCount } = readSelectedResidues(plugin);
              if (residues.length > 0) emit(residues, atomCount);
              else emit([]);
            }));
          }
          const click = plugin?.behaviors?.interaction?.click;
          if (click?.subscribe) {
            subscriptions.push(click.subscribe((event: any) => {
              const { residues, atomCount } = readSelectedResidues(plugin);
              if (residues.length > 0) {
                emit(residues, atomCount);
                return;
              }
              const clicked = readClickedResidue(event?.current?.loci);
              if (clicked) emit([clicked]);
            }));
          }
        } catch {
          // Selection export is best-effort; the viewer still works without it.
        }

        injectSequenceStripCss();
        viewerRef.current = viewer;
        setInitialized(true);
      } catch (err) {
        if (!disposed) {
          setError(
            err instanceof Error
              ? err.message
              : "Failed to initialize structure viewer"
          );
          setLoading(false);
        }
      }
    }

    init();

    return () => {
      disposed = true;
      for (const sub of subscriptions) {
        try { sub.unsubscribe(); } catch {}
      }
      if (viewerRef.current) {
        try {
          viewerRef.current.dispose();
        } catch {}
        viewerRef.current = null;
      }
      setInitialized(false);
      lastSignatureRef.current = "";
      onSelectionRef.current?.(null);
    };
  }, []);

  // Effect 2: Load structure data when data/format changes or viewer becomes ready
  useEffect(() => {
    if (!initialized || !viewerRef.current || !data) return;

    let cancelled = false;

    async function loadData() {
      try {
        setLoading(true);
        const fmt = FORMAT_MAP[format] || "pdb";
        await viewerRef.current!.loadStructureFromData(data, fmt, {
          dataLabel: filename || "structure",
        });
        // A new structure invalidates the previous selection context.
        lastSignatureRef.current = "";
        onSelectionRef.current?.(null);
        // The React layout mounts asynchronously; apply after it settles so
        // the sequence strip and residue selection mode take effect.
        const plugin = viewerRef.current?.plugin;
        configureViewerLayout(plugin);
        await applyChatmolLook(plugin);
        setTimeout(() => { if (!cancelled) configureViewerLayout(plugin); }, 300);
        if (!cancelled) {
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error
              ? err.message
              : "Failed to load structure data"
          );
          setLoading(false);
        }
      }
    }

    loadData();

    return () => {
      cancelled = true;
    };
  }, [initialized, data, format, filename]);

  if (error) {
    return (
      <div className="flex items-center justify-center h-full bg-bg-primary text-text-secondary">
        <div className="text-center p-4">
          <div className="text-error mb-2">Failed to load structure</div>
          <div className="text-sm text-text-muted max-w-xs">{error}</div>
          <button
            onClick={() => {
              setError(null);
              setInitialized(false);
              setLoading(true);
              if (viewerRef.current) {
                try {
                  viewerRef.current.dispose();
                } catch {}
                viewerRef.current = null;
              }
            }}
            className="mt-3 px-4 py-1.5 bg-bg-tertiary border border-border rounded text-sm hover:bg-bg-hover transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative w-full h-full">
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-bg-primary z-10">
          <div className="flex items-center gap-2 text-text-secondary">
            <div className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
            <span className="text-sm">Loading structure...</span>
          </div>
        </div>
      )}
      <div ref={containerRef} className="chatmol-molstar w-full h-full" />
    </div>
  );
}

export default function MolstarViewer(props: MolstarViewerProps) {
  const [key, setKey] = useState(0);

  return (
    <MolstarErrorBoundary onRetry={() => setKey((k) => k + 1)}>
      <MolstarViewerInner key={key} {...props} />
    </MolstarErrorBoundary>
  );
}
