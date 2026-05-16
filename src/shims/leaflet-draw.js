// Shim: leaflet-draw is a pure IIFE side-effect package with no ESM exports.
// react-leaflet-draw imports it only to register draw handlers onto global L.
// This shim imports the real file for its side effects and exports a default
// so Rolldown/Vite 8's strict ESM binding check is satisfied.
import "leaflet-draw/dist/leaflet.draw.js";
export default {};
