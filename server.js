const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const OUTPUT_DIR = path.join(__dirname, 'output');
const DEFAULT_COOKIES_FILE = path.join(__dirname, '.ddev', 'yt-dlp-cookies.txt');
const YT_DLP_BINARY = process.env.YT_DLP_BINARY || 'yt-dlp';
const FFMPEG_BINARY = process.env.FFMPEG_BINARY || 'ffmpeg';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

const jobs = new Map();

function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function parseSize(size) {
  const match = /^(\d+)\s*x\s*(\d+)$/i.exec(size.trim());
  if (!match) return null;
  return { width: Number(match[1]), height: Number(match[2]) };
}

function resolveCookiesFile() {
  const configured = process.env.YT_DLP_COOKIES_FILE;
  if (configured && fs.existsSync(configured)) return configured;
  if (fs.existsSync(DEFAULT_COOKIES_FILE)) return DEFAULT_COOKIES_FILE;
  return null;
}

function formatYtDlpError(code, stderr, cookiesFile) {
  const details = stderr ? `: ${stderr.trim()}` : '';
  if (/Sign in to confirm you.?re not a bot/i.test(stderr)) {
    const cookieHint = cookiesFile
      ? ` Current cookies file: ${cookiesFile}.`
      : ` Add a Netscape-format cookies file at ${DEFAULT_COOKIES_FILE} or set YT_DLP_COOKIES_FILE to its path.`;
    return `yt-dlp failed with code ${code}. YouTube is requiring authenticated cookies for this video.${cookieHint}${details}`;
  }

  return `yt-dlp failed with code ${code}${details}`;
}

