'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

// =============================================
// CONFIGURATION
// =============================================
const CONFIG_FILE = path.join(__dirname, 'config.json');
const HARDCODED_API_KEY = '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';

// Flag set by the 'stop-bulk' IPC call; checked inside bulkAnalyze loops
let bulkStopRequested = false;

// Anthropic client — created once at startup and reused for all AI calls
let _anthropicClient = null;
function getAnthropicClient() {
  if (!_anthropicClient) {
    const Anthropic = require('@anthropic-ai/sdk');
    _anthropicClient = new Anthropic({ apiKey: CONFIG.apiKey });
  }
  return _anthropicClient;
}

let CONFIG = {
  apiKey: HARDCODED_API_KEY,
  // claude-sonnet-4-20250514 is ~10× cheaper and 3–5× faster than Sonnet.
  // Change to claude-sonnet-4-20250514 in Settings for richer (but slower/pricier) output.
  model: 'claude-sonnet-4-20250514',
  headless: false,
  timeout: 120000,
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  logFile: path.join(__dirname, 'analyzed_links_log.txt'),
  likesThresholds: [10000, 5000, 1000, 0],
  bulkLimits: { tiktok: 20, instagram: 10, youtube: 10 },
};

function loadConfig() {
  try {
    const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    // Never load apiKey from file — always use the hardcoded key
    const { apiKey: _ignored, ...rest } = saved;
    Object.assign(CONFIG, rest);
  } catch {}
  // Always enforce the hardcoded key
  CONFIG.apiKey = HARDCODED_API_KEY;
}

function saveConfigFile() {
  // Never persist the API key to disk
  const { model, headless, bulkLimits } = CONFIG;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ model, headless, bulkLimits }, null, 2));
}

// =============================================
// WINDOW MANAGEMENT
// =============================================
let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1000,
    minHeight: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
    title: 'ScrollStopper AI',
    backgroundColor: '#0f172a',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    show: false,
  });

  mainWindow.loadFile('index.html');
  mainWindow.once('ready-to-show', () => mainWindow.show());
}

