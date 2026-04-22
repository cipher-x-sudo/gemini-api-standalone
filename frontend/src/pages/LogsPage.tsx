import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal, Pause, Play, RefreshCw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { api, getAdminKey, type LogLine } from "@/lib/api";

function levelClass(level: string): string {
  const u = level.toUpperCase();
  if (u === "DEBUG") return "text-zinc-500";
  if (u === "INFO") return "text-sky-400";
  if (u === "WARNING" || u === "WARN") return "text-amber-400";
  if (u === "ERROR") return "text-red-400";
  if (u === "CRITICAL") return "text-red-500 font-semibold";
  return "text-muted-foreground";
}

export function LogsPage() {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [meta, setMeta] = useState<{ bufferMax: number; totalInBuffer: number } | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);

  const load = useCallback(async () => {
    if (!getAdminKey()) {
      setLoading(false);
      setError("Set your Admin API Key in Settings to view logs.");
      setLines([]);
      setMeta(null);
      return;
    }
    try {
      const res = await api.getLogs(1200);
      setLines(res.lines || []);
      setMeta({ bufferMax: res.bufferMax, totalInBuffer: res.totalInBuffer });
      setError(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const onKey = () => load();
    window.addEventListener("apiKeyUpdated", onKey);
    return () => window.removeEventListener("apiKeyUpdated", onKey);
  }, [load]);

  useEffect(() => {
    if (paused) return;
    const id = window.setInterval(() => {
      if (getAdminKey()) void load();
    }, 2000);
    return () => window.clearInterval(id);
  }, [paused, load]);

  useEffect(() => {
    if (!followRef.current || paused) return;
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines, paused]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    followRef.current = nearBottom;
  };

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">System Logs</h1>
          <p className="text-muted-foreground mt-1">
            Live Python and uvicorn output (ring buffer). Requires admin API key.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {meta && (
            <span className="text-xs text-muted-foreground font-mono">
              {meta.totalInBuffer} / {meta.bufferMax} lines
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPaused((p) => !p)}
            className="gap-1.5"
          >
            {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
            {paused ? "Resume" : "Pause"}
          </Button>
          <Button variant="outline" size="sm" onClick={() => void load()} className="gap-1.5">
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </Button>
        </div>
      </div>

      <Card className="border-border/50 shadow-xl shadow-black/20 bg-card/50 backdrop-blur-sm overflow-hidden flex flex-col min-h-[560px] max-h-[calc(100vh-12rem)] ring-1 ring-white/5">
        <CardHeader className="border-b border-border/50 py-3 bg-black/40 flex flex-row items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <Terminal className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-sm font-medium text-muted-foreground tracking-wider">
              gemini-api-standalone
            </CardTitle>
          </div>
          <div className="flex gap-1.5">
            <div className="h-3 w-3 rounded-full bg-red-500/80 shadow-[0_0_8px_rgba(239,68,68,0.5)]" />
            <div className="h-3 w-3 rounded-full bg-yellow-500/80 shadow-[0_0_8px_rgba(234,179,8,0.5)]" />
            <div className="h-3 w-3 rounded-full bg-emerald-500/80 shadow-[0_0_8px_rgba(16,185,129,0.5)]" />
          </div>
        </CardHeader>
        <CardContent className="p-0 flex-1 flex flex-col min-h-0 bg-[#09090b]">
          {loading && lines.length === 0 && !error && (
            <div className="p-4 text-sm text-muted-foreground font-mono">Loading…</div>
          )}
          {error && (
            <div className="p-4 text-sm text-red-400 font-mono border-b border-border/30">{error}</div>
          )}
          <div
            ref={scrollRef}
            onScroll={onScroll}
            className="flex-1 overflow-y-auto text-[#a1a1aa] font-mono text-[13px] leading-relaxed"
          >
            <div className="p-4 space-y-1">
              {lines.map((line, i) => (
                <div
                  key={`${line.t}-${i}-${line.msg.slice(0, 24)}`}
                  className="flex flex-wrap gap-x-2 gap-y-0.5 hover:bg-white/5 px-2 py-0.5 rounded transition-colors"
                >
                  <span className="text-emerald-400/90 shrink-0 whitespace-nowrap">{line.t}</span>
                  <span className={`shrink-0 ${levelClass(line.level)}`}>[{line.level}]</span>
                  <span className="text-violet-400/90 shrink-0 max-w-[200px] truncate" title={line.logger}>
                    {line.logger}
                  </span>
                  <span className="text-foreground/90 break-all min-w-0">{line.msg}</span>
                </div>
              ))}
              <div ref={bottomRef} />
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
