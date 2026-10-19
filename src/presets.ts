import type { DeepPartial, PausecutConfig } from "./config.js";

/**
 * Named presets. They only override the tier/motion settings; VAD stays the same.
 */
export const presets: Record<string, { description: string; config: DeepPartial<PausecutConfig> }> = {
  talk: {
    description: "Talking-head / podcast. No on-screen action to protect; cut most pauses.",
    config: {
      tiers: { cutMin: 0.3, squeezeMin: 1.0, markerMin: 5.0, squeezeTo: 0.5 },
      motion: { enabled: false },
    },
  },
  gameplay: {
    description: "Commentary over gameplay / card games. Keeps pauses where the screen is moving.",
    config: {
      tiers: { cutMin: 0.3, squeezeMin: 1.0, markerMin: 4.0, squeezeTo: 0.6 },
      motion: { enabled: true, stillThreshold: 2.0, mode: "promote" },
    },
  },
  aggressive: {
    description: "Tight jump-cut style. Shorter thresholds, smaller padding.",
    config: {
      tiers: { cutMin: 0.2, squeezeMin: 0.8, markerMin: 3.0, squeezeTo: 0.4, padBefore: 0.05, padAfter: 0.05 },
      motion: { enabled: true, stillThreshold: 3.0, mode: "promote" },
    },
  },
  gentle: {
    description: "Only remove clearly dead air. Longer thresholds, more padding.",
    config: {
      tiers: { cutMin: 0.6, squeezeMin: 1.5, markerMin: 5.0, squeezeTo: 0.8, padBefore: 0.12, padAfter: 0.12 },
      motion: { enabled: true, stillThreshold: 1.5, mode: "promote" },
    },
  },
};
