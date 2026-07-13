import "dotenv/config";

const PORT = Number(process.env.BRIDGE_PORT) || 3001;

console.log(`[bridge] starting on port ${PORT}`);
console.log("[bridge] iMessage listener/sender — Photon SDK integration goes here");
