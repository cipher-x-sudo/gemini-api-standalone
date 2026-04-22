import { Activity, Play, Square } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";

const MOCK_JOBS = [
  { id: "job-rotate-1psidts", type: "Cookie Rotation", status: "Running", nextRun: "in 10 mins" },
  { id: "job-health-check", type: "Health Check", status: "Idle", nextRun: "in 1 min" },
];

export function JobsPage() {
  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-foreground">Background Jobs</h1>
        <p className="text-muted-foreground mt-1">Monitor scheduled tasks and automated cookie rotation.</p>
      </div>

      <Card className="border-border/50 shadow-sm bg-card/50 backdrop-blur-sm">
        <CardHeader className="bg-white/[0.02]">
          <CardTitle className="flex items-center gap-2">
            <Activity className="h-5 w-5 text-primary" />
            Active Tasks
          </CardTitle>
          <CardDescription>Manage and view status of background workers.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader className="bg-white/[0.02]">
              <TableRow className="border-border/50 hover:bg-transparent">
                <TableHead className="pl-6">Job ID</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Next Run</TableHead>
                <TableHead className="text-right pr-6">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {MOCK_JOBS.map((job) => (
                <TableRow key={job.id} className="border-border/50 hover:bg-white/[0.04] transition-colors group">
                  <TableCell className="font-medium font-mono text-[13px] text-muted-foreground pl-6">{job.id}</TableCell>
                  <TableCell className="font-medium">{job.type}</TableCell>
                  <TableCell>
                    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${job.status === 'Running' ? 'bg-indigo-400/10 text-indigo-400 ring-indigo-400/30 shadow-[0_0_8px_rgba(129,140,248,0.2)]' : 'bg-zinc-400/10 text-zinc-400 ring-zinc-400/20'}`}>
                      {job.status === 'Running' && <span className="mr-1.5 h-1.5 w-1.5 rounded-full bg-indigo-400 animate-pulse"></span>}
                      {job.status}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">{job.nextRun}</TableCell>
                  <TableCell className="text-right pr-6">
                    <div className="flex justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                      {job.status === 'Running' ? (
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-yellow-500 hover:text-yellow-400 hover:bg-yellow-400/10 shadow-sm" title="Stop Job">
                          <Square className="h-4 w-4" />
                        </Button>
                      ) : (
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-emerald-500 hover:text-emerald-400 hover:bg-emerald-400/10 shadow-sm" title="Start Job">
                          <Play className="h-4 w-4 ml-0.5" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
