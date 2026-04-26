import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import Review from "./pages/Review.tsx";
import Lens from "./pages/Lens.tsx";
import NotFound from "./pages/NotFound.tsx";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner
        theme="dark"
        toastOptions={{
          style: {
            background: "#141414",
            border: "1px solid #262626",
            color: "#FAFAFA",
            fontFamily: "JetBrains Mono, monospace",
            fontSize: "12.5px",
          },
        }}
      />
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Review />} />
          <Route path="/lens" element={<Lens />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
