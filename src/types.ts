export type RoleCode = "HOP" | "CRW" | "VOL" | "PTR";
export type CategoryKey = "series" | "devotional" | "live" | "documentary" | "music";

export type AccentColor = "terracotta" | "rose" | "gold" | "sage" | "slate";
export type FontPairing = "modern" | "serif" | "editorial";
export type FontSizeToken = "small" | "default" | "large" | "xl";
export type DensityMode = "comfortable" | "compact";

export interface WorkspaceAppearance {
  accentColor: AccentColor;
  fontPairing: FontPairing;
}

export interface PersonAppearance {
  fontSize: FontSizeToken;
  density: DensityMode;
  photoUrl?: string | null;
}

export interface Person {
  personId: string; // DOF-P-CRW-004  (permanent, never regenerated)
  category: RoleCode; // editable (promotion) but the ID number never changes
  name: string;
  email: string;
  phone: string;
  skills: string[];
  equipmentFamiliarity: string[];
  hasLogin: boolean;
  status: "active" | "inactive";
  createdAt: string;
  username?: string; // what they sign in with. Set by the server when a login is made.
  loginOff?: boolean; // the Head of Production switched their login off
  notifyEmail?: boolean; // also wants reminders by email, on top of the ones in the app
  notifySms?: boolean; // and by text message
  appearance?: PersonAppearance;
}
