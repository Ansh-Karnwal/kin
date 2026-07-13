import "dotenv/config";
import express from "express";

const PORT = Number(process.env.AGENT_PORT) || 3000;

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "hearth-agent" });
});

app.listen(PORT, () => {
  console.log(`[agent] Gemini-powered brain listening on port ${PORT}`);
});
