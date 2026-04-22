import { useCallback, useEffect, useState } from "react";
import { Activity, RefreshCw } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { api, type AdminJobRow, type GenerationEvent } from "@/lib/api";

function formatRelativeFromIso(iso: string | null | undefined): string {
  if (!iso || !iso.trim()) return "—";
  const t = new Date(iso.trim()).getTime();
  if (Number.isNaN(t)) return "—";
  const diffMin = Math.round((t - Date.now()) / 60_000);
  if (diffMin === 0) return "now";
  if (diffMin > 0) return `in ${diffMin} min`;
  const ago = Math.abs(diffMin);
  return `${ago} min ago`;
}

function shortId(s: string | undefined, head = 8, tail = 4) {
  if (!s) return "—";
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

function jobStatusClass(status: string) {
  const u = status.toLowerCase();
  if (u === "running") return "bg-indigo-400/10 text-indigo-400 ring-indigo-400/30 shadow-[0_0_8px_rgba(129,140,248,0.2)]";
  if (u === "failed") return "bg-red-400/10 text-red-400 ring-red-400/30";
  if (u === "stopped") return "bg-zinc-500/10 text-zinc-400 ring-zinc-500/25";
  return "bg-zinc-400/10 text-zinc-400 ring-zinc-400/20";
}

function genOkClass(ok: boolean | undefined) {
  if (ok === true) return "bg-emerald-400/10 text-emerald-400 ring-emerald-400/30";
  if (ok === false) return "bg-red-400/10 text-red-400 ring-red-400/30";
  return "bg-zinc-400/10 text-zinc-400 ring-zinc-400/20";
}

export function JobsPage() {
  const [jobs, setJobs] = useState<AdminJobRow[]>([]);
  const [generations, setGenerations] = useState<GenerationEvent[]>([]);
  const [meta, setMeta] = useState<{ redis: { configured: boolean; connected: boolean } } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const [j, g] = await Promise.all([api.getJobs(), api.getGenerations(40, 0)]);
      setJobs(j.jobs || []);
      setGenerations(g.generations || []);
      setMeta({ redis: g.redis });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Background Jobs</h1>
          <p className="text-muted-foreground mt-1">
            Monitor scheduled tasks, automated cookie rotation, and recent generation requests.
          </p>
          {meta && (
            <p className="text-xs text-muted-foreground mt-2">
              Redis:{" "}
              {meta.redis.configured
                ? meta.redis.connected
                  ? "connected (job ticks + generation history prefer Redis)"
                  : "configured but offline (ticks + history fall back to this process / disk)"
                : "not configured (ticks in-memory; generations append to profiles/_generation_history.jsonl)"}
            </p>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading} className="shrink-0 gap-2">
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {error && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">{error}</div>
      )}

      <Card className="border-border/50 shadow-sm bg-card/50 backdrop-blur-sm">
        <CardHeader className="bg-white/[0.02]">
          <CardTitle className="flex items-center gap-2">
            <Activity className="h-5 w-5 text-primary" />
            Active Tasks
          </CardTitle>
          <CardDescription>Live status from the API (env, Redis probe loop, last cookie persist).</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader className="bg-white/[0.02]">
              <TableRow className="border-border/50 hover:bg-transparent">
                <TableHead className="pl-6">Job ID</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Next run</TableHead>
                <TableHead className="text-right pr-6">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(loading && jobs.length === 0 ? [] : jobs).map((job) => (
                <TableRow key={job.id} className="border-border/50 hover:bg-white/[0.04] transition-colors group">
                  <TableCell className="font-medium font-mono text-[13px] text-muted-foreground pl-6">{job.id}</TableCell>
                  <TableCell className="font-medium">{job.type}</TableCell>
                  <TableCell>
                    <span
                      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${jobStatusClass(job.status)}`}
                    >
                      {job.status.toLowerCase() === "running" && (
                        <span className="mr-1.5 h-1.5 w-1.5 rounded-full bg-indigo-400 animate-pulse" />
                      )}
                      {job.status}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">{formatRelativeFromIso(job.nextRunAt)}</TableCell>
                  <TableCell className="text-right pr-6">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-xs text-muted-foreground"
                      disabled
                      title="Cookie rotation and health checks are controlled by server env (GEMINI_AUTO_ROTATE, GEMINI_HEALTH_CHECK_INTERVAL_SECONDS)."
                    >
                      Server-managed
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {loading && jobs.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-muted-foreground text-sm">
                    Loading…
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card className="border-border/50 shadow-sm bg-card/50 backdrop-blur-sm">
        <CardHeader className="bg-white/[0.02]">
          <CardTitle className="text-lg">Recent generations</CardTitle>
          <CardDescription>
            Each POST /v1/generate receives a <span className="font-mono text-[13px]">requestId</span> in the JSON
            response; failures and successes are logged with the profile that served the request.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <TableHeader className="bg-white/[0.02]">
              <TableRow className="border-border/50 hover:bg-transparent">
                <TableHead className="pl-6 min-w-[140px]">Request ID</TableHead>
                <TableHead>Profile</TableHead>
                <TableHead>Result</TableHead>
                <TableHead>HTTP</TableHead>
                <TableHead>Model</TableHead>
                <TableHead className="min-w-[160px]">When</TableHead>
                <TableHead className="pr-6 min-w-[220px]">Error</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(loading && generations.length === 0 ? [] : generations).map((g, i) => (
                <TableRow key={`${g.requestId || "row"}-${i}`} className="border-border/50 hover:bg-white/[0.04]">
                  <TableCell className="font-mono text-[12px] text-muted-foreground pl-6" title={g.requestId}>
                    {shortId(g.requestId)}
                  </TableCell>
                  <TableCell className="font-medium text-sm">{g.profile || "—"}</TableCell>
                  <TableCell>
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${genOkClass(g.ok)}`}
                    >
                      {g.ok === true ? "ok" : g.ok === false ? "fail" : "?"}
                    </span>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{g.httpStatus ?? "—"}</TableCell>
                  <TableCell className="text-sm text-muted-foreground font-mono text-[12px]">{g.model || "—"}</TableCell>
                  <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                    {g.recordedAt ? formatRelativeFromIso(g.recordedAt) : "—"}
                  </TableCell>
                  <TableCell className="text-sm text-red-300/90 pr-6 max-w-[320px] truncate" title={g.error}>
                    {g.error || ""}
                  </TableCell>
                </TableRow>
              ))}
              {loading && generations.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-muted-foreground text-sm">
                    Loading…
                  </TableCell>
                </TableRow>
              )}
              {!loading && generations.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-muted-foreground text-sm">
                    No generation events yet. Call POST /v1/generate (response includes requestId).
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
