import { useCallback, useEffect, useMemo, useState } from "react";
import { FlaskConical, Loader2, Play, RefreshCw, Bug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import {
  api,
  getAdminKey,
  v1Generate,
  v1ListModels,
  type LogLine,
  type V1DebugResult,
} from "@/lib/api";

type ModelRow = { id: string; label: string };

function prettyJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function extractRequestId(res: unknown): string | null {
  if (!res || typeof res !== "object") return null;
  const rid = (res as { requestId?: unknown }).requestId;
  return typeof rid === "string" && rid.trim() ? rid.trim() : null;
}

function filterLogsForRun(lines: LogLine[], profileId: string, requestId: string | null): LogLine[] {
  const p = profileId.trim();
  const tail = lines.slice(-400);
  if (requestId) {
    const hit = tail.filter((l) => l.msg.includes(requestId));
    if (hit.length) return hit.slice(-80);
  }
  const byProfile = tail.filter((l) => p && l.msg.includes(`profile=${p}`));
  return (byProfile.length ? byProfile : tail).slice(-80);
}

export function PlaygroundPage() {
  const { toast } = useToast();
  const [keyTick, setKeyTick] = useState(0);
  const [profiles, setProfiles] = useState<string[]>([]);
  const [profileId, setProfileId] = useState("");
  const [models, setModels] = useState<ModelRow[]>([]);
  const [modelMode, setModelMode] = useState<"random" | "pick" | "custom">("random");
  const [selectedModelId, setSelectedModelId] = useState("");
  const [customModel, setCustomModel] = useState("");
  const [prompt, setPrompt] = useState("Say hello in one short sentence.");
  const [jsonOutput, setJsonOutput] = useState(false);
  const [busy, setBusy] = useState<"idle" | "models" | "gen">("idle");
  const [lastListDebug, setLastListDebug] = useState<V1DebugResult | null>(null);
  const [lastGenDebug, setLastGenDebug] = useState<V1DebugResult | null>(null);
  const [assistantText, setAssistantText] = useState<string | null>(null);
  const [serverLines, setServerLines] = useState<LogLine[]>([]);

  const loadProfiles = useCallback(async () => {
    if (!getAdminKey()) {
      setProfiles([]);
      return;
    }
    try {
      const res = await api.getProfiles();
      const ids: string[] = res.profiles || [];
      setProfiles(ids);
      setProfileId((cur) => {
        if (cur && ids.includes(cur)) return cur;
        return ids[0] || "";
      });
    } catch {
      setProfiles([]);
    }
  }, []);

  useEffect(() => {
    void loadProfiles();
    const onKey = () => {
      setKeyTick((t) => t + 1);
      void loadProfiles();
    };
    window.addEventListener("apiKeyUpdated", onKey);
    return () => window.removeEventListener("apiKeyUpdated", onKey);
  }, [loadProfiles]);

  const effectiveModel = useMemo(() => {
    if (modelMode === "random") return "";
    if (modelMode === "custom") return customModel.trim();
    return selectedModelId.trim();
  }, [modelMode, customModel, selectedModelId]);

  const refreshModels = async () => {
    if (!profileId) {
      toast({ title: "Pick a profile", description: "Select a profile (or set Admin API Key to load the list).", variant: "destructive" });
      return;
    }
    setBusy("models");
    setLastListDebug(null);
    try {
      const dbg = await v1ListModels(profileId);
      setLastListDebug(dbg);
      const body = dbg.responseBody;
      const rawModels =
        body && typeof body === "object" && Array.isArray((body as { models?: unknown }).models)
          ? ((body as { models: ModelRow[] }).models as ModelRow[])
          : [];
      setModels(rawModels.map((m) => ({ id: String(m.id), label: String(m.label ?? m.id) })));
      if (rawModels.length && modelMode === "pick") {
        const first = String(rawModels[0].id);
        setSelectedModelId((cur) => (cur && rawModels.some((x) => String(x.id) === cur) ? cur : first));
      }
      if (!dbg.ok) {
        const detail =
          dbg.responseBody && typeof dbg.responseBody === "object" && "detail" in dbg.responseBody
            ? String((dbg.responseBody as { detail?: unknown }).detail)
            : dbg.responseRaw;
        toast({ title: "List models failed", description: detail.slice(0, 400), variant: "destructive" });
      } else {
        toast({ title: "Models refreshed", description: `${rawModels.length} model(s) for ${profileId}.` });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast({ title: "List models error", description: msg, variant: "destructive" });
    } finally {
      setBusy("idle");
    }
  };

  const pullServerLogs = async (pid: string, requestId: string | null) => {
    if (!getAdminKey()) {
      setServerLines([]);
      return;
    }
    try {
      const res = await api.getLogs(1200);
      const lines = res.lines || [];
      setServerLines(filterLogsForRun(lines, pid, requestId));
    } catch {
      setServerLines([]);
    }
  };

  const runGenerate = async () => {
    if (!profileId) {
      toast({ title: "Pick a profile", description: "Choose a profile id for X-Gemini-Profile.", variant: "destructive" });
      return;
    }
    if (!prompt.trim()) {
      toast({ title: "Empty prompt", description: "Enter a prompt to send to /v1/generate.", variant: "destructive" });
      return;
    }
    if (modelMode === "pick" && !effectiveModel) {
      toast({ title: "Pick a model", description: "Refresh models and select one, or use Random / Custom.", variant: "destructive" });
      return;
    }
    if (modelMode === "custom" && !effectiveModel) {
      toast({ title: "Custom model empty", description: "Enter a model id (e.g. gemini-3-flash).", variant: "destructive" });
      return;
    }

    setBusy("gen");
    setLastGenDebug(null);
    setAssistantText(null);
    try {
      const dbg = await v1Generate(profileId, {
        prompt,
        model: effectiveModel || null,
        responseMimeType: jsonOutput ? "application/json" : null,
      });
      setLastGenDebug(dbg);
      const body = dbg.responseBody;
      let text = "";
      if (body && typeof body === "object" && "text" in body) {
        text = String((body as { text?: unknown }).text ?? "");
      } else if (typeof body === "string") {
        text = body;
      }
      setAssistantText(text);

      const rid = dbg.ok && body && typeof body === "object" ? extractRequestId(body) : null;
      await pullServerLogs(profileId, rid);

      if (!dbg.ok) {
        const detail =
          body && typeof body === "object" && "detail" in body
            ? String((body as { detail?: unknown }).detail)
            : dbg.responseRaw;
        toast({ title: `Generate failed (${dbg.status})`, description: detail.slice(0, 500), variant: "destructive" });
      } else {
        toast({ title: "Generate OK", description: `${dbg.durationMs} ms · requestId in debug below` });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast({ title: "Generate error", description: msg, variant: "destructive" });
    } finally {
      setBusy("idle");
    }
  };

  const adminConfigured = useMemo(() => Boolean(getAdminKey()), [keyTick]);

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Playground</h1>
          <p className="text-muted-foreground mt-1">
            Run <span className="font-mono text-xs">/v1/generate</span> against any saved profile and model. Request, response, timing, and
            correlated server logs appear in the debug panels.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => void loadProfiles()} disabled={!adminConfigured}>
            <RefreshCw className="mr-2 h-4 w-4 shrink-0" />
            Reload profiles
          </Button>
        </div>
      </div>

      {!adminConfigured && (
        <Card className="border-amber-500/30 bg-amber-500/5">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <FlaskConical className="h-4 w-4 text-amber-400" />
              Admin API Key
            </CardTitle>
            <CardDescription>
              Set the Admin API Key in Settings to load profile ids from the server. You can still type a profile id manually if you already
              know it.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
          <CardHeader>
            <CardTitle>Request</CardTitle>
            <CardDescription>Uses on-disk cookies for the profile (same as API clients).</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="pg-profile">Profile (X-Gemini-Profile)</Label>
              {profiles.length > 0 ? (
                <select
                  id="pg-profile"
                  className="flex h-10 w-full rounded-md border border-border/60 bg-black/40 px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                  value={profileId}
                  onChange={(e) => setProfileId(e.target.value)}
                >
                  {profiles.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
              ) : (
                <Input
                  id="pg-profile"
                  placeholder="default"
                  value={profileId}
                  onChange={(e) => setProfileId(e.target.value)}
                  className="font-mono"
                />
              )}
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label>Model</Label>
                <Button type="button" variant="ghost" size="sm" className="h-8 text-xs" onClick={() => void refreshModels()} disabled={busy !== "idle"}>
                  {busy === "models" ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <RefreshCw className="mr-1 h-3 w-3" />}
                  Refresh models
                </Button>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <select
                  className="flex h-10 flex-1 rounded-md border border-border/60 bg-black/40 px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                  value={modelMode}
                  onChange={(e) => setModelMode(e.target.value as typeof modelMode)}
                >
                  <option value="random">Random (server picks)</option>
                  <option value="pick">From list-models…</option>
                  <option value="custom">Custom id…</option>
                </select>
              </div>
              {modelMode === "pick" && (
                <select
                  className="flex h-10 w-full rounded-md border border-border/60 bg-black/40 px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                  value={selectedModelId}
                  onChange={(e) => setSelectedModelId(e.target.value)}
                  disabled={!models.length}
                >
                  {!models.length ? <option value="">Call “Refresh models” first</option> : null}
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label} ({m.id})
                    </option>
                  ))}
                </select>
              )}
              {modelMode === "custom" && (
                <Input
                  placeholder="e.g. gemini-3-flash"
                  value={customModel}
                  onChange={(e) => setCustomModel(e.target.value)}
                  className="font-mono text-sm"
                />
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="pg-prompt">Prompt</Label>
              <textarea
                id="pg-prompt"
                className="min-h-[140px] w-full rounded-md border border-border/60 bg-black/40 p-3 text-sm text-foreground font-mono focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
            </div>

            <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer select-none">
              <input type="checkbox" checked={jsonOutput} onChange={(e) => setJsonOutput(e.target.checked)} className="rounded border-border" />
              Ask for JSON only (<span className="font-mono text-xs">responseMimeType: application/json</span>)
            </label>

            <Button className="w-full sm:w-auto" onClick={() => void runGenerate()} disabled={busy !== "idle"}>
              {busy === "gen" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
              Run generate
            </Button>
          </CardContent>
        </Card>

        <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
          <CardHeader>
            <CardTitle>Assistant output</CardTitle>
            <CardDescription>Plain text from the <span className="font-mono text-xs">text</span> field when the call succeeds.</CardDescription>
          </CardHeader>
          <CardContent>
            <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap rounded-md border border-border/50 bg-black/50 p-4 text-sm text-foreground/90">
              {assistantText ?? (lastGenDebug ? "(see debug — response may be an error object)" : "Run generate to see output here.")}
            </pre>
          </CardContent>
        </Card>
      </div>

      <Card className="border-border/50 bg-card/40 backdrop-blur-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bug className="h-5 w-5 text-primary" />
            Debug
          </CardTitle>
          <CardDescription>
            Full HTTP traces from the browser and, when an admin key is set, log lines filtered to this profile (and requestId after
            generate).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <div className="text-sm font-medium text-foreground">Last POST /v1/list-models</div>
            <pre className="max-h-[280px] overflow-auto rounded-md border border-border/50 bg-black/60 p-3 text-xs leading-relaxed text-muted-foreground">
              {lastListDebug ? prettyJson(lastListDebug) : "—"}
            </pre>
          </div>
          <div className="space-y-2">
            <div className="text-sm font-medium text-foreground">Last POST /v1/generate</div>
            <pre className="max-h-[360px] overflow-auto rounded-md border border-border/50 bg-black/60 p-3 text-xs leading-relaxed text-muted-foreground">
              {lastGenDebug ? prettyJson(lastGenDebug) : "—"}
            </pre>
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm font-medium text-foreground">Server logs (tail, filtered)</div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 text-xs"
                disabled={!adminConfigured || !profileId}
                onClick={() => void pullServerLogs(profileId, lastGenDebug?.ok ? extractRequestId(lastGenDebug.responseBody) : null)}
              >
                Refresh logs
              </Button>
            </div>
            {!adminConfigured ? (
              <p className="text-sm text-muted-foreground">Set Admin API Key in Settings to load server log lines here.</p>
            ) : (
              <pre className="max-h-[320px] overflow-auto rounded-md border border-border/50 bg-black/60 p-3 text-xs leading-relaxed text-muted-foreground">
                {serverLines.length
                  ? serverLines.map((l) => `[${l.t}] ${l.level} ${l.logger}: ${l.msg}`).join("\n")
                  : "No lines yet — run generate or hit Refresh logs."}
              </pre>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
