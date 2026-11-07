/**
 * Loaded on demand when opening the player (keeps app startup small for TV).
 */
import Hls from "hls.js";

if (typeof window !== "undefined") {
  window.Hls = Hls;
}
