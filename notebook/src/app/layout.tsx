import type { Metadata, Viewport } from "next";
import "katex/dist/katex.min.css";
import "./globals.css";
import { CommandPalette } from "@/components/CommandPalette";

export const metadata: Metadata = { title: "Notebook", description: "Lecture notes and recall" };
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: [
  { media: "(prefers-color-scheme: light)", color: "#fbfaf8" },
  { media: "(prefers-color-scheme: dark)", color: "#161615" },
] };

// Applies the saved theme before paint to avoid a flash.
const themeScript = `try{var t=localStorage.getItem('nb-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-dvh">
        {children}
        <CommandPalette />
      </body>
    </html>
  );
}