app.whenReady().then(() => {
  loadConfig();
  initLogFile();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// =============================================
// LOG MANAGEMENT
// =============================================
function initLogFile() {
  if (!fs.existsSync(CONFIG.logFile)) {
    fs.writeFileSync(CONFIG.logFile, '', 'utf8');
  }
}

function normalizeUrl(url) {
  return url.split('?')[0].split('#')[0].toLowerCase().trim().replace(/\/$/, '');
}

function isDuplicate(url) {
  try {
    const norm = normalizeUrl(url);
    const content = fs.readFileSync(CONFIG.logFile, 'utf8');
    return content.split('\n').some((line) => {
      const n = normalizeUrl(line);
      return n.length > 5 && n === norm;
    });
  } catch {
    return false;
  }
}

function addToLog(url) {
  try {
    fs.appendFileSync(CONFIG.logFile, url.trim() + '\n', 'utf8');
  } catch (e) {
    console.error('Log write error:', e.message);
  }
}

// =============================================
// PLATFORM DETECTION
// =============================================
function detectPlatform(url) {
  if (url.includes('tiktok.com')) return 'tiktok';
  if (url.includes('instagram.com') && url.includes('/reel/')) return 'instagram';
  if (url.includes('youtube.com/shorts/')) return 'youtube';
  return null;
}

// =============================================
// LIKES PARSING  (e.g. "1.2K" → 1200)
// =============================================
function parseLikes(str) {
  if (!str || str === '-' || str === 'N/A') return 0;
  const s = String(str).replace(/,/g, '').trim().toUpperCase();
  const m = s.match(/([\d.]+)([KMB]?)/);
  if (!m) return 0;
  let n = parseFloat(m[1]);
  if (m[2] === 'K') n *= 1000;
  else if (m[2] === 'M') n *= 1000000;
  else if (m[2] === 'B') n *= 1000000000;
  return Math.round(n);
}

// =============================================
// ENGAGEMENT EXTRACTION — browser-context functions
// These run inside page.evaluate() (no Node.js scope access)
// =============================================
const FN_TIKTOK_ENGAGEMENT = () => {
  const r = { likes: '-', comments: '-', shares: '-' };

  // Strategy 1: any aria-label element  — "318.5K Likes", "1934 Comments", "14.2K Shares"
  for (const el of document.querySelectorAll('[aria-label]')) {
    const label = el.getAttribute('aria-label') || '';
    const lower = label.toLowerCase();
    const m = label.match(/^([\d.,]+[KkMmBb]?)\s/);
    if (m) {
      if (lower.includes('like'))    r.likes    = m[1];
      if (lower.includes('comment')) r.comments = m[1];
      if (lower.includes('share'))   r.shares   = m[1];
    }
  }
  if (r.likes !== '-') return r;

  // Strategy 2: data-e2e attributes TikTok uses internally
  const e2eMap = {
    likes:    ['like-count', 'browse-like-count'],
    comments: ['comment-count', 'browse-comment-count'],
    shares:   ['share-count', 'browse-share-count'],
  };
  for (const [key, attrs] of Object.entries(e2eMap)) {
    for (const attr of attrs) {
      const el = document.querySelector(`[data-e2e="${attr}"]`);
      if (el && el.textContent.trim()) { r[key] = el.textContent.trim(); break; }
    }
  }
  if (r.likes !== '-') return r;

  // Strategy 3: <strong> tags in the action sidebar (likes, comments, shares in order)
  const vals = Array.from(document.querySelectorAll('strong'))
    .map((s) => s.textContent.trim())
    .filter((t) => /^[\d.,]+[KkMmBb]?$/.test(t));
  if (vals[0]) r.likes    = vals[0];
  if (vals[1]) r.comments = vals[1];
  if (vals[2]) r.shares   = vals[2];

  return r;
};

const FN_INSTAGRAM_ENGAGEMENT = () => {
  const r = { likes: '-', comments: '-', shares: '-' };

  // Strategy 1: og:description — most reliable — "249K likes, 308 comments - @user on Instagram"
  const desc = document.querySelector('meta[property="og:description"]');
  if (desc) {
    const content = desc.getAttribute('content') || '';
    const lm = content.match(/([\d,.]+[KkMmBb]?)\s*Likes?/i);
    const cm = content.match(/([\d,.]+[KkMmBb]?)\s*Comments?/i);
    if (lm) r.likes    = lm[1];
    if (cm) r.comments = cm[1];
  }
  if (r.likes !== '-' && r.comments !== '-') return r;

  // Strategy 2: aria-label scan (anchors, buttons, sections)
  for (const el of document.querySelectorAll('[aria-label]')) {
    const label = el.getAttribute('aria-label') || '';
    if (r.likes === '-') {
      const lm = label.match(/^([\d,.]+[KkMmBb]?)\s*like/i);
      if (lm) r.likes = lm[1];
    }
    if (r.comments === '-') {
      const cm = label.match(/^([\d,.]+[KkMmBb]?)\s*comment/i);
      if (cm) r.comments = cm[1];
    }
  }
  if (r.likes !== '-') return r;

  // Strategy 3: full body text scan (last resort)
  const allText = document.body.innerText;
  if (r.likes === '-') {
    const lm = allText.match(/([\d,.]+[KkMmBb]?)\s+like/i);
    if (lm) r.likes = lm[1];
  }
  if (r.comments === '-') {
    const cm = allText.match(/([\d,.]+[KkMmBb]?)\s+comment/i);
    if (cm) r.comments = cm[1];
  }

  return r;
};

// Returns { likes, comments, remixes } — caller maps remixes→shares
const FN_YOUTUBE_ENGAGEMENT = () => {
  const r = { likes: '-', comments: '-', remixes: '-' };

  // Strategy 1: like-button-view-model → span.yt-core-attributed-string (most precise)
  const likeBtn = document.querySelector('like-button-view-model');
  if (likeBtn) {
    const spans = likeBtn.querySelectorAll('span.yt-core-attributed-string, span');
    for (const s of spans) {
      const t = s.textContent.trim();
      if (/^[\d,.]+[KkMm]?$/.test(t)) { r.likes = t; break; }
    }
    if (r.likes === '-') {
      const lbl = likeBtn.getAttribute('aria-label') || '';
      const m = lbl.match(/([\d,.]+)\s*thousand\s*other/i);
      if (m) r.likes = m[1] + 'K';
    }
  }

  // Strategy 2: broad aria-label scan — any number adjacent to "remix" or "sample"
  for (const el of document.querySelectorAll('[aria-label]')) {
    const label = el.getAttribute('aria-label') || '';

    if (r.comments === '-') {
      const cm = label.match(/^View ([\d,.]+[KkMm]?)\s*comments?/i);
      if (cm) r.comments = cm[1];
    }
    if (r.likes === '-') {
      const lm = label.match(/along with ([\d,.]+)\s*thousand\s*other people/i);
      if (lm) r.likes = lm[1] + 'K';
    }
    if (r.remixes === '-' && /remix|sample/i.test(label)) {
      // Handles: "1.1K Remixes", "Remix · 1.1K", "1.1K videos remixed", "Sample this video (1.1K)"
      const rm = label.match(/([\d,.]+[KkMm]?)\s*(?:remix|sample)/i) ||
                 label.match(/(?:remix|sample)[^0-9]*([\d,.]+[KkMm]?)/i);
      if (rm) r.remixes = rm[1];
    }
  }

  // Strategy 3: ytInitialData inline scripts — search all scripts with remix/sample data
  try {
    for (const s of document.querySelectorAll('script:not([src])')) {
      const t = s.textContent;
      const relevant = t.includes('ytInitialData') || t.includes('likeCountText') ||
                       t.includes('remix') || t.includes('sample');
      if (!relevant) continue;

      if (r.likes === '-') {
        const m = t.match(/"likeCountText"[^}]*?"simpleText"\s*:\s*"([^"]+)"/);
        if (m) r.likes = m[1];
      }
      if (r.comments === '-') {
        const m = t.match(/"commentCountText"[^}]*?"simpleText"\s*:\s*"([^"]+)"/);
        if (m) r.comments = m[1];
      }
      if (r.remixes === '-') {
        // Try every known field name YouTube has used for remix/sample counts
        const tries = [
          t.match(/"sampledVideoCountText"[^}]{0,300}"simpleText"\s*:\s*"([^"]+)"/),
          t.match(/"reusedVideoCount"\s*:\s*(\d+)/),
          t.match(/"sampleButtonRenderer"[^}]{0,500}"simpleText"\s*:\s*"([\d.,]+[KkMm]?)"/),
          t.match(/(?:remix|sample)[^"]{0,150}"simpleText"\s*:\s*"([\d.,]+[KkMm]?)"/i),
          t.match(/"shortsRemixButtonViewModel"[^}]{0,500}"content"\s*:\s*"([\d.,]+[KkMm]?)"/),
          t.match(/"reelCreationButtonViewModel"[^}]{0,500}"content"\s*:\s*"([\d.,]+[KkMm]?)"/),
        ];
        for (const m of tries) {
          if (m) { r.remixes = m[1]; break; }
        }
      }
      if (r.likes !== '-' && r.comments !== '-' && r.remixes !== '-') break;
    }
  } catch {}

  // Strategy 4: comment count heading fallback
  if (r.comments === '-') {
    for (const el of document.querySelectorAll('yt-formatted-string, h2, span')) {
      const m = el.textContent.trim().match(/^([\d,.]+[KkMm]?)\s*Comments?$/i);
      if (m) { r.comments = m[1]; break; }
    }
  }

  // Strategy 5: scan button/action elements whose text contains "remix" or "sample"
  // YouTube Shorts shows count as a text node sibling to the button label
  if (r.remixes === '-') {
    const candidates = document.querySelectorAll(
      'yt-button-view-model, yt-button-shape, ytd-button-renderer, ' +
      'ytd-shorts-reuse-button, [class*="remix"], [class*="sample"], button'
    );
    for (const el of candidates) {
      const text  = el.textContent.trim();
      const label = el.getAttribute('aria-label') || '';
      if (!/remix|sample/i.test(text + label)) continue;
      // Extract first number-like token (e.g. "1.1K\nRemix" → "1.1K")
      const m = text.match(/([\d,.]+[KkMm]?)/);
      if (m) { r.remixes = m[1]; break; }
    }
  }

  return r;
};

