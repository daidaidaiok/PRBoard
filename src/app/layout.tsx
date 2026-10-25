import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Script from "next/script";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { PwaInstallPrompt } from "@/components/pwa-install-prompt";
import { AutomaticTheme } from "@/components/automatic-theme";
import { SwRegistrar } from "@/components/sw-registrar";
import { NIGHT_MODE_END_HOUR, NIGHT_MODE_START_HOUR, THEME_MODE_STORAGE_KEY } from "@/lib/theme";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "PRboard",
  description: "跨仓库 GitHub PR + CI 看板",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "PRboard",
  },
};

export const viewport: Viewport = {
  themeColor: "#ffffff",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="zh"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <Script id="theme-bootstrap" strategy="beforeInteractive">
          {`(() => {
  let mode = "auto";
  try { mode = localStorage.getItem("${THEME_MODE_STORAGE_KEY}") || "auto"; } catch (e) {}
  if (mode !== "auto" && mode !== "light" && mode !== "dark") mode = "auto";
  const hour = new Date().getHours();
  const dark = mode === "dark" || (mode === "auto" && (hour >= ${NIGHT_MODE_START_HOUR} || hour < ${NIGHT_MODE_END_HOUR}));
  const root = document.documentElement;
  root.classList.toggle("dark", dark);
  root.style.colorScheme = dark ? "dark" : "light";
  const themeColor = document.querySelector('meta[name="theme-color"]');
  themeColor?.setAttribute("content", dark ? "#0a0a0a" : "#ffffff");
})();`}
        </Script>
        <AutomaticTheme />
        <SwRegistrar />
        <TooltipProvider>{children}</TooltipProvider>
        <Toaster />
        <PwaInstallPrompt />
      </body>
    </html>
  );
}
