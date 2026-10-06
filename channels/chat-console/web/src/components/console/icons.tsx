import type { SVGProps } from "react";

const stroke: SVGProps<SVGSVGElement> = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true
};

export const SearchIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg {...stroke} {...props}>
    <circle cx="11" cy="11" r="7" />
    <line x1="20" y1="20" x2="16" y2="16" />
  </svg>
);

export const HomeIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg {...stroke} {...props}>
    <rect x="3" y="3" width="7.5" height="7.5" rx="1.5" />
    <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" />
    <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" />
    <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" />
  </svg>
);

export const BellIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg {...stroke} {...props}>
    <path d="M6.5 9a5.5 5.5 0 0 1 11 0c0 5 2 6.5 2 6.5H4.5S6.5 14 6.5 9" />
    <path d="M10.4 19a1.85 1.85 0 0 0 3.2 0" />
  </svg>
);

export const CompassIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg {...stroke} {...props}>
    <circle cx="12" cy="12" r="9" />
    <path d="M14.9 9.1 12.9 13.6a1 1 0 0 1-.5.5L7.9 16l1.6-4.6a1 1 0 0 1 .6-.6z" fill="currentColor" stroke="none" />
  </svg>
);

export const PlusIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg {...stroke} {...props}>
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

export const UserIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg {...stroke} {...props}>
    <circle cx="12" cy="8" r="3.5" />
    <path d="M5.5 20a6.5 6.5 0 0 1 13 0" />
  </svg>
);

export const SettingsIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg {...stroke} {...props}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

export const PanelIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg {...stroke} {...props}>
    <rect x="3" y="4" width="18" height="16" rx="2.5" />
    <line x1="9.5" y1="4" x2="9.5" y2="20" />
  </svg>
);

export const SlidersIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg {...stroke} {...props}>
    <line x1="4" y1="8" x2="14" y2="8" />
    <line x1="18" y1="8" x2="20" y2="8" />
    <line x1="4" y1="16" x2="10" y2="16" />
    <line x1="14" y1="16" x2="20" y2="16" />
    <circle cx="16" cy="8" r="2" />
    <circle cx="12" cy="16" r="2" />
  </svg>
);

export const PaperclipIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg {...stroke} {...props}>
    <path d="M20.5 11.5l-8.4 8.4a5.5 5.5 0 0 1-7.8-7.8l8.4-8.4a3.7 3.7 0 0 1 5.2 5.2l-8.4 8.4a1.9 1.9 0 0 1-2.6-2.6l7.8-7.8" />
  </svg>
);

export const MicIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg {...stroke} {...props}>
    <rect x="9" y="2.5" width="6" height="11" rx="3" />
    <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0" />
    <line x1="12" y1="18" x2="12" y2="21.5" />
  </svg>
);

export const SendIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg {...stroke} strokeWidth={2} {...props}>
    <line x1="12" y1="19.5" x2="12" y2="5" />
    <polyline points="6 11 12 5 18 11" />
  </svg>
);

export const SortIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg {...stroke} {...props}>
    <polyline points="6 8 9 5 12 8" />
    <line x1="9" y1="5" x2="9" y2="19" />
    <polyline points="12 16 15 19 18 16" />
    <line x1="15" y1="19" x2="15" y2="5" />
  </svg>
);

export const ChevronIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg {...stroke} strokeWidth={2} {...props}>
    <polyline points="6 9.5 12 15.5 18 9.5" />
  </svg>
);

export const StarIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
    <path d="M12 1.6l1.5 6.1 4.6-4.2-2.6 5.7 6.3-1.1-5.4 3.4 5.4 3.4-6.3-1.1 2.6 5.7-4.6-4.2-1.5 6.1-1.5-6.1-4.6 4.2 2.6-5.7-6.3 1.1 5.4-3.4-5.4-3.4 6.3 1.1-2.6-5.7 4.6 4.2z" />
  </svg>
);

export const BoltIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg {...stroke} {...props}>
    <polygon points="13 2.5 4 13.5 11 13.5 10 21.5 19.5 10 12.5 10" />
  </svg>
);

export const BookIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg {...stroke} {...props}>
    <path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H19v15.5H5.5A1.5 1.5 0 0 0 4 20z" />
    <line x1="8" y1="7" x2="15" y2="7" />
    <line x1="8" y1="10.5" x2="13" y2="10.5" />
  </svg>
);

export const PlugIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg {...stroke} {...props}>
    <path d="M8 3v6a4 4 0 0 0 8 0V3" />
    <line x1="12" y1="13" x2="12" y2="21" />
    <line x1="8" y1="21" x2="16" y2="21" />
  </svg>
);

export const HookIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg {...stroke} {...props}>
    <circle cx="12" cy="5.5" r="2.5" />
    <path d="M12 8v6.5a4 4 0 0 1-8 0" />
    <circle cx="4" cy="18" r="2.5" />
    <circle cx="19" cy="18" r="2.5" />
    <path d="M17 16 12 11" />
  </svg>
);

export const SpinnerIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" aria-hidden {...props}>
    <circle cx="12" cy="12" r="9" strokeDasharray="2 4" />
  </svg>
);