// =============================================
// VIDEO INFO EXTRACTION
// =============================================
async function getInfo(url) {
  const { chromium } = require('playwright');
  const platform = detectPlatform(url);
  if (!platform) throw new Error(`Unsupported URL: ${url}`);

  const browser = await chromium.launch({
    headless: CONFIG.headless,
    args: ['--disable-blink-features=AutomationControlled', '--no-first-run'],
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 720 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
    },
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {}, app: {} };
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  });
  const page = await context.newPage();

  const info = {
    platform,
    url,
    creator: '-',
    caption: '-',
    duration: '-',
    likes: '-',
    comments: '-',
    shares: '-',
    sharesLabel: platform === 'youtube' ? 'Remixes' : 'Shares',
  };

  try {
    if (platform === 'tiktok') {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: CONFIG.timeout });
      await page.waitForTimeout(7000);

      const creatorM = url.match(/@([^/?#]+)/);
      info.creator = creatorM ? `@${creatorM[1]}` : '-';

      info.caption = await page.evaluate(
        () => document.querySelector('meta[property="og:description"]')?.content || '-'
      );

      const dur = await page.evaluate(() => document.querySelector('video')?.duration || 0);
      info.duration = dur > 0 ? `${Math.round(dur)}s` : '-';

      const eng = await page.evaluate(FN_TIKTOK_ENGAGEMENT);
      info.likes = eng.likes;
      info.comments = eng.comments;
      info.shares = eng.shares;
    } else if (platform === 'instagram') {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: CONFIG.timeout });
      await page.waitForTimeout(7000);

      info.caption = await page.evaluate(
        () => document.querySelector('meta[property="og:description"]')?.content || '-'
      );

      info.creator = await page.evaluate(() => {
        // Level 1: header/article anchor links
        for (const a of document.querySelectorAll('header a, article a, [role="link"]')) {
          const href = a.getAttribute('href') || '';
          const text = a.textContent.trim();
          if (/^\/[a-zA-Z0-9_.]+\/?$/.test(href) && text && text.length < 50 && !/\s/.test(text)) {
            return `@${text.replace('@', '')}`;
          }
        }
        // Level 2: JSON-LD structured data
        try {
          const ld = document.querySelector('script[type="application/ld+json"]');
          if (ld) {
            const d = JSON.parse(ld.textContent);
            const auth = d.author?.identifier || d.author?.name || d.creator?.identifier;
            if (auth) return `@${auth.replace('@', '')}`;
          }
        } catch {}
        // Level 3: og:title @mention
        const ogTitle = document.querySelector('meta[property="og:title"]')?.content || '';
        const m = ogTitle.match(/@([a-zA-Z0-9_.]+)/);
        if (m) return `@${m[1]}`;
        return '-';
      });

      const dur = await page.evaluate(() => document.querySelector('video')?.duration || 0);
      info.duration = dur > 0 ? `${Math.round(dur)}s` : '-';

      const eng = await page.evaluate(FN_INSTAGRAM_ENGAGEMENT);
      info.likes = eng.likes;
      info.comments = eng.comments;
      info.shares = eng.shares;
    } else if (platform === 'youtube') {
      await page.goto(url, { waitUntil: 'networkidle', timeout: CONFIG.timeout });
      await page.waitForTimeout(5000);

      info.creator = await page.evaluate(() => {
        const a =
          document.querySelector('a[href^="/@"]') ||
          document.querySelector('#owner a') ||
          document.querySelector('ytd-channel-name a');
        if (!a) return '-';
        const text = a.textContent.trim();
        const hrefMatch = a.getAttribute('href')?.match(/@[^/]+/);
        return text || (hrefMatch ? hrefMatch[0] : '-');
      });

      info.caption = await page.evaluate(
        () =>
          document.querySelector('meta[name="title"]')?.content ||
          document.querySelector('meta[property="og:title"]')?.content ||
          '-'
      );

      let dur = await page.evaluate(() => document.querySelector('video')?.duration || 0);
      if (dur === 0) {
        await page.waitForTimeout(3000);
        dur = await page.evaluate(() => document.querySelector('video')?.duration || 0);
      }
      info.duration = dur > 0 ? `${Math.round(dur)}s` : '-';

      const eng = await page.evaluate(FN_YOUTUBE_ENGAGEMENT);
      info.likes = eng.likes;
      info.comments = eng.comments;
      info.shares = eng.remixes; // YouTube exposes remix count, not share count
    }
  } finally {
    await browser.close();
  }

  return info;
}

