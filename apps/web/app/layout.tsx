import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Convertara',
  description: 'Describe what you want done to a file. The system guarantees the result.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
