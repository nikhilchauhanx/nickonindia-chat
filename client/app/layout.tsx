import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Random Video Chat',
  description: 'A random video chat application built with Next.js and WebRTC',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}