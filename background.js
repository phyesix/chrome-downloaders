// CizgiVeDizi Video Link Extractor - Background Script

// Aynı anda taranan bölüm sayısı
const SCAN_CONCURRENCY = 3;
// Toplu indirmede iki video arasındaki bekleme (sibnet'i boğmamak için)
const DOWNLOAD_GAP_MS = 1500;

let scanQueue = [];
let scanResults = []; // bölüm sırasına göre slotlar (paralel taramada sıra korunur)
let isScanning = false;
let scanId = 0;
const scanTabIds = new Set();
let totalEpisodes = 0;
let completedEpisodes = 0;
let seriesTitle = '';

let downloadQueue = [];
let isDownloading = false;
let downloadedCount = 0;
let totalDownloads = 0;

chrome.runtime.onInstalled.addListener(() => {
  console.log("CizgiVeDizi Video Extractor yüklendi!");
});

// Uzantı yüklendiğinde önceki durumu geri yükle
async function loadState() {
  try {
    const data = await chrome.storage.local.get(['scanState']);
    if (data.scanState) {
      const state = data.scanState;
      // Sadece tarama sonuçlarını yükle (devam eden tarama değil)
      if (!state.isScanning && state.results && state.results.length > 0) {
        scanResults = state.results;
        totalEpisodes = state.total || state.results.length;
        completedEpisodes = state.completed || state.results.length;
        seriesTitle = state.seriesTitle || '';
      }
    }
  } catch (e) {
    console.error("State yükleme hatası:", e);
  }
}

// Başlangıçta state'i yükle
loadState();

function currentResults() {
  return scanResults.filter(Boolean);
}

async function saveState() {
  await chrome.storage.local.set({
    scanState: {
      isScanning,
      completed: completedEpisodes,
      total: totalEpisodes,
      results: currentResults(),
      seriesTitle,
      timestamp: Date.now()
    }
  });
}

function closeScanTabs() {
  for (const id of scanTabIds) chrome.tabs.remove(id).catch(() => { });
  scanTabIds.clear();
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  switch (request.action) {
    case "start_batch_scan":
      startBatchScan(request.episodes, request.seriesTitle);
      sendResponse({ status: "started", total: totalEpisodes });
      return;

    case "get_scan_status":
      sendResponse({
        isScanning,
        completed: completedEpisodes,
        total: totalEpisodes,
        results: currentResults(),
        seriesTitle
      });
      return;

    case "cancel_scan":
      isScanning = false;
      scanQueue = [];
      closeScanTabs();
      saveState();
      sendResponse({ status: "cancelled" });
      return;

    case "clear_results":
      isScanning = false;
      scanQueue = [];
      closeScanTabs();
      scanResults = [];
      completedEpisodes = 0;
      totalEpisodes = 0;
      seriesTitle = '';
      chrome.storage.local.remove(['scanState']);
      sendResponse({ status: "cleared" });
      return;

    case "get_direct_video_link":
      downloadVideoFromSibnet(request.sibnetUrl, request.filename || 'video.mp4')
        .then(result => sendResponse(result))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true; // async cevap

    case "start_batch_download":
      startBatchDownload(request.videos, request.seriesTitle);
      sendResponse({ status: "started" });
      return;

    case "get_download_status":
      sendResponse({
        isDownloading,
        completed: downloadedCount,
        total: totalDownloads
      });
      return;

    case "cancel_download":
      isDownloading = false;
      downloadQueue = [];
      sendResponse({ status: "cancelled" });
      return;
  }
});

// ---------------------------------------------------------------------------
// Toplu tarama
// ---------------------------------------------------------------------------

function startBatchScan(episodes, title) {
  closeScanTabs();
  const id = ++scanId;
  scanQueue = episodes.map((episode, index) => ({ episode, index }));
  scanResults = new Array(episodes.length);
  totalEpisodes = episodes.length;
  completedEpisodes = 0;
  isScanning = true;
  seriesTitle = title || '';
  saveState();

  const workers = [];
  for (let i = 0; i < Math.min(SCAN_CONCURRENCY, scanQueue.length); i++) {
    workers.push(scanWorker(id));
  }
  Promise.all(workers).then(() => {
    if (id !== scanId) return; // bu arada yeni tarama başladıysa dokunma
    isScanning = false;
    saveState();
  });
}

