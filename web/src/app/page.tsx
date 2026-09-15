"use client";

import { useCallback, useState, useEffect, useRef, Suspense } from "react";
import dynamic from "next/dynamic";
import { useSearchParams, useRouter } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
import {
  PanelRightClose,
  PanelRightOpen,
  Plus,
  MessageSquare,
  Settings,
  FlaskConical,
  Trash2,
  Pencil,
  Check,
  X,
  LogIn,
  User as UserIcon,
  Info,
  BarChart3,
  Zap,
  ChevronUp,
  LogOut,
} from "lucide-react";
import ChatPanel from "@/components/ChatPanel";
import ComputeJobsIndicator from "@/components/ComputeJobsIndicator";
import ComputeJobsPoller from "@/components/ComputeJobsPoller";
import SettingsModal from "@/components/SettingsModal";
import DashboardModal from "@/components/DashboardModal";
import HostedEntry from "@/hosted/entry";
import { fetchDeployment, useDeployment } from "@/lib/use-deployment";
import { useAppStore } from "@/lib/store";
import { isElectronClient } from "@/lib/electron";

import ResizeHandle from "@/components/ResizeHandle";

// Dynamic import with SSR disabled — RightPanel contains Molstar which requires browser APIs
const RightPanel = dynamic(() => import("@/components/RightPanel"), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center h-full bg-bg-secondary text-text-muted">
      <div className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
    </div>
  ),
});