// =============================================
// AI ANALYSIS
// =============================================
async function analyze(info) {
  const client = getAnthropicClient();

  const prompt = `You are an expert viral content strategist and cinematographer analyzing a short-form video (TikTok/Instagram Reel/YouTube Short) to understand exactly why it went viral and how to recreate it.

Video Details:
- Platform: ${info.platform}
- Creator: ${info.creator}
- Duration: ${info.duration}
- Caption: ${info.caption}
- Likes: ${info.likes}
- Comments: ${info.comments}
- ${info.sharesLabel || 'Shares'}: ${info.shares}

You MUST output your analysis with EXACTLY THESE HEADERS, wrapped in triple equals signs, no deviations:

===VIRAL===
Analyze WHY this video went viral across these dimensions and why your analysis is accurate and reliable.
For each bullet below, first write the explanation in **English**, then on the very next line provide a fluent **Simplified Chinese** translation of that same explanation.
- HOOK: What happens in the first 1-3 seconds that stops the scroll? What makes it impossible to swipe away?
- EMOTION: What core emotion does this trigger (curiosity, desire, FOMO, relatability, shock, joy)? How is it sustained throughout?
- PACING & RETENTION: How does the video structure maintain watch time? Where are the re-watch triggers?
- SOCIAL PROOF & TRUST: What signals credibility or authenticity? Why does the audience trust this creator?
- SHAREABILITY: What makes someone want to send this to a friend or repost it? What is the "send this to someone who..." factor?
- TREND ALIGNMENT: What current trends, sounds, formats, or cultural moments does this tap into?
- COMMENT BAIT: What in the video is designed to provoke comments, debate, or responses?

===LENS===
Analyze the cinematographic and visual language of this video that caused the video to go viral and why your analysis is accurate and reliable.
For each bullet below, first write the explanation in **English**, then on the very next line provide a fluent **Simplified Chinese** translation of that same explanation.
- SHOT COMPOSITION: Describe the framing, rule of thirds usage, negative space, and subject placement
- CAMERA MOVEMENT: Is the camera static, handheld, tracking? What does the movement (or stillness) communicate emotionally?
- LIGHTING: Natural or artificial? Hard or soft light? What mood does the lighting create?
- COLOR GRADING & PALETTE: What colors dominate? What is the overall tone (warm, cool, desaturated, vivid)? What feeling does this evoke?
- EDITING RHYTHM: How fast are the cuts? Are transitions matched to music beats? What editing style is used (jump cuts, montage, single continuous shot)?
- TEXT & GRAPHICS OVERLAY: How is on-screen text used? Font style, placement, timing — what role does it play in the narrative?
- SOUND DESIGN: Is there voiceover, trending audio, original sound, or silence? How does the audio drive the emotional arc?
- CREATOR PRESENCE: How does the creator appear on screen — facing camera, off-camera, POV? What body language and energy do they project?

===AI PROMPT===
Write a single, highly detailed paragraph that a video creator could hand directly to an AI or use as a production brief to recreate this exact video.
Write **two versions of this paragraph in one block**: first in **English**, then immediately after that, an equivalent **Simplified Chinese** paragraph. Both paragraphs should include: the opening hook shot, the creator's on-screen presence and energy, the visual aesthetic and color grade, the pacing and editing style, the emotional arc from start to finish, the type of audio or music to use, any text overlays and their timing, and the closing moment or call-to-action. Be specific enough that someone who has never seen the original video could recreate it frame-by-frame.`;

  const response = await client.messages.create({
    model: CONFIG.model,
    max_tokens: 3000,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].text;
  const viralM = text.match(/===VIRAL===([\s\S]*?)(?====LENS===|$)/);
  const lensM = text.match(/===LENS===([\s\S]*?)(?====AI PROMPT===|$)/);
  const promptM = text.match(/===AI PROMPT===([\s\S]*?)$/);

  // Strip any echoed prompt instruction lines at the top of each section.
  // The AI sometimes copies back the "Analyze WHY..." / "Analyze the cinematographic..."
  // directive before giving its actual answer — remove those lead-in sentences.
  // The section text starts with \n (char right after ===VIRAL===) so we must
  // trimStart() before the ^ anchor check, otherwise the regex never matches.
  const stripEcho = (raw) => {
    if (!raw) return '';
    const t = raw.trimStart();
    // Remove any leading lines that start with "Analyze" (echoed prompt instruction)
    return t.replace(/^Analyze\b[^\n]*\n*/gi, '').trim();
  };

  return {
    viral: stripEcho(viralM?.[1] || text),
    lens: stripEcho(lensM?.[1] || ''),
    aiPrompt: (promptM?.[1] || '').trim(),
  };
}

// =============================================
// URL SCRAPING
// =============================================
async function scrapeUrls(platform, keyword, limit) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({
    headless: CONFIG.headless,
    args: [
      '--window-size=1280,900',
      // Prevents sites from detecting Playwright via the automation flag
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });
  const context = await browser.newContext({
    // Up-to-date Chrome UA — old version strings are another detection signal
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
    },
  });

  // Inject into every page/tab opened from this context — must run before any navigation
  await context.addInitScript(() => {
    // Hide the webdriver flag that Instagram, TikTok, and others check first
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    // Provide the chrome object real Chrome always has
    window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {}, app: {} };
    // Realistic plugin list (automation browsers report 0 plugins)
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  });

  let page = await context.newPage(); // let — Instagram logic may close/reopen the tab
  const urls = new Set();

  try {
    if (platform === 'tiktok') {
      const searchUrl = `https://www.tiktok.com/search?q=${encodeURIComponent(keyword)}&t=${Date.now()}`;
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.timeout });
      // TikTok needs extra time to render dynamic search results
      await page.waitForTimeout(10000);

      let stalls = 0;
      for (let i = 0; i < 35 && urls.size < limit; i++) {
        const links = await page.evaluate(() => {
          const seen = new Set();
          const result = [];
          document.querySelectorAll('a[href*="/video/"]').forEach((a) => {
            if (a.href && !seen.has(a.href)) {
              seen.add(a.href);
              result.push(a.href);
            }
          });
          return result;
        });
        const prev = urls.size;
        links.forEach((u) => urls.add(u.split('?')[0]));
        if (urls.size === prev) {
          if (++stalls >= 3) break;
        } else {
          stalls = 0;
        }

        // TikTok search uses an internal scroll container — try each selector
        // before falling back to window scroll (same approach as original Python code)
        await page.evaluate(() => {
          const STEP = 800;
          const selectors = [
            '[class*="DivSearchResultContainer"]',
            '[class*="search-result"]',
            '[class*="SearchResult"]',
            '[class*="DivContentContainer"]',
            'main',
            '#main-content',
          ];
          for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el && el.scrollHeight > el.clientHeight) {
              el.scrollBy(0, STEP);
              break;
            }
          }
          // Always also nudge the window as a fallback
          window.scrollBy(0, 800);
        });
        await page.waitForTimeout(2500);
      }
    } else if (platform === 'instagram') {
      // Instagram hashtags have no spaces — strip all whitespace so "sausage dog"
      // becomes /explore/tags/sausagedog/ instead of /explore/tags/sausage%20dog/
      // which Instagram rejects with a login redirect.
      const igTag = keyword.replace(/\s+/g, '');
      const searchUrl = `https://www.instagram.com/explore/tags/${encodeURIComponent(igTag)}/`;

      // Instagram sometimes redirects to the login wall.
      // Refreshing the same tab does nothing — close it and open a brand-new tab instead.
      const openFreshTab = async () => {
        await page.close();
        page = await context.newPage();
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.timeout });
        await page.waitForTimeout(5000);
      };

      // Initial load
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.timeout });
      await page.waitForTimeout(5000);

      // Retry with a fresh tab up to 3 times if stuck on login
      for (let attempt = 1; attempt <= 3 && page.url().includes('accounts/login'); attempt++) {
        await page.waitForTimeout(2000 * attempt); // short pause before reopening
        await openFreshTab();
      }

      // If still on login page after all retries, skip Instagram
      if (page.url().includes('accounts/login')) {
        return Array.from(urls);
      }

      for (let i = 0; i < 15 && urls.size < limit; i++) {
        // If redirected to login mid-scroll, close and reopen a fresh tab
        if (page.url().includes('accounts/login')) {
          await openFreshTab();
          if (page.url().includes('accounts/login')) break; // still blocked — give up
        }

        const links = await page.evaluate(() =>
          Array.from(document.querySelectorAll('a[href*="/reel/"]'))
            .map((a) => {
              const m = a.href.match(/\/reel\/([^/?#]+)/);
              return m ? `https://www.instagram.com/reel/${m[1]}/` : null;
            })
            .filter(Boolean)
        );
        links.forEach((u) => urls.add(u));
        await page.evaluate(() => window.scrollBy(0, 1000));
        await page.waitForTimeout(2000);
      }
    } else if (platform === 'youtube') {
      const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(keyword + ' shorts')}&sp=EgIYAQ%253D%253D`;
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.timeout });
      await page.waitForTimeout(5000);

      for (let i = 0; i < 15 && urls.size < limit; i++) {
        const links = await page.evaluate(() =>
          Array.from(document.querySelectorAll('a[href*="/shorts/"]'))
            .map((a) => {
              const m = a.href.match(/\/shorts\/([^/?#]+)/);
              return m ? `https://www.youtube.com/shorts/${m[1]}` : null;
            })
            .filter(Boolean)
        );
        links.forEach((u) => urls.add(u));
        await page.evaluate(() => window.scrollBy(0, 1000));
        await page.waitForTimeout(2000);
      }
    }
  } finally {
    await browser.close();
  }

  return Array.from(urls).slice(0, limit);
}