async function scanWorker(id) {
  while (isScanning && id === scanId && scanQueue.length > 0) {
    const { episode, index } = scanQueue.shift();

    let videoLink = null;
    try {
      videoLink = await findEpisodeVideoLink(episode.url, () => isScanning && id === scanId);
    } catch (e) {
      console.warn("Bölüm taranamadı:", episode.url, e);
    }

    if (id !== scanId) return;
    scanResults[index] = {
      episodeUrl: episode.url,
      episodeTitle: episode.title,
      videoLink
    };
    completedEpisodes++;
    saveState();
  }
}

async function findEpisodeVideoLink(url, stillActive) {
  // Hızlı yol: sayfayı sekme açmadan indirip HTML içinde ara
  const fromHtml = await fetchSibnetLink(url);
  if (fromHtml) return fromHtml;
  if (!stillActive()) return null;
  // Yedek yol: link JS ile sonradan ekleniyorsa sayfayı gerçek bir sekmede aç
  return scanEpisodeInTab(url, stillActive);
}

const IFRAME_SIBNET_RE = /<iframe\b[^>]*?\bsrc\s*=\s*["']([^"']*video\.sibnet\.ru[^"']*)["']/i;
const SIBNET_URL_RE = /(?:https?:)?\/\/video\.sibnet\.ru\/[^\s"'<>)\\]+/;

async function fetchSibnetLink(url) {
  try {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) return null;
    const html = await res.text();
    const match = html.match(IFRAME_SIBNET_RE) || html.match(SIBNET_URL_RE);
    if (!match) return null;
    let link = (match[1] || match[0]).replace(/&amp;/g, '&');
    if (link.startsWith('//')) link = 'https:' + link;
    return link;
  } catch (e) {
    return null;
  }
}

async function scanEpisodeInTab(url, stillActive) {
  const tab = await chrome.tabs.create({ url, active: false });
  scanTabIds.add(tab.id);

  try {
    await waitForTabLoad(tab.id);

    // Sabit beklemek yerine link görünene kadar kısa aralıklarla sor
    let injected = false;
    for (let i = 0; i < 20 && stillActive(); i++) {
      try {
        const response = await chrome.tabs.sendMessage(tab.id, { action: "get_sibnet_links" });
        if (response?.links?.length > 0) return response.links[0].url;
      } catch (e) {
        // Content script henüz yok (ör. sayfa sonradan yüklendi) - bir kez elle enjekte et
        if (!injected) {
          injected = true;
          await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }).catch(() => { });
          continue;
        }
      }
      await sleep(300);
    }
    return null;
  } finally {
    scanTabIds.delete(tab.id);
    chrome.tabs.remove(tab.id).catch(() => { });
  }
}

// ---------------------------------------------------------------------------
// İndirme
// ---------------------------------------------------------------------------

