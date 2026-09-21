import { LOGO_H, LOGO_PATH, LOGO_W } from "../brand/logo";

/** The DOF TV logo. It is drawn in the surrounding text colour, so it suits the day and night themes and printed paper by itself. */
export function Logo({ width = 132, className = "" }: { width?: number; className?: string }) {
  const height = Math.round((width * LOGO_H) / LOGO_W);
  return (
    <svg className={`dof-logo ${className}`.trim()} width={width} height={height} viewBox={`0 0 ${LOGO_W} ${LOGO_H}`} role="img" aria-label="DOF TV" fill="currentColor" fillRule="evenodd">
      <path d={LOGO_PATH} />
    </svg>
  );
}
