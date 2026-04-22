import { useState } from "react";
import { NavLink } from "react-router-dom";
import { Users, FileText, Activity, Settings, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getAdminKey, setAdminKey } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";

const navItems = [
  { icon: Users, label: "Profiles", path: "/" },
  { icon: FileText, label: "Logs", path: "/logs" },
  { icon: Activity, label: "Jobs", path: "/jobs" },
];

export function Sidebar() {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [apiKey, setApiKey] = useState(getAdminKey());

  const handleSave = () => {
    setAdminKey(apiKey);
    toast({ title: "Settings Saved", description: "Admin API Key has been updated." });
    setOpen(false);
    window.dispatchEvent(new Event("apiKeyUpdated"));
  };

  return (
    <aside className="hidden md:flex w-64 flex-col border-r border-border bg-card/50 backdrop-blur-xl">
      <div className="flex h-16 shrink-0 items-center px-6 border-b border-border/50">
        <Zap className="h-6 w-6 text-primary mr-2" />
        <span className="text-lg font-bold bg-clip-text text-transparent bg-gradient-to-r from-primary to-indigo-400">
          Gemini API Panel
        </span>
      </div>
      <div className="flex-1 py-6 px-4 space-y-1">
        {navItems.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium transition-all duration-200",
                isActive
                  ? "bg-primary/10 text-primary shadow-[inset_0_1px_0_0_rgba(255,255,255,0.1)] ring-1 ring-primary/20"
                  : "text-muted-foreground hover:bg-white/5 hover:text-foreground"
              )
            }
          >
            <item.icon className="h-4 w-4" />
            {item.label}
          </NavLink>
        ))}
      </div>
      <div className="p-4 border-t border-border/50">
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <button className="flex items-center gap-3 px-3 py-2.5 w-full rounded-md text-sm font-medium text-muted-foreground hover:bg-white/5 hover:text-foreground transition-all">
              <Settings className="h-4 w-4" />
              Settings
            </button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[425px]">
            <DialogHeader>
              <DialogTitle>Global Settings</DialogTitle>
              <DialogDescription>
                Configure global application settings.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid grid-cols-4 items-center gap-4">
                <Label htmlFor="apiKey" className="text-right">
                  Admin API Key
                </Label>
                <Input
                  id="apiKey"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  className="col-span-3"
                  placeholder="Paste your key here..."
                />
              </div>
            </div>
            <DialogFooter>
              <Button onClick={handleSave}>Save changes</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </aside>
  );
}
