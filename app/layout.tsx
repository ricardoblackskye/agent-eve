import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Eve Agent",
  description: "Chat with Eve Agent",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
