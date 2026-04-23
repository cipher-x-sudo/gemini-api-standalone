import { useState, useEffect } from "react";
import { Plus, Trash2, Key, RefreshCw, Activity } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { api, getAdminKey } from "@/lib/api";

type ProfileDetails = {
  id: string;
  email: string | null;
  status: string;
  cookiesMasked: Record<string, string>;
  updatedAt: string | null;
};

export function ProfilesPage() {
  const { toast } = useToast();
  const [profiles, setProfiles] = useState<ProfileDetails[]>([]);
  const [loading, setLoading] = useState(true);
  
  // Modals
  const [useCustomProfileId, setUseCustomProfileId] = useState(false);
  const [newProfileId, setNewProfileId] = useState("");
  const [newProfileEmail, setNewProfileEmail] = useState("");
  const [newProfileCookies, setNewProfileCookies] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [cookieOpen, setCookieOpen] = useState(false);
  const [selectedProfile, setSelectedProfile] = useState("");
  const [labelEmail, setLabelEmail] = useState("");
  const [cookiesInput, setCookiesInput] = useState("");

  const loadProfiles = async (opts?: { probeLiveAuth?: boolean }) => {
    if (!getAdminKey()) {
      setLoading(false);
      setProfiles([]);
      return;
    }
    setLoading(true);
    let authProbeSucceeded = false;
    try {
      if (opts?.probeLiveAuth) {
        try {
          await api.getProfilesAuthStatus();
          authProbeSucceeded = true;
        } catch (e: any) {
          toast({
            title: "Auth check failed",
            description: e?.message || "Could not refresh session status.",
            variant: "destructive",
          });
        }
      }
      const res = await api.getProfiles();
      const profileIds = res.profiles || [];
      
      const details = await Promise.all(
        profileIds.map(async (id: string) => {
          try {
            const ck = await api.getCookies(id);
            return {
              id,
              email: typeof (ck as { email?: string | null }).email === "string" ? (ck as { email: string }).email : null,
              status: (typeof ck.lastAccountStatus === "string" && ck.lastAccountStatus)
                ? ck.lastAccountStatus
                : "UNKNOWN",
              cookiesMasked: ck.cookiesMasked || {},
              updatedAt: ck.updatedAt || "Never"
            };
          } catch (e) {
            return { id, email: null, status: "ERROR", cookiesMasked: {}, updatedAt: null };
          }
        })
      );
      setProfiles(details);
    } catch (e: any) {
      toast({ title: "Error loading profiles", description: e.message, variant: "destructive" });
      setProfiles([]);
    } finally {
      setLoading(false);
    }
    if (opts?.probeLiveAuth && authProbeSucceeded) {
      toast({ title: "Auth state refreshed", description: "Session status was re-checked for all profiles." });
    }
  };

  useEffect(() => {
    loadProfiles();
    
    const handleKeyUpdate = () => {
      loadProfiles();
    };
    
    window.addEventListener("apiKeyUpdated", handleKeyUpdate);
    return () => window.removeEventListener("apiKeyUpdated", handleKeyUpdate);
  }, []);

  const handleCreateProfile = async () => {
    if (useCustomProfileId) {
      const custom = newProfileId.trim();
      if (!custom) {
        toast({ title: "Profile ID required", description: "Enter a profile id or turn off “Custom profile id”.", variant: "destructive" });
        return;
      }
    }
    const raw = newProfileCookies.trim();
    let cookiesPayload: unknown | undefined;
    if (raw) {
      try {
        cookiesPayload = JSON.parse(raw);
      } catch {
        toast({
          title: "Invalid JSON",
          description: "Fix the cookie JSON or clear the box to create the profile without cookies.",
          variant: "destructive",
        });
        return;
      }
    }
    try {
      const res = await api.createProfile({
        profileId: useCustomProfileId ? newProfileId.trim() : null,
        email: newProfileEmail.trim() || null,
        cookies: cookiesPayload,
      });
      const id = res.profile ?? "(unknown)";
      toast({
        title: "Profile Created",
        description:
          (raw.length > 0
            ? `Profile ${id} was created and cookies were saved.`
            : `Profile ${id} has been created.`) + (res.autoAssignedId ? " (id was assigned automatically.)" : ""),
      });
      setCreateOpen(false);
      setUseCustomProfileId(false);
      setNewProfileId("");
      setNewProfileEmail("");
      setNewProfileCookies("");
      loadProfiles();
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    }
  };

  const handleDeleteProfile = async (id: string) => {
    try {
      await api.deleteProfile(id);
      toast({ title: "Profile Deleted", description: `Profile ${id} was removed.` });
      loadProfiles();
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    }
  };

  const handleSaveCookies = async () => {
    const raw = cookiesInput.trim();
    try {
      await api.setProfileLabel(selectedProfile, labelEmail.trim() || null);
      if (raw) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          toast({ title: "Invalid JSON", description: "Please paste a valid JSON array or object.", variant: "destructive" });
          return;
        }
        await api.setCookies(selectedProfile, parsed);
        toast({ title: "Saved", description: `Updated label and cookies for ${selectedProfile}.` });
      } else {
        toast({ title: "Label saved", description: `Updated label for ${selectedProfile} (cookies unchanged).` });
      }
      setCookieOpen(false);
      setCookiesInput("");
      setLabelEmail("");
      loadProfiles();
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    }
  };

  const handleCheckStatus = async (id: string) => {
    try {
      const res = await api.checkStatus(id);
      toast({ 
        title: `Status: ${res.status}`, 
        description: res.description || "Account status checked successfully." 
      });
      // Update local state to reflect status
      setProfiles(prev => prev.map(p => p.id === id ? { ...p, status: res.status } : p));
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    }
  };

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Profiles</h1>
          <p className="text-muted-foreground mt-1">Manage your Gemini API authentication profiles.</p>
        </div>
        <div className="flex gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={() => loadProfiles({ probeLiveAuth: true })}
            disabled={loading}
            title="Re-check Gemini session for every profile (may take a while)"
          >
            <RefreshCw className={`mr-2 h-4 w-4 shrink-0 ${loading ? "animate-spin" : ""}`} />
            <span className="hidden sm:inline">Refresh</span>
          </Button>
          <Dialog
            open={createOpen}
            onOpenChange={(open) => {
              setCreateOpen(open);
              if (!open) {
                setUseCustomProfileId(false);
                setNewProfileId("");
                setNewProfileEmail("");
                setNewProfileCookies("");
              }
            }}
          >
            <DialogTrigger asChild>
              <Button size="sm" className="bg-primary hover:bg-primary/90 text-primary-foreground shadow-lg shadow-primary/20 transition-all hover:shadow-primary/40">
                <Plus className="mr-2 h-4 w-4" />
                New Profile
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[500px]">
              <DialogHeader>
                <DialogTitle>Create Profile</DialogTitle>
                <DialogDescription>
                  By default a random profile id is assigned (e.g. <code className="text-xs">p…</code>). Optionally set a
                  label email and paste cookies. Use a custom id only if you need a fixed name.
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-4 py-2">
                <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
                  <input
                    type="checkbox"
                    checked={useCustomProfileId}
                    onChange={(e) => setUseCustomProfileId(e.target.checked)}
                    className="rounded border-border"
                  />
                  <span>Custom profile id (otherwise auto-generated)</span>
                </label>
                {useCustomProfileId && (
                  <div className="grid grid-cols-4 items-center gap-4">
                    <Label htmlFor="profileId" className="text-right">
                      Profile ID
                    </Label>
                    <Input
                      id="profileId"
                      value={newProfileId}
                      onChange={(e) => setNewProfileId(e.target.value)}
                      placeholder="my-profile"
                      className="col-span-3"
                    />
                  </div>
                )}
                <div className="grid grid-cols-4 items-center gap-4">
                  <Label htmlFor="newProfileEmail" className="text-right">
                    Label / email
                  </Label>
                  <Input
                    id="newProfileEmail"
                    type="email"
                    value={newProfileEmail}
                    onChange={(e) => setNewProfileEmail(e.target.value)}
                    placeholder="you@gmail.com (optional)"
                    className="col-span-3"
                    autoComplete="off"
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="newProfileCookies">Cookies (optional)</Label>
                  <textarea
                    id="newProfileCookies"
                    className="w-full h-40 bg-black/50 border border-border/50 rounded-md p-3 text-sm text-foreground font-mono focus:outline-none focus:ring-1 focus:ring-primary"
                    placeholder='[{"name": "__Secure-1PSID", "value": "…"}] or a flat object with __Secure-1PSID'
                    value={newProfileCookies}
                    onChange={(e) => setNewProfileCookies(e.target.value)}
                  />
                </div>
              </div>
              <DialogFooter>
                <Button onClick={handleCreateProfile}>Create</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <Card className="border-border/50 shadow-sm bg-card/50 backdrop-blur-sm overflow-hidden">
        <CardHeader className="bg-white/[0.02]">
          <CardTitle>Active Profiles</CardTitle>
          <CardDescription>View and manage cookies for all available profiles.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader className="bg-white/[0.02]">
              <TableRow className="border-border/50 hover:bg-transparent">
                <TableHead className="w-[min(14rem,28vw)] pl-6">Profile ID</TableHead>
                <TableHead className="min-w-[10rem]">Label / email</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Cookies</TableHead>
                <TableHead>Last Updated</TableHead>
                <TableHead className="text-right pr-6">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {profiles.length === 0 && !loading && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                    No profiles found or invalid API key. Try setting your Admin API Key in the Settings menu.
                  </TableCell>
                </TableRow>
              )}
              {profiles.map((profile) => {
                const failedAuth =
                  profile.status === "UNAUTHENTICATED" ||
                  profile.status === "ERROR" ||
                  profile.status === "NO_COOKIES" ||
                  profile.status === "TIMEOUT" ||
                  profile.status === "PROBE_ERROR";
                const uncertain = profile.status === "UNKNOWN";
                const isAuthenticated = Boolean(profile.status) && !failedAuth && !uncertain;
                return (
                <TableRow key={profile.id} className="border-border/50 hover:bg-white/[0.04] transition-colors group">
                  <TableCell className="font-mono text-xs pl-6 max-w-[14rem] truncate" title={profile.id}>
                    {profile.id}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground max-w-[12rem] truncate" title={profile.email || undefined}>
                    {profile.email || "—"}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <div className={`h-2 w-2 rounded-full ${isAuthenticated ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]' : (profile.status === 'UNKNOWN' ? 'bg-yellow-500 shadow-[0_0_8px_rgba(234,179,8,0.5)]' : 'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.5)]')} animate-pulse`} />
                      <span className="text-sm text-muted-foreground">{profile.status}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <span className="inline-flex items-center rounded-md bg-white/5 px-2 py-1 text-xs font-medium text-muted-foreground ring-1 ring-inset ring-white/10">
                      {Object.keys(profile.cookiesMasked).length} saved
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">{profile.updatedAt}</TableCell>
                  <TableCell className="text-right pr-6">
                    <div className="flex justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Button variant="ghost" size="icon" onClick={() => handleCheckStatus(profile.id)} className="h-8 w-8 text-blue-400 hover:text-blue-300 hover:bg-blue-400/10" title="Check Account Status">
                        <Activity className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => {
                          setSelectedProfile(profile.id);
                          setLabelEmail(profile.email || "");
                          setCookieOpen(true);
                        }}
                        className="h-8 w-8 text-indigo-400 hover:text-indigo-300 hover:bg-indigo-400/10"
                        title="Update label and cookies"
                      >
                        <Key className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => handleDeleteProfile(profile.id)} className="h-8 w-8 text-red-400 hover:text-red-300 hover:bg-red-400/10" title="Delete Profile">
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              )})}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={cookieOpen} onOpenChange={setCookieOpen}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>Profile: {selectedProfile}</DialogTitle>
            <DialogDescription>
              Set a label (email) to remember this account. Paste new cookies only when you want to replace the saved
              session; leave the JSON box empty to update the label only.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-2">
            <div className="grid gap-2">
              <Label htmlFor="labelEmail">Label / email</Label>
              <Input
                id="labelEmail"
                type="email"
                value={labelEmail}
                onChange={(e) => setLabelEmail(e.target.value)}
                placeholder="you@gmail.com"
                autoComplete="off"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="cookiesJson">Cookie JSON (optional)</Label>
              <textarea
                id="cookiesJson"
                className="w-full h-40 bg-black/50 border border-border/50 rounded-md p-3 text-sm text-foreground font-mono focus:outline-none focus:ring-1 focus:ring-primary"
                placeholder='[{"name": "__Secure-1PSID", "value": "..."}]'
                value={cookiesInput}
                onChange={(e) => setCookiesInput(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCookieOpen(false)}>Cancel</Button>
            <Button onClick={handleSaveCookies}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
