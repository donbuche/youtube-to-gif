/* =========================================================
   YouTube → GIF  |  Client-side app
   ========================================================= */

// ── Dark mode ──────────────────────────────────────────────
const html = document.documentElement;
const themeToggle = document.getElementById('theme-toggle');

const savedTheme = localStorage.getItem('theme');
if (savedTheme === 'light') html.classList.remove('dark');
else html.classList.add('dark');

themeToggle.addEventListener('click', () => {
  const isDark = html.classList.toggle('dark');
  localStorage.setItem('theme', isDark ? 'dark' : 'light');
});

// ── Lucide icons ───────────────────────────────────────────
lucide.createIcons();

// ── DOM refs ───────────────────────────────────────────────
const form            = document.getElementById('convert-form');
const submitBtn       = document.getElementById('submit-btn');
const btnText         = document.getElementById('btn-text');
const btnIcon         = document.getElementById('btn-icon');
const urlInput        = document.getElementById('url');
const urlError        = document.getElementById('url-error');

const progressCard    = document.getElementById('progress-card');
const logOutput       = document.getElementById('log-output');
const progressBar     = document.getElementById('progress-bar');
const statusBadge     = document.getElementById('status-badge');
const statusText      = document.getElementById('status-text');

const resultCard      = document.getElementById('result-card');
const resultGif       = document.getElementById('result-gif');
const downloadBtn     = document.getElementById('download-btn');
const newConvBtn      = document.getElementById('new-conversion-btn');

const errorCard       = document.getElementById('error-card');
const errorMessage    = document.getElementById('error-message');
const retryBtn        = document.getElementById('retry-btn');

// ── State ──────────────────────────────────────────────────
let activeEventSource = null;
let progressInterval  = null;
let fakeProgress      = 0;

// ── Helpers ────────────────────────────────────────────────
function show(el)  { el.classList.remove('hidden'); }
function hide(el)  { el.classList.add('hidden'); }

function setConverting(loading) {
  submitBtn.disabled = loading;
  if (loading) {
    btnText.textContent = 'Converting…';
    btnIcon.setAttribute('data-lucide', 'loader-2');
    btnIcon.classList.add('spinner');
  } else {
    btnText.textContent = 'Convert to GIF';
    btnIcon.setAttribute('data-lucide', 'wand-2');
    btnIcon.classList.remove('spinner');
  }
  lucide.createIcons();
}

function appendLog(text) {
  logOutput.textContent += text;
  logOutput.scrollTop = logOutput.scrollHeight;
}

function startFakeProgress() {
  fakeProgress = 0;
  progressBar.style.width = '0%';
  progressInterval = setInterval(() => {
    if (fakeProgress < 85) {
      fakeProgress += Math.random() * 3;
      progressBar.style.width = Math.min(fakeProgress, 85) + '%';
    }
  }, 800);
}

function finishProgress(success) {
  clearInterval(progressInterval);
  progressBar.style.width = success ? '100%' : fakeProgress + '%';
  if (success) {
    progressBar.classList.remove('bg-brand-500');
    progressBar.classList.add('bg-green-500');
  } else {
    progressBar.classList.remove('bg-brand-500');
    progressBar.classList.add('bg-red-500');
  }
}

function resetUI() {
  hide(progressCard);
  hide(resultCard);
  hide(errorCard);
  logOutput.textContent = '';
  progressBar.style.width = '0%';
  progressBar.classList.remove('bg-green-500', 'bg-red-500');
  progressBar.classList.add('bg-brand-500');
  statusText.textContent = 'Running';
  statusBadge.className = 'flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 text-xs font-medium';
  statusBadge.querySelector('span').className = 'w-1.5 h-1.5 rounded-full bg-amber-500 pulse-dot';

  if (activeEventSource) {
    activeEventSource.close();
    activeEventSource = null;
  }
  clearInterval(progressInterval);
}

function showError(msg) {
  finishProgress(false);
  setConverting(false);
  errorMessage.textContent = msg;
  show(errorCard);
  statusText.textContent = 'Failed';
  statusBadge.className = 'flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 text-xs font-medium';
}

// ── Form validation ────────────────────────────────────────
function validateUrl(value) {
  try {
    const u = new URL(value);
    return (u.hostname.includes('youtube.com') || u.hostname.includes('youtu.be'));
  } catch {
    return false;
  }
}

urlInput.addEventListener('input', () => {
  if (urlInput.value && !validateUrl(urlInput.value)) {
    urlError.classList.remove('hidden');
  } else {
    urlError.classList.add('hidden');
  }
});

// ── Form submit ────────────────────────────────────────────
form.addEventListener('submit', async (e) => {
  e.preventDefault();

  const url = urlInput.value.trim();
  if (!url) { urlError.classList.remove('hidden'); urlInput.focus(); return; }
  if (!validateUrl(url)) { urlError.classList.remove('hidden'); urlInput.focus(); return; }
  urlError.classList.add('hidden');

  resetUI();
  setConverting(true);
  show(progressCard);
  progressCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
  startFakeProgress();

  const payload = {
    url,
    output:    document.getElementById('output').value.trim() || null,
    fps:       document.getElementById('fps').value      || null,
    size:      document.getElementById('size').value     || null,
    beginTime: document.getElementById('beginTime').value !== '' ? document.getElementById('beginTime').value : null,
    duration:  document.getElementById('duration').value  || null,
    verbose:   document.getElementById('verbose').checked,
    thumb:     document.getElementById('thumb').checked,
  };

  let jobId;
  try {
    const res = await fetch('/api/convert', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Server error');
    jobId = data.jobId;
  } catch (err) {
    showError(err.message);
    return;
  }

  // ── SSE stream ──────────────────────────────────────────
  const es = new EventSource(`/api/stream/${jobId}`);
  activeEventSource = es;

  es.onmessage = (ev) => {
    const event = JSON.parse(ev.data);

    if (event.type === 'log') {
      appendLog(event.message);
    }

    if (event.type === 'done') {
      es.close();
      finishProgress(true);
      setConverting(false);

      statusText.textContent = 'Done';
      statusBadge.className = 'flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 text-xs font-medium';

      // Update spinner icon in progress card header
      const spinnerIcon = progressCard.querySelector('[data-lucide="loader-2"]');
      if (spinnerIcon) {
        spinnerIcon.setAttribute('data-lucide', 'check-circle-2');
        spinnerIcon.classList.remove('spinner');
        spinnerIcon.closest('.rounded-lg').classList.replace('bg-amber-100', 'bg-green-100');
        spinnerIcon.closest('.rounded-lg').classList.replace('dark:bg-amber-900/30', 'dark:bg-green-900/30');
        spinnerIcon.classList.replace('text-amber-600', 'text-green-600');
        spinnerIcon.classList.replace('dark:text-amber-400', 'dark:text-green-400');
        lucide.createIcons();
      }

      // Show result
      resultGif.src = event.outputPath;
      downloadBtn.href = event.outputPath;
      const filename = event.outputPath.split('/').pop();
      downloadBtn.setAttribute('download', filename);
      show(resultCard);
      resultCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    if (event.type === 'error') {
      es.close();
      showError(event.message || 'Conversion failed');
    }
  };

  es.onerror = () => {
    es.close();
    if (submitBtn.disabled) {
      showError('Lost connection to the server.');
    }
  };
});

// ── New conversion ─────────────────────────────────────────
newConvBtn.addEventListener('click', () => {
  resetUI();
  setConverting(false);
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

retryBtn.addEventListener('click', () => {
  resetUI();
  hide(errorCard);
  window.scrollTo({ top: 0, behavior: 'smooth' });
});
