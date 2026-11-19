import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'DietPi Panel',
  description: 'Self-hosted server control panel for sites, SQLite databases, and services',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-canvas text-slate-100 antialiased">
        {children}
      </body>
    </html>
  );
}