function SessionSidebar() {
  const { sessions, activeSessionId, setActiveSession, createSession, deleteSession, renameSession, loadSessions, sessionsLoaded } =
    useAppStore();
  const { data: authSession } = useSession();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const [dashboardOpen, setDashboardOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const deployment = useDeployment();
  const hosted = deployment?.mode === "hosted";
  const accountMenuRef = useRef<HTMLDivElement>(null);

  // Load sessions from DB on mount
  useEffect(() => {
    if (!sessionsLoaded) {
      loadSessions();
    }
  }, [sessionsLoaded, loadSessions]);

  // Close account menu on click outside
  useEffect(() => {
    if (!accountMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (accountMenuRef.current && !accountMenuRef.current.contains(e.target as Node)) {
        setAccountMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [accountMenuOpen]);

  const sortedSessions = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);

  const startRename = (id: string, currentTitle: string) => {
    setEditingId(id);
    setEditTitle(currentTitle);
  };

  const confirmRename = () => {
    if (editingId && editTitle.trim()) {
      renameSession(editingId, editTitle.trim());
    }
    setEditingId(null);
  };

  const handleDelete = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    deleteSession(id);
  };

  return (
    <div className="w-56 flex-shrink-0 flex flex-col bg-bg-primary border-r border-border">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          <FlaskConical className="w-5 h-5 text-accent" />
          <span className="text-sm font-semibold text-text-primary">Chats</span>
        </div>
        <button
          onClick={() => createSession()}
          className="p-1.5 rounded-md bg-bg-tertiary border border-border hover:border-accent-dim text-text-muted hover:text-accent transition-colors"
          title="New chat"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto py-1">
        {sortedSessions.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-text-muted">
            No chats yet
          </div>
        )}
        {sortedSessions.map((session) => (
          <div
            key={session.id}
            onMouseEnter={() => setHoveredId(session.id)}
            onMouseLeave={() => setHoveredId(null)}
            onClick={() => setActiveSession(session.id)}
            className={`group flex items-center gap-2 px-3 py-2 mx-1 rounded-lg cursor-pointer transition-colors ${
              activeSessionId === session.id
                ? "bg-accent/10 text-text-primary"
                : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
            }`}
          >
            <MessageSquare className="w-4 h-4 flex-shrink-0 text-text-muted" />

            {editingId === session.id ? (
              <div className="flex-1 flex items-center gap-1 min-w-0">
                <input
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") confirmRename();
                    if (e.key === "Escape") setEditingId(null);
                  }}
                  onClick={(e) => e.stopPropagation()}
                  className="flex-1 text-xs bg-bg-tertiary border border-border rounded px-1.5 py-0.5 outline-none focus:border-accent min-w-0"
                  autoFocus
                />
                <button
                  onClick={(e) => { e.stopPropagation(); confirmRename(); }}
                  className="p-0.5 text-success hover:text-success"
                >
                  <Check className="w-3 h-3" />
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); setEditingId(null); }}
                  className="p-0.5 text-text-muted hover:text-error"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ) : (
              <>
                <span className="flex-1 text-xs truncate">
                  {session.title}
                </span>

                {(hoveredId === session.id || activeSessionId === session.id) && (
                  <div className="flex items-center gap-0.5 flex-shrink-0">
                    <button
                      onClick={(e) => { e.stopPropagation(); startRename(session.id, session.title); }}
                      className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-tertiary transition-colors"
                      title="Rename"
                    >
                      <Pencil className="w-3 h-3" />
                    </button>
                    <button
                      onClick={(e) => handleDelete(e, session.id)}
                      className="p-1 rounded text-text-muted hover:text-error hover:bg-bg-tertiary transition-colors"
                      title="Delete"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        ))}
      </div>

      {/* Account trigger + popover */}
      <div className="relative px-2 py-2 border-t border-border" ref={accountMenuRef}>
        {/* Popover menu — opens upward */}
        {accountMenuOpen && (
          <div className="absolute bottom-full left-2 right-2 mb-1 bg-bg-secondary border border-border rounded-lg shadow-xl overflow-hidden z-50">
            {/* Secondary items */}
            <div className="py-1">
              <button
                onClick={() => { setAccountMenuOpen(false); setDashboardOpen(true); }}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors"
              >
                <BarChart3 className="w-3.5 h-3.5" />
                <span>Dashboard</span>
              </button>
              <button
                onClick={() => { setAccountMenuOpen(false); setSettingsOpen(true); }}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors"
              >
                <Settings className="w-3.5 h-3.5" />
                <span>Settings</span>
              </button>
              <button
                onClick={() => {
                  setAccountMenuOpen(false);
                  if (isElectronClient()) {
                    (window as { electronAPI?: { openExternal?: (url: string) => void } }).electronAPI?.openExternal?.("https://chatmol.github.io/");
                  } else {
                    setAboutOpen(true);
                  }
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors"
              >
                <Info className="w-3.5 h-3.5" />
                <span>About</span>
              </button>
            </div>
            {/* Sign out — only a hosted account can sign out; the local principal is not an account */}
            {hosted && authSession?.user && (
              <div className="border-t border-border py-1">
                <button
                  onClick={() => { setAccountMenuOpen(false); signOut({ callbackUrl: "/auth/signin" }); }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-red-400 hover:bg-red-500/10 transition-colors"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  <span>Sign out</span>
                </button>
              </div>
            )}
          </div>
        )}

        {/* Account trigger button */}
        {authSession?.user ? (
          <button
            onClick={() => setAccountMenuOpen(!accountMenuOpen)}
            className="w-full flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-bg-hover transition-colors group"
          >
            {authSession.user.image ? (
              <img src={authSession.user.image} alt="" className="w-6 h-6 rounded-full flex-shrink-0" />
            ) : (
              <div className="w-6 h-6 rounded-full bg-accent/20 flex items-center justify-center flex-shrink-0">
                <UserIcon className="w-3.5 h-3.5 text-accent" />
              </div>
            )}
            <div className="flex-1 min-w-0 text-left">
              <div className="text-xs font-medium text-text-primary truncate">
                {authSession.user.name || authSession.user.email}
              </div>
              {!hosted && (
                <div className="text-[10px] text-text-muted">no account needed</div>
              )}
            </div>
            <ChevronUp className={`w-3.5 h-3.5 text-text-muted flex-shrink-0 transition-transform ${accountMenuOpen ? "" : "rotate-180"}`} />
          </button>
        ) : hosted ? (
          <a
            href="/auth/signin"
            className="w-full flex items-center gap-2 px-2 py-2 rounded-lg text-text-muted hover:bg-bg-hover hover:text-text-secondary transition-colors text-xs"
          >
            <LogIn className="w-3.5 h-3.5" />
            <span>Sign in</span>
          </a>
        ) : null}
      </div>
      <DashboardModal open={dashboardOpen} onClose={() => setDashboardOpen(false)} />
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      {aboutOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setAboutOpen(false)}
        >
          <div
            className="relative w-[90vw] h-[85vh] rounded-xl overflow-hidden border border-border shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setAboutOpen(false)}
              className="absolute top-4 right-4 z-10 p-1.5 rounded-md bg-black/50 text-white/70 hover:text-white transition-colors"
              title="Close"
            >
              <X className="w-5 h-5" />
            </button>
            <div className="w-full h-full overflow-y-auto">
              <HostedEntry state="landing" />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const RIGHT_MIN = 300;
const RIGHT_DEFAULT = 480;

function HomeInner() {
  const { status, data: session } = useSession();
  const [userStatus, setUserStatus] = useState<string | null>(null);
  const [entry, setEntry] = useState<"pending" | "hosted">("pending");

  // No account in local mode: mint the local session, then reload. A 404 means
  // this server is the hosted service, which has its own entry flow.
  useEffect(() => {
    if (status !== "unauthenticated") return;
    let cancelled = false;
    (async () => {
      const info = await fetchDeployment();
      if (cancelled) return;
      if (info?.mode === "hosted") { setEntry("hosted"); return; }
      const res = await fetch("/api/auth/desktop-local?format=json", { cache: "no-store" }).catch(() => null);
      if (cancelled) return;
      if (res?.ok) window.location.reload();
      else setEntry("hosted");
    })();
    return () => { cancelled = true; };
  }, [status]);

  useEffect(() => {
    if (status !== "authenticated") {
      setUserStatus(null);
      return;
    }
    fetch("/api/auth/status")
      .then((r) => r.json())
      .then((data) => setUserStatus(data.status ?? "approved"))
      .catch(() => setUserStatus("approved"));
  }, [status]);

  if (status === "loading") {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-bg-primary">
        <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (status === "unauthenticated") {
    if (entry === "hosted") return <HostedEntry state="landing" />;
    // Local mode (desktop app, `npm run dev`): no account. The local session
    // is being minted; show the spinner until the reload.
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-bg-primary">
        <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (userStatus === null) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-bg-primary">
        <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (userStatus === "waitlist") {
    return <HostedEntry state="waitlist" email={session?.user?.email} />;
  }

  return <AppView />;
}

function AppView() {
  const {
    rightPanelOpen,
    sidebarOpen,
    toggleRightPanel,
    toggleSidebar,
    activeSessionId,
    setActiveSession,
    sessions,
    sessionsLoaded,
  } = useAppStore();

  const searchParams = useSearchParams();
  const router = useRouter();

  const [mounted, setMounted] = useState(false);
  const [rightWidth, setRightWidth] = useState(RIGHT_DEFAULT);
  const [windowWidth, setWindowWidth] = useState(1920);

  // On mount: if URL has ?session=<id> and session exists, activate it
  useEffect(() => {
    if (!sessionsLoaded) return;
    const urlSessionId = searchParams.get("session");
    if (urlSessionId && sessions.some((s) => s.id === urlSessionId)) {
      if (urlSessionId !== activeSessionId) {
        setActiveSession(urlSessionId);
      }
    }
  }, [sessionsLoaded]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync URL when activeSessionId changes
  useEffect(() => {
    if (!activeSessionId) return;
    const current = searchParams.get("session");
    if (current !== activeSessionId) {
      router.replace(`/?session=${activeSessionId}`);
    }
  }, [activeSessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setMounted(true);
    setWindowWidth(window.innerWidth);
    const handleResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);


  const rightMax = Math.floor(windowWidth * 0.5);
  const handleRightResize = useCallback((delta: number) => {
    setRightWidth((w) => Math.max(RIGHT_MIN, Math.min(rightMax, w + delta)));
  }, [rightMax]);

  if (!mounted) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-bg-primary">
        <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-bg-primary">
      {/* Session sidebar (collapsible) */}
      {sidebarOpen && <SessionSidebar />}

      {/* Center - Chat */}
      <div className="flex-1 flex flex-col min-w-[300px] relative">
        {/* Panel toggle buttons */}
        <div className="absolute top-2.5 left-2 z-20 flex gap-1">
          <button
            onClick={toggleSidebar}
            className="p-1.5 rounded-md bg-bg-tertiary/80 backdrop-blur border border-border text-text-muted hover:text-text-secondary transition-colors"
            title={sidebarOpen ? "Hide chats" : "Show chats"}
          >
            {sidebarOpen ? (
              <MessageSquare className="w-4 h-4" />
            ) : (
              <MessageSquare className="w-4 h-4" />
            )}
          </button>
        </div>
        <div className="absolute top-2.5 right-2 z-20 flex items-center gap-1">
          <ComputeJobsIndicator />
          <button
            onClick={toggleRightPanel}
            className="p-1.5 rounded-md bg-bg-tertiary/80 backdrop-blur border border-border text-text-muted hover:text-text-secondary transition-colors"
            title={rightPanelOpen ? "Hide panel" : "Show panel"}
          >
            {rightPanelOpen ? (
              <PanelRightClose className="w-4 h-4" />
            ) : (
              <PanelRightOpen className="w-4 h-4" />
            )}
          </button>
        </div>

        <ChatPanel />
      </div>

      {/* Right panel - File Preview + Tools Catalog */}
      {rightPanelOpen && (
        <>
          <ResizeHandle onResize={handleRightResize} side="right" />
          <div style={{ width: rightWidth }} className="flex-shrink-0 h-full">
            <RightPanel />
          </div>
        </>
      )}

      <ComputeJobsPoller />
    </div>
  );
}

export default function Home() {
  return (
    <Suspense
      fallback={
        <div className="flex h-screen w-screen items-center justify-center bg-bg-primary">
          <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
        </div>
      }
    >
      <HomeInner />
    </Suspense>
  );
}
