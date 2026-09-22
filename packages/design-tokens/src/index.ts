export const colors = {
  ivory: "#F7F1E7",
  paper: "#FFFDF9",
  ink: "#201C18",
  mutedInk: "#756C63",
  quietInk: "#9A9086",
  coral: "#E76F51",
  coralDeep: "#C9523A",
  coralWash: "#FBE0D8",
  sage: "#587565",
  sageWash: "#DDE9DF",
  sky: "#547A94",
  skyWash: "#DDEBF2",
  line: "#E7DED4",
  danger: "#B84442",
  dangerWash: "#F8D9D7",
  white: "#FFFFFF",
  black: "#000000",
} as const;

export const spacing = {
  hairline: 1,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
} as const;

export const radii = {
  sm: 8,
  md: 14,
  lg: 20,
  xl: 28,
  pill: 999,
} as const;

export const typography = {
  display: { fontSize: 32, lineHeight: 38, fontWeight: "700" as const },
  title: { fontSize: 24, lineHeight: 30, fontWeight: "700" as const },
  heading: { fontSize: 18, lineHeight: 24, fontWeight: "700" as const },
  body: { fontSize: 16, lineHeight: 23, fontWeight: "400" as const },
  bodyStrong: { fontSize: 16, lineHeight: 23, fontWeight: "600" as const },
  caption: { fontSize: 13, lineHeight: 18, fontWeight: "500" as const },
  micro: { fontSize: 11, lineHeight: 15, fontWeight: "600" as const },
} as const;

export type ThemeMode = "light" | "dark";

export type OpenMuseTheme = {
  mode: ThemeMode;
  background: string;
  surface: string;
  elevatedSurface: string;
  ink: string;
  mutedInk: string;
  quietInk: string;
  accent: string;
  accentWash: string;
  line: string;
  danger: string;
  dangerWash: string;
  success: string;
  successWash: string;
};

export function getTheme(mode: ThemeMode = "light"): OpenMuseTheme {
  if (mode === "dark") {
    return {
      mode,
      background: "#1B1917",
      surface: "#26221F",
      elevatedSurface: "#302A26",
      ink: "#FFF9F2",
      mutedInk: "#D1C5B9",
      quietInk: "#A49688",
      accent: "#FF8A6B",
      accentWash: "#55332A",
      line: "#463C35",
      danger: "#FF938B",
      dangerWash: "#55302E",
      success: "#9BC8A5",
      successWash: "#2D4433",
    };
  }

  return {
    mode,
    background: colors.ivory,
    surface: colors.paper,
    elevatedSurface: colors.white,
    ink: colors.ink,
    mutedInk: colors.mutedInk,
    quietInk: colors.quietInk,
    accent: colors.coral,
    accentWash: colors.coralWash,
    line: colors.line,
    danger: colors.danger,
    dangerWash: colors.dangerWash,
    success: colors.sage,
    successWash: colors.sageWash,
  };
}

export const openMuseTokens = {
  colors,
  spacing,
  radii,
  typography,
} as const;