// =============================================
// BULK ANALYSIS — STREAMING + TIERED LIKES FILTER
// =============================================

// Immediately run AI on one video and stream the result to the frontend
async function analyzeAndEmit(info, selected, allResults, send) {
  if (selected.has(info.url)) return;
  selected.add(info.url);

  const likesLabel = info.likes !== '-' ? `${info.likes} likes` : 'unknown likes';
  send({ type: 'log', message: `  ✓ Qualifies (${likesLabel}) — running AI analysis...`, level: 'success' });

  try {
    const analysis = await analyze(info);
    addToLog(info.url);
    const result = { info, analysis, status: 'success' };
    allResults.push(result);
    send({ type: 'result', result });
    send({ type: 'log', message: `  ✓ Analysis complete`, level: 'success' });
  } catch (e) {
    const result = { info, analysis: null, status: 'failed', error: e.message };
    allResults.push(result);
    send({ type: 'result', result });
    send({ type: 'log', message: `  ✗ Analysis failed: ${e.message}`, level: 'error' });
  }
}

async function bulkAnalyze(keyword, platforms, limit, thresholds) {
  bulkStopRequested = false; // reset for this run

  const send = (data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('bulk-progress', data);
    }
  };

  const allResults = [];

  for (const platform of platforms) {
    if (bulkStopRequested) break;
    send({ type: 'header', message: `${platform.toUpperCase()}` });

    try {
      // Instagram (without login) surfaces at most 24 videos on the explore/tags page
      const INSTAGRAM_MAX = 24;
      const effectiveLimit = platform === 'instagram' ? Math.min(limit, INSTAGRAM_MAX) : limit;
      if (platform === 'instagram' && limit > INSTAGRAM_MAX) {
        send({ type: 'log', message: `Instagram limit capped at ${INSTAGRAM_MAX} (max available without login)`, level: 'warn' });
      }
      // Scrape at least 20 candidates (or 4× limit, whichever is larger) so that
      // small requests (e.g. limit=1 → only 4 candidates) don't miss higher-liked
      // videos that appear slightly further down the page.
      const CANDIDATE_MIN = 20;
      const scrapeTarget = platform === 'instagram'
        ? Math.min(Math.max(effectiveLimit * 4, CANDIDATE_MIN), INSTAGRAM_MAX)
        : Math.max(effectiveLimit * 4, CANDIDATE_MIN);
      send({ type: 'log', message: `Target: ${effectiveLimit} video(s). Collecting up to ${scrapeTarget} candidates...` });

      let candidateUrls;
      try {
        candidateUrls = await scrapeUrls(platform, keyword, scrapeTarget);
      } catch (e) {
        send({ type: 'log', message: `Scrape error: ${e.message}`, level: 'error' });
        continue;
      }

      const freshUrls = candidateUrls.filter((u) => !isDuplicate(u));
      const skipped = candidateUrls.length - freshUrls.length;
      if (skipped > 0) send({ type: 'log', message: `Skipped ${skipped} already-analyzed` });
      send({ type: 'log', message: `${freshUrls.length} fresh URLs to evaluate` });

      if (freshUrls.length === 0) {
        send({ type: 'log', message: `No fresh URLs found for ${platform}`, level: 'warn' });
        continue;
      }

      // Use caller-supplied thresholds (from the editable UI) or fall back to config defaults
      const activeThresholds = (Array.isArray(thresholds) && thresholds.length)
        ? thresholds
        : CONFIG.likesThresholds;
      const selected = new Set(); // urls that have been (or are being) analyzed
      const infoCache = []; // {info} entries fetched so far — reused for tier fallback

      // Phase 1: Fetch metadata one-by-one; analyze immediately if meets 10K+ threshold.
      // Stop fetching as soon as quota is filled.
      send({ type: 'log', message: `Fetching metadata — qualifying videos analyzed immediately (10K+ first)...` });

      for (let i = 0; i < freshUrls.length && selected.size < effectiveLimit; i++) {
        if (bulkStopRequested) break;
        const url = freshUrls[i];
        const shortUrl = url.length > 60 ? url.substring(0, 57) + '...' : url;
        send({ type: 'log', message: `[${i + 1}/${freshUrls.length}] ${shortUrl}` });

        let info;
        try {
          info = await getInfo(url);
          infoCache.push(info);
          send({ type: 'log', message: `  → Likes: ${info.likes}  Comments: ${info.comments}  Duration: ${info.duration}` });
        } catch (e) {
          send({ type: 'log', message: `  → Error: ${e.message}`, level: 'error' });
          continue;
        }

        if (parseLikes(info.likes) >= activeThresholds[0]) {
          await analyzeAndEmit(info, selected, allResults, send);
        }
      }

      if (bulkStopRequested) break;

      // Phase 2–4: Tiered fallback — re-scan the already-fetched cache at lower thresholds.
      // No extra network calls; just re-evaluate what we already have.
      for (let t = 1; t < activeThresholds.length && selected.size < effectiveLimit; t++) {
        if (bulkStopRequested) break;
        const threshold = activeThresholds[t];
        const prevLabel = activeThresholds[t - 1] >= 1000 ? `${activeThresholds[t - 1] / 1000}K` : String(activeThresholds[t - 1]);
        const nextLabel = threshold > 0 ? `${threshold >= 1000 ? threshold / 1000 + 'K' : threshold}+` : 'any likes';
        send({
          type: 'log',
          message: `Only ${selected.size}/${effectiveLimit} with ${prevLabel}+ — lowering to ${nextLabel}...`,
          level: 'warn',
        });

        for (const info of infoCache) {
          if (bulkStopRequested || selected.size >= effectiveLimit) break;
          if (selected.has(info.url)) continue;
          if (parseLikes(info.likes) >= threshold) {
            await analyzeAndEmit(info, selected, allResults, send);
          }
        }
      }

      send({
        type: 'log',
        message: `Completed: ${selected.size}/${effectiveLimit} video(s) analyzed for ${platform}`,
        level: selected.size > 0 ? 'success' : 'warn',
      });
    } catch (e) {
      send({ type: 'log', message: `Unexpected error for ${platform}: ${e.message}`, level: 'error' });
    }
  }

  if (bulkStopRequested) {
    send({ type: 'stopped', totalCount: allResults.length });
  } else {
    send({ type: 'complete', totalCount: allResults.length });
  }
  bulkStopRequested = false;
  return allResults;
}

