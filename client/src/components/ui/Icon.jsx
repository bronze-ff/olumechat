const paths = {
  inbox: 'M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7A8.38 8.38 0 0 1 4 11.5a8.5 8.5 0 0 1 17 0Z',
  pulse: 'M3 12h4l2.2-6 4.1 12 2.2-6H21',
  chart: 'M4 19V9m6 10V5m6 14v-7m5 7H2',
  history: 'M3 12a9 9 0 1 0 3-6.7L3 8m0-5v5h5M12 7v5l3 2',
  campaign: 'M4 13V9l12-5v14L4 13Zm0 0v5h4v-3.3M16 9h3a2 2 0 0 1 0 4h-3',
  flow: 'M6 4h4v4H6V4Zm8 12h4v4h-4v-4ZM8 8v4a2 2 0 0 0 2 2h6v2m0-8V6a2 2 0 0 0-2-2h-4',
  building: 'M4 21V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v16M8 7h2m3 0h1M8 11h2m3 0h1M8 15h2m3 0h1M2 21h20',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m7-10a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm13 10v-2a4 4 0 0 0-3-3.87m0-12.26a4 4 0 0 1 0 7.75',
  contact: 'M16 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2m6.5-10a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM16 7h5m-5 4h5m-5 4h3',
  phone: 'M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.2 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.12.9.33 1.78.62 2.63a2 2 0 0 1-.45 2.11L8 9.73a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.85.29 1.73.5 2.63.62A2 2 0 0 1 22 16.92Z',
  sparkles: 'm12 3 1.2 3.3L16.5 7.5l-3.3 1.2L12 12l-1.2-3.3-3.3-1.2 3.3-1.2L12 3Zm6 9 .9 2.1L21 15l-2.1.9L18 18l-.9-2.1L15 15l2.1-.9L18 12ZM6.5 13l1.3 3.2L11 17.5l-3.2 1.3L6.5 22l-1.3-3.2L2 17.5l3.2-1.3L6.5 13Z',
  bot: 'M12 3v3M7 9h10a2 2 0 0 1 2 2v6a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3v-6a2 2 0 0 1 2-2Zm2 6v.01M15 15v.01M2 13h2m16 0h2',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Zm-3-10 2 2 4-4',
  settings: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm0-12v2m0 13v2m8.5-8.5h-2m-13 0h-2m14.5-6.5-1.4 1.4M7.4 16.6 6 18m12 0-1.4-1.4M7.4 7.4 6 6',
  sliders: 'M4 6h10m4 0h2M14 4v4M4 12h2m4 0h10M6 10v4M4 18h9m4 0h3M13 16v4',
  sun: 'M12 4V2m0 20v-2m8-8h2M2 12h2m13.66-5.66 1.42-1.42M4.92 19.08l1.42-1.42m11.32 0 1.42 1.42M4.92 4.92l1.42 1.42M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
  logout: 'M10 17l5-5-5-5m5 5H3m12-9h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4',
  plus: 'M12 5v14M5 12h14',
  copy: 'M8 8h11v11H8V8Zm-3 8H4V4h12v1',
  support: 'M4 13a8 8 0 0 1 16 0v5a2 2 0 0 1-2 2h-3m-9-7v4H4a2 2 0 0 1-2-2v-2h4Zm12 0v4h2a2 2 0 0 0 2-2v-2h-4Z',
  edit: 'M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4L16.5 3.5Z',
  arrow: 'm9 18 6-6-6-6',
  check: 'm5 12 4 4L19 6',
  alert: 'M12 9v4m0 4h.01M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
  search: 'm21 21-4.35-4.35M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',
  menu: 'M4 7h16M4 12h16M4 17h16',
  palette: 'M12 3a9 9 0 1 0 0 18h1.5a1.5 1.5 0 0 0 0-3H12a2 2 0 0 1 0-4 4 4 0 0 0 4-4c0-5-4-9-9-9Zm-4 6h.01M12 7h.01m4 2h.01M7 13h.01',
  contract: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Zm0 0v6h6M8 13h8M8 17h8M8 9h1',
};

export default function Icon({ name, size = 18, className = '', strokeWidth = 1.8 }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name] || paths.pulse} />
    </svg>
  );
}
