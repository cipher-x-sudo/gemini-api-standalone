import { Terminal } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function LogsPage() {
  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-foreground">System Logs</h1>
        <p className="text-muted-foreground mt-1">Real-time log output from the backend service.</p>
      </div>
      
      <Card className="border-border/50 shadow-xl shadow-black/20 bg-card/50 backdrop-blur-sm overflow-hidden flex flex-col h-[600px] ring-1 ring-white/5">
        <CardHeader className="border-b border-border/50 py-3 bg-black/40 flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <Terminal className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-sm font-medium text-muted-foreground tracking-wider">gemini-api-standalone</CardTitle>
          </div>
          <div className="flex gap-1.5">
            <div className="h-3 w-3 rounded-full bg-red-500/80 shadow-[0_0_8px_rgba(239,68,68,0.5)]"></div>
            <div className="h-3 w-3 rounded-full bg-yellow-500/80 shadow-[0_0_8px_rgba(234,179,8,0.5)]"></div>
            <div className="h-3 w-3 rounded-full bg-emerald-500/80 shadow-[0_0_8px_rgba(16,185,129,0.5)]"></div>
          </div>
        </CardHeader>
        <CardContent className="p-0 flex-1 overflow-y-auto bg-[#09090b] text-[#a1a1aa] font-mono text-[13px] leading-relaxed">
          <div className="p-4 space-y-1">
            <div className="flex hover:bg-white/5 px-2 py-0.5 rounded transition-colors"><span className="text-emerald-400 mr-4 shrink-0">2026-04-22 05:49:11</span><span className="text-blue-400 mr-2">[INFO]</span><span>Starting Gemini Web API (standalone) v1.0.0</span></div>
            <div className="flex hover:bg-white/5 px-2 py-0.5 rounded transition-colors"><span className="text-emerald-400 mr-4 shrink-0">2026-04-22 05:49:12</span><span className="text-blue-400 mr-2">[INFO]</span><span>Loaded 1 profiles from disk</span></div>
            <div className="flex hover:bg-white/5 px-2 py-0.5 rounded transition-colors"><span className="text-emerald-400 mr-4 shrink-0">2026-04-22 05:49:15</span><span className="text-yellow-400 mr-2">[WARN]</span><span className="text-yellow-100/70">ADMIN_API_KEY is empty — admin routes disabled until set.</span></div>
            <div className="flex hover:bg-white/5 px-2 py-0.5 rounded transition-colors"><span className="text-emerald-400 mr-4 shrink-0">2026-04-22 05:50:00</span><span className="text-blue-400 mr-2">[INFO]</span><span className="text-foreground">POST /v1/generate</span><span className="text-muted-foreground ml-2">(profile: default) - 200 OK</span></div>
            <div className="animate-pulse flex mt-4 px-2"><span className="mr-2 text-primary">█</span></div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
