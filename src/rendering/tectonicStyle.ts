/**
 * Colours of the tectonic layers, following common geological map conventions:
 * divergent boundaries red, subduction zones black with black teeth, transforms
 * green, other boundaries grey; plate motion cyan; plates being subducted violet;
 * plates appearing green and disappearing orange.
 */

import type { TectonicStyle } from "../plates/symbols/tectonicScene";

/** RGBA, 0..1. */
export type StyleColor = [number, number, number, number];

export const TECTONIC_COLORS: Record<TectonicStyle, StyleColor> = {
  divergent: [0.93, 0.1, 0.1, 1],
  subduction: [0.04, 0.04, 0.07, 1],
  transform: [0.2, 0.85, 0.35, 1],
  other: [0.8, 0.8, 0.86, 1],
  motion: [0.55, 0.95, 1.0, 1],
  subductingFill: [0.55, 0.22, 0.85, 0.3],
  subductingOutline: [0.75, 0.5, 1.0, 1],
  appearOutline: [0.35, 1.0, 0.5, 1],
  vanishOutline: [1.0, 0.55, 0.15, 1],
};

/** Drawing order: translucent fills first, then outlines, then boundary symbols on top. */
export const TECTONIC_DRAW_ORDER: TectonicStyle[] = [
  "subductingFill",
  "subductingOutline",
  "appearOutline",
  "vanishOutline",
  "motion",
  "other",
  "transform",
  "divergent",
  "subduction",
];
