"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Loader2, Settings as SettingsIcon } from "lucide-react";

import { useAppStore } from "@/lib/store";

interface ModelOption {
  value: string;
  label: string;
}

interface ProviderInfo {
  id: string;
  label: string;
  models?: ModelOption[];
}

interface SettingsSnapshot {
  provider: string;
  providers: ProviderInfo[];
  model: string;
}

/**
 * The model the next message will actually use, next to the send button.
 *
 * It used to read "v4-pro" no matter what was configured, with a chevron that
 * did nothing: the label lied when the user had switched provider, and the
 * chevron promised a picker. Both now tell the truth.
 */
export default function ModelBadge() {
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  const [settings, setSettings] = useState<SettingsSnapshot | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState("");
  // The input bar clips its children, so the menu is positioned against the
  // viewport instead of the button's own stacking context.
  const [anchor, setAnchor] = useState<{ bottom: number; right: number } | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/settings", { cache: "no-store" });
      if (res.ok) setSettings(await res.json());
    } catch {
      // Leave the badge hidden rather than showing a guess.
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  // The Settings dialog is the other place the model changes.
  useEffect(() => { if (!settingsOpen) load(); }, [settingsOpen, load]);

  const place = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) setAnchor({ bottom: window.innerHeight - rect.top + 8, right: window.innerWidth - rect.right });
  }, []);

  useEffect(() => {
    if (!open) return;
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const choose = useCallback(async (model: string) => {
    setSaving(model);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
      });
      // PUT answers with the effective settings but no provider catalog, so
      // re-read instead of dropping the model list and the provider label.
      if (res.ok) await load();
      setOpen(false);
    } catch {
      // Keep the menu open so the user can retry or go to Settings.
    } finally {
      setSaving("");
    }
  }, [load]);

  if (!settings?.model) return null;

  const provider = settings.providers?.find((entry) => entry.id === settings.provider);
  const offered = provider?.models ?? [];
  // A model set by hand (or by env) may not be in the catalog; it still has to
  // be shown, and shown as the current one.
  const known: ModelOption[] = offered.some((option) => option.value === settings.model)
    ? offered
    : [{ value: settings.model, label: `${settings.model} — configured` }, ...offered];

  return (
    <div className="hidden sm:block" ref={popoverRef}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        title={`${provider?.label || settings.provider} · ${settings.model}\nClick to switch model`}
        className="flex max-w-[180px] items-center gap-1 rounded-full px-2.5 py-1 text-xs text-text-muted transition-colors hover:bg-bg-hover hover:text-text-secondary"
      >
        <span className="truncate">{settings.model}</span>
        <ChevronDown className="h-3.5 w-3.5 flex-shrink-0" />
      </button>

      {open && anchor && (
        <div
          style={{ position: "fixed", bottom: anchor.bottom, right: anchor.right }}
          className="z-50 w-64 overflow-hidden rounded-lg border border-border bg-bg-secondary shadow-xl"
        >
          <div className="border-b border-border px-3 py-2 text-[11px] text-text-muted">
            {provider?.label || settings.provider}
          </div>
          <div className="max-h-64 overflow-y-auto py-1">
            {known.map((option) => (
              <button
                key={option.value}
                type="button"
                disabled={Boolean(saving)}
                onClick={() => choose(option.value)}
                title={option.label}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-50"
              >
                {saving === option.value
                  ? <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin" />
                  : option.value === settings.model
                    ? <Check className="h-3.5 w-3.5 flex-shrink-0 text-accent" />
                    : <span className="h-3.5 w-3.5 flex-shrink-0" />}
                <span className="truncate font-mono">{option.value}</span>
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => { setOpen(false); setSettingsOpen(true); }}
            className="flex w-full items-center gap-2 border-t border-border px-3 py-2 text-xs text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
          >
            <SettingsIcon className="h-3.5 w-3.5" />
            Another provider or a custom model id
          </button>
        </div>
      )}
    </div>
  );
}
