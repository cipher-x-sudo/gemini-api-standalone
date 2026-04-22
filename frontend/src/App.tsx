import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Sidebar } from "./components/layout/Sidebar";
import { Header } from "./components/layout/Header";
import { ProfilesPage } from "./pages/ProfilesPage";
import { LogsPage } from "./pages/LogsPage";
import { JobsPage } from "./pages/JobsPage";
import { Toaster } from "@/components/ui/toaster";

function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen overflow-hidden bg-[#09090b] selection:bg-primary/30">
      <div className="fixed inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-20 pointer-events-none mix-blend-overlay"></div>
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden relative z-0">
        <Header />
        <main className="flex-1 overflow-y-auto bg-background/40 p-4 md:p-6 lg:p-8">
          <div className="mx-auto max-w-6xl">
            {children}
          </div>
        </main>
      </div>
      <Toaster />
    </div>
  );
}

function App() {
  return (
    <BrowserRouter basename="/ui">
      <Layout>
        <Routes>
          <Route path="/" element={<ProfilesPage />} />
          <Route path="/logs" element={<LogsPage />} />
          <Route path="/jobs" element={<JobsPage />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}

export default App;
