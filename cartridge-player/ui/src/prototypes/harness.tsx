// Prototype-only entry (prototype.html, dev only, never built). By default it renders the production interface over
// the simulator; `?setup` shows the first-run explorations, and `?explore=1` brings back the original Deck, Marquee
// and Receiver explorations. Each loads its own stylesheet, so none leaks into another.
const query = new URLSearchParams(location.search);
if (query.has("setup")) void import("./setup/harness.tsx");
else if (query.has("explore")) void import("./player/explore.tsx");
else void import("./sim-harness.tsx");