async function downloadVideoFromSibnet(sibnetUrl, filename) {
  const match = sibnetUrl.match(/videoid=(\d+)/);
  if (!match) {
    return { success: false, error: 'Video ID bulunamadı' };
  }

  const videoId = match[1];
  const shellUrl = `https://video.sibnet.ru/shell.php?videoid=${videoId}`;

  let tab = null;
  let cdnTab = null;

  try {
    // 1. Sibnet sayfasını aç (arka plan sekmelerinde medya başlamadığı için aktif)
    tab = await chrome.tabs.create({ url: shellUrl, active: true });
    await waitForTabLoad(tab.id);

    // 2. Play butonuna tıkla ve CDN URL bul
    const result = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms));
        const CDN_RE = /https:\/\/(cvs|dv)\d+(-\d+)?\.sibnet\.ru.*\.mp4/;

        // Oynatıcı hazır olana kadar bekle (en fazla ~5 sn)
        let video = null;
        let playBtn = null;
        for (let i = 0; i < 20; i++) {
          video = document.querySelector('video');
          playBtn = document.querySelector('.vjs-big-play-button');
          if (video || playBtn) break;
          await wait(250);
        }

        if (playBtn) playBtn.click();
        if (video) {
          video.muted = true;
          try { await video.play(); } catch (e) { }
        }

        // CDN URL için bekle (Performance API), en fazla ~30 sn
        let cdnUrl = null;
        for (let i = 0; i < 120 && !cdnUrl; i++) {
          const entry = performance.getEntriesByType('resource').find(e => CDN_RE.test(e.name));
          if (entry) {
            cdnUrl = entry.name;
          } else if (video && video.src && video.src.includes('.mp4')) {
            cdnUrl = video.src;
          } else {
            await wait(250);
          }
        }

        if (video) video.pause();
        return cdnUrl;
      }
    });

    const cdnUrl = result?.[0]?.result;

    // Shell sekmesini kapat
    await chrome.tabs.remove(tab.id).catch(() => { });
    tab = null;

    if (!cdnUrl) {
      return { success: false, error: 'Video URL bulunamadı' };
    }

    if (!cdnUrl.includes('.mp4')) {
      return { success: false, error: 'Geçersiz URL (mp4 değil): ' + cdnUrl.substring(0, 60) };
    }

    // 3. CDN sekmesini aç
    cdnTab = await chrome.tabs.create({ url: cdnUrl, active: true });
    await waitForTabLoad(cdnTab.id);
    await sleep(500);

    // 4. Sekme içinden indirme başlat (a.download ile) ve Chrome indirmeyi oluşturana kadar bekle
    const downloadCreated = waitForDownloadCreated(15000);
    await chrome.scripting.executeScript({
      target: { tabId: cdnTab.id },
      func: (fname) => {
        const a = document.createElement('a');
        a.href = window.location.href;
        a.download = fname;
        document.body.appendChild(a);
        a.click();
        a.remove();
      },
      args: [filename]
    });
    await downloadCreated;

    return { success: true, cdnUrl };

  } catch (err) {
    console.error("İndirme hatası:", err);
    return { success: false, error: err.message };
  } finally {
    if (tab) chrome.tabs.remove(tab.id).catch(() => { });
    if (cdnTab) chrome.tabs.remove(cdnTab.id).catch(() => { });
  }
}

async function startBatchDownload(videos, title) {
  if (isDownloading) return;
  downloadQueue = videos.filter(v => v.videoLink);
  totalDownloads = downloadQueue.length;
  downloadedCount = 0;
  isDownloading = true;
  seriesTitle = title || seriesTitle;

  while (isDownloading && downloadQueue.length > 0) {
    const video = downloadQueue.shift();
    downloadedCount++;

    const safeTitle = (video.episodeTitle || 'video')
      .replace(/[^a-zA-Z0-9ğüşıöçĞÜŞİÖÇ _-]/g, '')
      .substring(0, 80);

    const result = await downloadVideoFromSibnet(video.videoLink, safeTitle + '.mp4');
    if (!result.success) console.error("İndirme hatası:", video.videoLink, result.error);

    if (downloadQueue.length > 0) await sleep(DOWNLOAD_GAP_MS);
  }

  isDownloading = false;
}

// ---------------------------------------------------------------------------
// Yardımcılar
// ---------------------------------------------------------------------------

function waitForDownloadCreated(timeoutMs) {
  return new Promise((resolve) => {
    const timeout = setTimeout(done, timeoutMs);
    function done(item) {
      clearTimeout(timeout);
      chrome.downloads.onCreated.removeListener(done);
      resolve(item || null);
    }
    chrome.downloads.onCreated.addListener(done);
  });
}

function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    const timeout = setTimeout(done, 30000);

    function done() {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }

    function listener(id, info) {
      if (id === tabId && info.status === 'complete') done();
    }

    chrome.tabs.onUpdated.addListener(listener);

    chrome.tabs.get(tabId)
      .then(tab => { if (tab.status === 'complete') done(); })
      .catch(done);
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
