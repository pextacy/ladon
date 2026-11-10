import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ladon",
  description: "A firewall between AI coding agents and the package registries.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans antialiased">{children}</body>
    </html>
  );
}
