import express from "express";
import queue from "../core/queue.js";
import type { ConverterParams } from "../core/converter.js";

const app = express();
app.use(express.json());

app.post("/", async (req, res) => {
  const params: ConverterParams = req.body;

  if (!params) {
    res.status(400).json({ error: "Invalid params" });
    return;
  }

  if (!params.source) {
    res.status(400).json({ error: "provide source" });
    return;
  }

  if (!params.qualities) {
    res.status(400).json({ error: "provide qualities" });
    return;
  }

  if (!params.qualities.length) {
    res.status(400).json({ error: "provide at least one quality" });
    return;
  }

  for (const quality of params.qualities) {
    if (!quality.height) {
      res.status(400).json({ error: "provide quality height" });
      return;
    }

    if (typeof quality.height !== "number") {
      res.status(400).json({ error: "provide quality height as number" });
      return;
    }

    if (!quality.bitrate) {
      res.status(400).json({ error: "provide quality bitrate" });
      return;
    }

    if (typeof quality.bitrate !== "number") {
      res.status(400).json({ error: "provide quality bitrate as number" });
      return;
    }
  }

  if (!params.s3) {
    res.status(400).json({ error: "provide s3" });
    return;
  }

  if (!params.s3.bucket) {
    res.status(400).json({ error: "provide s3 bucket" });
    return;
  }

  if (!params.s3.region) {
    res.status(400).json({ error: "provide s3 region" });
    return;
  }

  if (!params.s3.accessKeyId) {
    res.status(400).json({ error: "provide s3 accessKeyId" });
    return;
  }

  if (!params.s3.secretAccessKey) {
    res.status(400).json({ error: "provide s3 secretAccessKey" });
    return;
  }

  if (!params.s3.path) {
    res.status(400).json({ error: "provide s3 path" });
    return;
  }

  if (!params.defaultAudioLang) {
    params.defaultAudioLang = "und";
  }

  if (!params.subtitles) {
    params.subtitles = [];
  }

  for (const subtitle of params.subtitles) {
    if (!subtitle.url) {
      res.status(400).json({ error: "provide subtitle url" });
      return;
    }

    if (!subtitle.language) {
      res.status(400).json({ error: "provide subtitle language" });
      return;
    }
  }

  const process: any = queue.push(params);
  res.status(200).json({ message: "Added to queue", ...process });
});

app.get("/", async (req, res) => {
  const limit = Number(req.query.limit || "100");
  const result = queue.listProcess(limit);

  if (!result) {
    res.status(404).json({ error: "No process found" });
    return;
  }

  res.status(200).json(result);
});

app.get("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const result = queue.getProcess(id);

  if (!result) {
    res.status(404).json({ error: "Process not found" });
    return;
  }

  res.status(200).json(result);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[SERVER] Listening on port ${PORT}`));
