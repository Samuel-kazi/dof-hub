/** Sunrise mark: the app's identity, on an orange tile. */
export function Logo({ size = 52 }: { size?: number }) {
  return (
    <div className="logo" style={{ width: size, height: size }} aria-hidden="true">
      <svg width={size * 0.55} height={size * 0.55} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 17a7 7 0 0 1 14 0" />
        <path d="M2.5 17h19" />
        <path d="M12 4.5v2.5M4.6 8.6l1.8 1.8M19.4 8.6l-1.8 1.8" />
        <path d="M7 20.5h10" />
      </svg>
    </div>
  );
}
