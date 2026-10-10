// Recovered from inject.js (L2-L4), popup/popup.js (L96-L101), and content.js (L6171-L6186)
export const BRIDGE_TAG = "__colonistRecorder";
export const FORCE_KEY = "forceRecord";
export const ME_KEY = "me";
export const OVERLAY_KEY = "overlay";
export const WS_KEY = "recordWs";
export const HELPER_KEY = "helper";
export const MAPVIEW_KEY = "mapView";

export function gameIdFromLocation(loc: { search: string; hash: string }): string {
  const params = new URLSearchParams(loc.search);
  const fromQuery = params.get("gameId") ?? params.get("game");
  if (fromQuery) return fromQuery;
  const hash = loc.hash.replace(/^#/, "").replace(/^\/?/, "");
  if (/^[A-Za-z0-9_-]{3,}$/.test(hash)) return hash;
  return "";
}
