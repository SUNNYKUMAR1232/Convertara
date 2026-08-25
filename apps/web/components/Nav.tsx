'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { href: '/', label: 'Workbench' },
  { href: '/settings', label: 'Settings' },
];

export function Nav() {
  const pathname = usePathname();
  return (
    <header className="top">
      <h1 className="brand">
        Convertara<span>files in, exactly what you asked for out</span>
      </h1>
      <nav className="tabs">
        {TABS.map((tab) => (
          <Link key={tab.href} href={tab.href} className={pathname === tab.href ? 'active' : ''}>
            {tab.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