app.get(['/output', '/output/'], async (_req, res) => {
  try {
    const entries = await fs.promises.readdir(OUTPUT_DIR, { withFileTypes: true });
    const files = await Promise.all(
      entries
        .filter((entry) => entry.isFile())
        .map(async (entry) => {
          const filePath = path.join(OUTPUT_DIR, entry.name);
          const stats = await fs.promises.stat(filePath);
          return {
            name: entry.name,
            mtimeMs: stats.mtimeMs,
          };
        })
    );

    files.sort((a, b) => b.mtimeMs - a.mtimeMs);

    const listItems = files.length
      ? files.map((file) => {
        const safeName = escapeHtml(file.name);
        return `<li><a href="/output/${encodeURIComponent(file.name)}">${safeName}</a></li>`;
      }).join('')
      : '<li>No GIFs available.</li>';

    res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Output Files</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; color: #0f172a; background: #f8fafc; }
    h1 { margin: 0 0 1rem; font-size: 1.5rem; }
    ul { padding-left: 1.25rem; }
    li + li { margin-top: 0.5rem; }
    a { color: #4f46e5; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <h1>output/</h1>
  <ul>${listItems}</ul>
</body>
</html>`);
  } catch (err) {
    res.status(500).send(`Failed to list output files: ${err.message}`);
  }
});

app.use('/output', express.static(OUTPUT_DIR));

app.post('/api/convert', (req, res) => {
  const { url, output, fps, size, beginTime, duration, verbose } = req.body;

  if (!url || !url.trim()) {
    return res.status(400).json({ error: 'YouTube URL is required' });
  }

  const jobId = crypto.randomUUID();
  const outputFilename = output && output.trim()
    ? (output.trim().endsWith('.gif') ? output.trim() : `${output.trim()}.gif`)
    : `${jobId}.gif`;
  const absoluteOutputPath = path.join(OUTPUT_DIR, outputFilename);
  const publicOutputPath = `/output/${outputFilename}`;
  const resolvedFps = fps ? Number(fps) : 30;
  const resolvedDuration = duration ? Number(duration) : 15;
  const resolvedBeginTime = beginTime !== undefined && beginTime !== '' ? Number(beginTime) : 3;
  const resolvedSize = (size && size.trim()) ? size.trim() : '640x360';
  const parsedSize = parseSize(resolvedSize);

  if (!parsedSize) {
    return res.status(400).json({ error: 'Output size must use WIDTHxHEIGHT format, e.g. 640x360' });
  }

  if (!Number.isFinite(resolvedFps) || resolvedFps <= 0) {
    return res.status(400).json({ error: 'FPS must be a number greater than 0' });
  }

  if (!Number.isFinite(resolvedDuration) || resolvedDuration <= 0) {
    return res.status(400).json({ error: 'Duration must be a number greater than 0' });
  }

  if (!Number.isFinite(resolvedBeginTime) || resolvedBeginTime < 0) {
    return res.status(400).json({ error: 'Start offset must be a number greater than or equal to 0' });
  }

  const job = {
    id: jobId,
    status: 'running',
    logs: [],
    outputPath: publicOutputPath,
    clients: new Set(),
  };

  jobs.set(jobId, job);

  const broadcast = (event) => {
    job.logs.push(event);
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    job.clients.forEach(client => client.write(payload));
  };

  const closeClients = () => {
    job.clients.forEach(client => client.end());
    job.clients.clear();
  };

  const finishJob = (success, message) => {
    job.status = success ? 'done' : 'error';
    if (success) {
      broadcast({ type: 'done', outputPath: publicOutputPath });
    } else {
      broadcast({ type: 'error', message });
    }
    closeClients();
    setTimeout(() => jobs.delete(jobId), 10 * 60 * 1000);
  };

  const failToStart = (err) => {
    job.status = 'error';
    broadcast({ type: 'error', message: `Failed to start process: ${err.message}` });
    closeClients();
  };

  res.json({ jobId });

  const ytDlpArgs = [
    '--get-url',
    '--format', 'best[ext=mp4]/best',
  ];
  const cookiesFile = resolveCookiesFile();

  if (cookiesFile) {
    ytDlpArgs.push('--cookies', cookiesFile);
  }

  ytDlpArgs.push(url.trim());

  if (verbose) {
    broadcast({ type: 'log', message: `$ ${YT_DLP_BINARY} ${ytDlpArgs.join(' ')}\n` });
  }

  const ytDlpProc = spawn(YT_DLP_BINARY, ytDlpArgs);
  let mediaUrl = '';
  let ytDlpStderr = '';

  ytDlpProc.stdout.on('data', (chunk) => {
    mediaUrl += chunk.toString();
  });

  ytDlpProc.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    ytDlpStderr += text;
    if (verbose) broadcast({ type: 'log', message: text });
  });

  ytDlpProc.on('error', failToStart);

  ytDlpProc.on('close', (code) => {
    if (code !== 0) {
      finishJob(false, formatYtDlpError(code, ytDlpStderr, cookiesFile));
      return;
    }

    const inputUrl = mediaUrl.trim().split('\n').find(Boolean);
    if (!inputUrl) {
      finishJob(false, 'yt-dlp did not return a downloadable media URL');
      return;
    }

    const ffmpegArgs = [
      '-y',
      '-ss', String(resolvedBeginTime),
      '-t', String(resolvedDuration),
      '-i', inputUrl,
      '-vf', `fps=${resolvedFps},scale=${parsedSize.width}:${parsedSize.height}:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`,
      absoluteOutputPath,
    ];

    if (verbose) {
      broadcast({ type: 'log', message: `$ ${FFMPEG_BINARY} ${ffmpegArgs.join(' ')}\n` });
    }

    const ffmpegProc = spawn(FFMPEG_BINARY, ffmpegArgs);

    ffmpegProc.stdout.on('data', (chunk) => {
      if (verbose) broadcast({ type: 'log', message: chunk.toString() });
    });

    ffmpegProc.stderr.on('data', (chunk) => {
      broadcast({ type: 'log', message: chunk.toString() });
    });

    ffmpegProc.on('error', failToStart);

    ffmpegProc.on('close', (ffmpegCode) => {
      if (ffmpegCode === 0 && fs.existsSync(absoluteOutputPath)) {
        finishJob(true);
      } else {
        finishJob(false, `ffmpeg failed with code ${ffmpegCode}`);
      }
    });
  });
});

app.get('/api/stream/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  job.logs.forEach(event => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });

  if (job.status !== 'running') {
    res.end();
    return;
  }

  job.clients.add(res);
  req.on('close', () => job.clients.delete(res));
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
