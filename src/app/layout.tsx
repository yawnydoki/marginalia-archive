import type { Metadata } from "next";
import "@fontsource-variable/fraunces/standard.css";
import "@fontsource-variable/fraunces/standard-italic.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Marginalia — A Living Archive",
  description: "Poems, letters, and fragments kept here instead of sent.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