// =============================================
// IPC HANDLERS
// =============================================
ipcMain.handle('analyze-single', async (_event, { url }) => {
  if (!url || !url.trim()) return { success: false, error: 'Please enter a URL.' };

  const trimmed = url.trim();
  const platform = detectPlatform(trimmed);
  if (!platform) {
    return {
      success: false,
      error: 'Unsupported platform. Please use a TikTok, Instagram Reel, or YouTube Shorts URL.',
    };
  }
  if (isDuplicate(trimmed)) {
    return { success: false, error: 'This URL has already been analyzed (found in history log).' };
  }

  try {
    const info = await getInfo(trimmed);
    const analysis = await analyze(info);
    addToLog(trimmed);
    return { success: true, info, analysis };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('stop-bulk', () => {
  bulkStopRequested = true;
  return { success: true };
});

ipcMain.handle('analyze-bulk', async (_event, { keyword, platforms, limit, thresholds }) => {
  if (!keyword || !keyword.trim()) return { success: false, error: 'Please enter a keyword.' };
  if (!platforms || platforms.length === 0)
    return { success: false, error: 'Please select at least one platform.' };
  try {
    await bulkAnalyze(keyword.trim(), platforms, parseInt(limit) || 10, thresholds);
    return { success: true };
  } catch (e) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('bulk-progress', { type: 'error', message: e.message });
    }
    return { success: false, error: e.message };
  }
});

ipcMain.handle('export-excel', async (_event, { rows }) => {
  try {
    const { filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Export as Excel',
      defaultPath: `video-analysis-${new Date().toISOString().split('T')[0]}.xlsx`,
      filters: [{ name: 'Excel Workbook', extensions: ['xlsx'] }],
    });
    if (!filePath) return { success: false, cancelled: true };

    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    wb.creator = 'ScrollStopper AI';
    wb.created = new Date();

    const ws = wb.addWorksheet('Video Analysis');
    ws.columns = [
      { header: '#', key: 'num', width: 5 },
      { header: 'Platform', key: 'platform', width: 13 },
      { header: 'Creator', key: 'creator', width: 22 },
      { header: 'Likes', key: 'likes', width: 12 },
      { header: 'Comments', key: 'comments', width: 12 },
      { header: 'Shares / Remixes', key: 'shares', width: 14 },
      { header: 'Duration', key: 'duration', width: 10 },
      { header: 'Caption', key: 'caption', width: 55 },
      { header: 'URL', key: 'url', width: 55 },
      { header: 'Viral Mechanics Analysis', key: 'viral', width: 80 },
      { header: 'Lens Language Analysis', key: 'lens', width: 80 },
      { header: 'AI Recreation Prompt', key: 'aiPrompt', width: 80 },
    ];

    // Style header row
    const headerRow = ws.getRow(1);
    headerRow.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: 'FF1A1A2E' }, size: 11 };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFC9D7' } };
      cell.alignment = { wrapText: true, vertical: 'middle' };
      cell.border = {
        bottom: { style: 'medium', color: { argb: 'FF3730A3' } },
      };
    });
    headerRow.height = 22;

    // Add data rows
    rows.forEach((row, i) => {
      const r = ws.addRow({ num: i + 1, ...row });
      r.alignment = { wrapText: true, vertical: 'top' };
      r.height = 80;
      // Alternate row shading
      if (i % 2 === 1) {
        r.eachCell((cell) => {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8F7FF' } };
        });
      }
    });

    await wb.xlsx.writeFile(filePath);
    shell.showItemInFolder(filePath);
    return { success: true, filePath };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// =============================================
