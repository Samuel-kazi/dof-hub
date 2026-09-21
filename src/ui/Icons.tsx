import type { ReactNode } from "react";

const svg = (path: ReactNode, size = 18) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {path}
  </svg>
);

export const IconMenu = () => svg(<><path d="M4 7h16" /><path d="M4 12h16" /><path d="M4 17h16" /></>);
export const IconBack = () => svg(<path d="M15 5l-7 7 7 7" />);
export const IconChevron = ({ className = "" }: { className?: string }) => <span className={className} style={{ display: "inline-grid" }}>{svg(<path d="M9 6l6 6-6 6" />, 14)}</span>;
export const IconDown = () => svg(<path d="M6 9l6 6 6-6" />, 14);
export const IconBell = () => svg(<><path d="M6 9a6 6 0 1 1 12 0c0 6 2 7 2 7H4s2-1 2-7" /><path d="M10 20a2 2 0 0 0 4 0" /></>);
export const IconPlus = () => svg(<><path d="M12 5v14" /><path d="M5 12h14" /></>, 16);
export const IconLogout = () => svg(<><path d="M10 5H5v14h5" /><path d="M15 8l4 4-4 4" /><path d="M19 12H9" /></>);
export const IconHome = () => svg(<path d="M4 11l8-7 8 7v9h-5v-6H9v6H4z" />);
export const IconFilm = () => svg(<><rect x="4" y="5" width="16" height="14" rx="2" /><path d="M4 9h16M4 15h16M9 5v14M15 5v14" /></>);
export const IconSheet = () => svg(<><path d="M7 3h8l4 4v14H7z" /><path d="M10 12h6M10 16h6" /></>);
export const IconGear = () => svg(<><circle cx="12" cy="12" r="3" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" /></>);
export const IconCam = () => svg(<><rect x="3" y="7" width="13" height="10" rx="2" /><path d="M16 11l5-3v8l-5-3" /></>);
export const IconDrive = () => svg(<><rect x="3" y="13" width="18" height="7" rx="2" /><path d="M3 13l3-8h12l3 8" /><path d="M7 16.5h.01" /></>);
export const IconUsers = () => svg(<><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5" /><path d="M16 5a3.5 3.5 0 0 1 0 6.5M18 14.8c2 .6 3.2 2.4 3.5 5.2" /></>);
export const IconDoc = () => svg(<><path d="M6 3h9l3 3v15H6z" /><path d="M9 10h6M9 14h6" /></>);

export const IconSun = () => svg(<><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" /></>);
export const IconMoon = () => svg(<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z" />);
export const IconSearch = () => svg(<><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4.2-4.2" /></>);
export const IconCalendar = () => svg(<><rect x="4" y="5" width="16" height="15" rx="3" /><path d="M4 10h16M9 3v4M15 3v4" /></>, 16);
export const IconPulse = () => svg(<path d="M3 12h4l2.5-6 4 12 2.5-6H21" />);
export const IconCheck = () => svg(<path d="M5 12.5l4.5 4.5L19 7.5" />);
export const IconChart = () => svg(<><path d="M5 20V10M12 20V4M19 20v-7" /></>);
