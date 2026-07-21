import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Agentic OS',
  description: 'A visual command center for an Obsidian vault.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fafaf9' },
    { media: '(prefers-color-scheme: dark)', color: '#0c0c0d' },
  ],
};

/**
 * Theme is applied before paint to avoid a flash of the wrong palette.
 * Reads the stored preference, falling back to the OS setting.
 */
const THEME_SCRIPT = `
(function () {
  try {
    var stored = localStorage.getItem('agentic-theme');
    var dark = stored === 'dark' || (stored === null &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);
    if (dark) document.documentElement.classList.add('dark');
  } catch (e) {}
})();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
