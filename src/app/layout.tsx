import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Baby Health", template: "%s · Baby Health" },
  description: "A calm, private health record for each of your babies.",
  applicationName: "Baby Health",
  appleWebApp: { capable: true, title: "Baby Health", statusBarStyle: "default" },
  formatDetection: { telephone: false },
  robots: { index: false, follow: false },
};
export const viewport: Viewport = {
  themeColor: [{ media: "(prefers-color-scheme: light)", color: "#FBF7F1" }, { media: "(prefers-color-scheme: dark)", color: "#121A1B" }],
  width: "device-width", initialScale: 1, viewportFit: "cover",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="en-IN" className="h-full">
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: `try{var t=localStorage.getItem("bh_theme");if(t==="LIGHT"||t==="DARK")document.documentElement.dataset.theme=t.toLowerCase()}catch(e){}` }} />
      </head>
      <body className="min-h-full">
        <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-full focus:bg-surface focus:px-4 focus:py-2">Skip to content</a>
        {children}
      </body>
    </html>
  );
}
