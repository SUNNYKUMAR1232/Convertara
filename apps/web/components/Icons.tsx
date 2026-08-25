/**
 * Inline SVG rather than an icon font or a package.
 *
 * Two icons do not justify a dependency, and inline paths inherit
 * `currentColor`, so they follow the theme without a second set of rules.
 *
 * The geometry is the standard 24-unit grid with round caps and joins. Getting
 * a path subtly wrong shows up immediately at this size - a paperclip whose
 * tail ends on the wrong anchor reads as heavy and crooked rather than as a
 * paperclip.
 */

interface IconProps {
  strokeWidth?: number;
}

const base = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  focusable: false,
};

export function PaperclipIcon({ strokeWidth = 1.9 }: IconProps = {}) {
  return (
    <svg {...base} strokeWidth={strokeWidth}>
      <path d="M21.44 11.05 12.25 20.24a6 6 0 0 1-8.49-8.49l8.57-8.57a4 4 0 0 1 5.66 5.66l-8.58 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

export function ArrowUpIcon({ strokeWidth = 2.5 }: IconProps = {}) {
  return (
    <svg {...base} strokeWidth={strokeWidth}>
      <path d="M12 19V6" />
      <path d="m6 12 6-6 6 6" />
    </svg>
  );
}

export function StopIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden focusable="false">
      <rect x="7.5" y="7.5" width="9" height="9" rx="2" />
    </svg>
  );
}

/** Animated by CSS, so it keeps spinning without a render loop. */
export function SpinnerIcon() {
  return (
    <svg {...base} strokeWidth={2.2} className="spin">
      <path d="M12 3a9 9 0 1 0 9 9" />
    </svg>
  );
}

export function GearIcon({ strokeWidth = 1.9 }: IconProps = {}) {
  return (
    <svg {...base} strokeWidth={strokeWidth}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
