'use client';

import Link from 'next/link';
import { SettingsPanel } from '@/components/SettingsPanel';

/**
 * The settings route exists so the page can be linked and bookmarked. In the
 * app itself settings open as an overlay over the chat instead, because
 * navigating away from a conversation to paste an API key loses your place.
 */
export default function SettingsPage() {
  return (
    <div className="shell">
      <header className="top">
        <h1 className="brand">
          Convertara<span>settings</span>
        </h1>
        <nav className="tabs">
          <Link href="/">Back to chat</Link>
        </nav>
      </header>
      <SettingsPanel />
    </div>
  );
}