// PDF HTML GENERATOR
// =============================================
function generatePdfHtml(results) {
  const esc = (s) =>
    String(s || '-')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

  // Replace newlines with <br> for readable multi-line content in PDF
  const nl2br = (s) => esc(s).replace(/\n/g, '<br>');

  const platformColors = { tiktok: '#69C9D0', instagram: '#e1306c', youtube: '#ff0000' };

  const rows = results
    .map((r, i) => {
      const { info, analysis } = r;
      const color = platformColors[info.platform] || '#6366f1';
      return `<tr>
        <td class="c-num">${i + 1}</td>
        <td><span class="badge" style="color:${color};border-color:${color}">${esc(info.platform)}</span></td>
        <td class="c-creator">${esc(info.creator)}</td>
        <td class="c-stat">${esc(info.likes)}</td>
        <td class="c-stat">${esc(info.comments)}</td>
        <td class="c-stat">${esc(info.shares)}</td>
        <td class="c-stat">${esc(info.duration)}</td>
        <td class="c-caption">${esc(info.caption)}</td>
        <td class="c-analysis">${nl2br(analysis?.viral || '-')}</td>
        <td class="c-analysis">${nl2br(analysis?.lens || '-')}</td>
        <td class="c-analysis">${nl2br(analysis?.aiPrompt || '-')}</td>
      </tr>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
  @page { size: A3 landscape; margin: 10mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, Arial, Helvetica, sans-serif; font-size: 8.5px; color: #1e293b; }
  .report-header { margin-bottom: 10px; }
  .report-header h1 { font-size: 15px; font-weight: 700; color: #0f172a; }
  .report-header p { font-size: 10px; color: #64748b; margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  thead th {
    background: #FFC9D7; color: #1a1a2e;
    padding: 7px 8px; text-align: left;
    font-size: 8px; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.4px;
    border-right: 1px solid #ffafc2;
  }
  tbody td {
    padding: 7px 8px; vertical-align: top;
    border-bottom: 1px solid #e2e8f0;
    border-right: 1px solid #f1f5f9;
    line-height: 1.55; word-break: break-word;
  }
  tbody tr:nth-child(even) td { background: #fff5f7; }
  tbody tr:hover td { background: #ffe4ec; }
  .badge {
    display: inline-block; border: 1px solid;
    padding: 1px 6px; border-radius: 10px;
    font-size: 7.5px; font-weight: 700; white-space: nowrap;
  }
  .c-num  { width: 2%;  text-align: center; color: #94a3b8; }
  .c-platform { width: 7%; }
  .c-creator  { width: 9%; font-weight: 600; }
  .c-stat     { width: 5%; text-align: right; color: #475569; }
  .c-caption  { width: 12%; color: #334155; }
  .c-analysis { width: 18.33%; color: #1e293b; }
</style>
</head>
<body>
<div class="report-header">
  <h1>Video Viral Analysis Report</h1>
  <p>Generated ${new Date().toLocaleString()} &nbsp;·&nbsp; ${results.length} video(s) analysed</p>
</div>
<table>
  <colgroup>
    <col style="width:2%">   <!-- # -->
    <col style="width:7%">   <!-- Platform -->
    <col style="width:9%">   <!-- Creator -->
    <col style="width:5%">   <!-- Likes -->
    <col style="width:5%">   <!-- Comments -->
    <col style="width:4%">   <!-- Shares -->
    <col style="width:4%">   <!-- Duration -->
    <col style="width:12%">  <!-- Caption -->
    <col style="width:17.3%"> <!-- Viral -->
    <col style="width:17.3%"> <!-- Lens -->
    <col style="width:17.4%"> <!-- AI Prompt -->
  </colgroup>
  <thead>
    <tr>
      <th>#</th>
      <th>Platform</th>
      <th>Creator</th>
      <th>Likes</th>
      <th>Cmts</th>
      <th>Shares/Remix</th>
      <th>Dur</th>
      <th>Caption</th>
      <th>Viral Mechanics</th>
      <th>Lens Analysis</th>
      <th>AI Recreation Prompt</th>
    </tr>
  </thead>
  <tbody>${rows}</tbody>
</table>
</body></html>`;
}

ipcMain.handle('export-pdf', async (_event, { results }) => {
  try {
    const { filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Export as PDF',
      defaultPath: `video-analysis-${new Date().toISOString().split('T')[0]}.pdf`,
      filters: [{ name: 'PDF Document', extensions: ['pdf'] }],
    });
    if (!filePath) return { success: false, cancelled: true };

    // Write full-data HTML to a temp file
    const tmpHtml = path.join(os.tmpdir(), `vva-pdf-${Date.now()}.html`);
    fs.writeFileSync(tmpHtml, generatePdfHtml(results), 'utf8');

    // Render in a hidden window and print to PDF
    const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false } });
    await win.loadFile(tmpHtml);
    await new Promise((res) => setTimeout(res, 1500)); // Let CSS/fonts settle

    const pdfBuffer = await win.webContents.printToPDF({
      printBackground: true,
      landscape: true,
      pageSize: 'A3',
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
    });

    win.close();
    try { fs.unlinkSync(tmpHtml); } catch {}

    fs.writeFileSync(filePath, pdfBuffer);
    shell.showItemInFolder(filePath);
    return { success: true, filePath };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('write-clipboard', (_event, text) => {
  clipboard.writeText(text);
  return true;
});

ipcMain.handle('get-config', () => ({
  // apiKey intentionally omitted — never exposed to renderer
  model: CONFIG.model,
  headless: CONFIG.headless,
  bulkLimits: CONFIG.bulkLimits,
}));

ipcMain.handle('save-config', (_event, newConfig) => {
  // apiKey is never accepted from renderer — hardcoded key always used
  if (newConfig.model !== undefined) CONFIG.model = newConfig.model;
  if (newConfig.headless !== undefined) CONFIG.headless = newConfig.headless;
  if (newConfig.bulkLimits !== undefined) CONFIG.bulkLimits = newConfig.bulkLimits;
  saveConfigFile();
  return { success: true };
});

ipcMain.handle('open-external', (_event, url) => {
  shell.openExternal(url);
  return true;
});

ipcMain.handle('clear-history', () => {
  fs.writeFileSync(CONFIG.logFile, '', 'utf8');
  return { success: true };
});

ipcMain.handle('get-history-count', () => {
  try {
    const lines = fs.readFileSync(CONFIG.logFile, 'utf8').split('\n').filter((l) => l.trim().length > 5);
    return { count: lines.length };
  } catch {
    return { count: 0 };
  }
});

ipcMain.handle('get-history-urls', () => {
  try {
    const content = fs.readFileSync(CONFIG.logFile, 'utf8');
    const urls = content
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 5);
    return { urls };
  } catch {
    return { urls: [] };
  }
});

ipcMain.handle('remove-history-urls', (_event, { urlsToRemove }) => {
  try {
    const removeSet = new Set(urlsToRemove.map((u) => normalizeUrl(u)));
    const content = fs.readFileSync(CONFIG.logFile, 'utf8');
    const remaining = content
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 5 && !removeSet.has(normalizeUrl(l)));
    fs.writeFileSync(CONFIG.logFile, remaining.join('\n') + (remaining.length ? '\n' : ''), 'utf8');
    return { success: true, removed: urlsToRemove.length };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('add-history-url', (_event, { url }) => {
  if (!url || !url.trim()) return { success: false, error: 'Empty URL' };
  addToLog(url.trim());
  return { success: true };
});
