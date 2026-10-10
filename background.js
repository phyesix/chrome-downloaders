// CizgiVeDizi Video Link Extractor - Background Script
// STABLE VERSION

let scanQueue = [];
let scanResults = [];
let isScanning = false;
let currentScanTabId = null;
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
        console.log("Önceki tarama sonuçları yüklendi:", scanResults.length, "sonuç");
      }
    }
  } catch (e) {
    console.error("State yükleme hatası:", e);
  }
}

// Başlangıçta state'i yükle
loadState();

async function saveState() {
  await chrome.storage.local.set({
    scanState: {
      isScanning,
      completed: completedEpisodes,
      total: totalEpisodes,
      results: scanResults,
      seriesTitle,
      timestamp: Date.now()
    }
  });
}


chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "start_batch_scan") {
    scanQueue = [...request.episodes];
    scanResults = [];
    totalEpisodes = scanQueue.length;
    completedEpisodes = 0;
    isScanning = true;
    seriesTitle = request.seriesTitle || '';
    saveState();
    processNextEpisode();
    sendResponse({ status: "started", total: totalEpisodes });
    return true;
  }

  if (request.action === "get_scan_status") {
    sendResponse({
      isScanning,
      completed: completedEpisodes,
      total: totalEpisodes,
      results: scanResults,
      seriesTitle
    });
    return true;
  }

  if (request.action === "cancel_scan") {
    isScanning = false;
    scanQueue = [];
    if (currentScanTabId) {
      chrome.tabs.remove(currentScanTabId).catch(() => { });
      currentScanTabId = null;
    }
    saveState();
    sendResponse({ status: "cancelled" });
    return true;
  }

  if (request.action === "clear_results") {
    scanResults = [];
    completedEpisodes = 0;
    totalEpisodes = 0;
    isScanning = false;
    seriesTitle = '';
    chrome.storage.local.remove(['scanState']);
    sendResponse({ status: "cleared" });
    return true;
  }

  if (request.action === "get_direct_video_link") {
    downloadVideoFromSibnet(request.sibnetUrl, request.filename || 'video.mp4')
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === "start_batch_download") {
    startBatchDownload(request.videos, request.seriesTitle);
    sendResponse({ status: "started" });
    return true;
  }

  if (request.action === "get_download_status") {
    sendResponse({
      isDownloading,
      completed: downloadedCount,
      total: totalDownloads
    });
    return true;
  }

  if (request.action === "cancel_download") {
    isDownloading = false;
    downloadQueue = [];
    sendResponse({ status: "cancelled" });
    return true;
  }

  return true;
});

async function downloadVideoFromSibnet(sibnetUrl, filename) {
  console.log("=== VIDEO İNDİRME (Chrome Downloads API) ===");
  console.log("URL:", sibnetUrl);
  console.log("Dosya:", filename);

  const match = sibnetUrl.match(/videoid=(\d+)/);
  if (!match) {
    return { success: false, error: 'Video ID bulunamadı' };
  }

  const videoId = match[1];
  const shellUrl = `https://video.sibnet.ru/shell.php?videoid=${videoId}`;

  let tab = null;

  try {
    // 1. Sibnet sayfasını aç
    console.log("1. Sibnet sayfası açılıyor...");
    tab = await chrome.tabs.create({ url: shellUrl, active: true });

    // Sayfa yüklenmesini bekle
    await waitForTabLoad(tab.id);
    await sleep(3000);

    // 2. Play butonuna tıkla ve CDN URL bul
    console.log("2. Video URL aranıyor...");
    const result = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async () => {
        // Play butonuna bas
        const playBtn = document.querySelector('.vjs-big-play-button');
        if (playBtn) {
          playBtn.click();
          console.log("Play butonuna tıklandı");
        }

        // Video elementini bul ve oynat
        const video = document.querySelector('video');
        if (video) {
          video.muted = true;
          try { await video.play(); } catch (e) { }
        }

        // CDN URL için bekle (Performance API)
        let cdnUrl = null;
        for (let i = 0; i < 60; i++) {
          await new Promise(r => setTimeout(r, 500));

          const entries = performance.getEntriesByType('resource');
          for (const entry of entries) {
            if (entry.name.match(/https:\/\/(cvs|dv)\d+(-\d+)?\.sibnet\.ru.*\.mp4/)) {
              cdnUrl = entry.name;
              break;
            }
          }

          if (cdnUrl) break;

          // Video src'den de dene
          if (video && video.src && video.src.includes('.mp4')) {
            cdnUrl = video.src;
            break;
          }
        }

        if (video) video.pause();

        return cdnUrl;
      }
    });

    const cdnUrl = result?.[0]?.result;

    // Shell sekmesini kapat
    if (tab) {
      await chrome.tabs.remove(tab.id).catch(() => { });
      tab = null;
    }

    if (!cdnUrl) {
      return { success: false, error: 'Video URL bulunamadı' };
    }

    console.log("CDN URL bulundu:", cdnUrl);

    // MP4 kontrolü
    if (!cdnUrl.includes('.mp4')) {
      return { success: false, error: 'Geçersiz URL (mp4 değil): ' + cdnUrl.substring(0, 60) };
    }

    // 3. CDN sekmesini aç
    console.log("3. CDN sekmesi açılıyor...");
    const cdnTab = await chrome.tabs.create({ url: cdnUrl, active: true });

    await waitForTabLoad(cdnTab.id);
    await sleep(2000);

    // 4. Sekme içinden indirme başlat (a.download ile)
    console.log("4. Sekme içinden indirme başlatılıyor...");
    await chrome.scripting.executeScript({
      target: { tabId: cdnTab.id },
      func: (fname) => {
        const a = document.createElement('a');
        a.href = window.location.href;
        a.download = fname;
        document.body.appendChild(a);
        a.click();
        a.remove();
        console.log("İndirme linki tıklandı:", fname);
      },
      args: [filename]
    });

    console.log("İndirme başlatıldı");

    // Biraz bekle ve CDN sekmesini kapat
    await sleep(3000);
    try { await chrome.tabs.remove(cdnTab.id); } catch { }

    return { success: true, cdnUrl };

  } catch (err) {
    console.error("Hata:", err);
    if (tab) await chrome.tabs.remove(tab.id).catch(() => { });
    return { success: false, error: err.message };
  }
}

async function startBatchDownload(videos, title) {
  downloadQueue = videos.filter(v => v.videoLink);
  totalDownloads = downloadQueue.length;
  downloadedCount = 0;
  isDownloading = true;
  seriesTitle = title || '';

  console.log(`=== TOPLU İNDİRME: ${totalDownloads} video ===`);
  processNextDownload();
}

async function processNextDownload() {
  if (!isDownloading || downloadQueue.length === 0) {
    isDownloading = false;
    console.log("=== TOPLU İNDİRME TAMAMLANDI ===");
    return;
  }

  const video = downloadQueue.shift();
  downloadedCount++;

  const safeTitle = (video.episodeTitle || 'video')
    .replace(/[^a-zA-Z0-9ğüşıöçĞÜŞİÖÇ _-]/g, '')
    .substring(0, 80);
  const filename = safeTitle + '.mp4';

  console.log(`[${downloadedCount}/${totalDownloads}] İndiriliyor: ${filename}`);

  try {
    await downloadVideoFromSibnet(video.videoLink, filename);
  } catch (e) {
    console.error("İndirme hatası:", e);
  }

  await sleep(3000);
  processNextDownload();
}

async function processNextEpisode() {
  if (!isScanning || scanQueue.length === 0) {
    isScanning = false;
    await saveState();
    return;
  }

  const episode = scanQueue.shift();
  completedEpisodes++;

  try {
    const tab = await chrome.tabs.create({ url: episode.url, active: false });
    currentScanTabId = tab.id;

    await waitForTabLoad(tab.id);
    await sleep(2000);

    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js']
      });
    } catch (e) { }

    await sleep(500);

    let videoLink = null;
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { action: "get_sibnet_links" });
      if (response && response.links && response.links.length > 0) {
        videoLink = response.links[0].url;
      }
    } catch (e) { }

    scanResults.push({
      episodeUrl: episode.url,
      episodeTitle: episode.title,
      videoLink
    });

    await saveState();
    await chrome.tabs.remove(tab.id).catch(() => { });
    currentScanTabId = null;

  } catch (err) {
    scanResults.push({
      episodeUrl: episode.url,
      episodeTitle: episode.title,
      videoLink: null
    });
    await saveState();
    if (currentScanTabId) {
      await chrome.tabs.remove(currentScanTabId).catch(() => { });
      currentScanTabId = null;
    }
  }

  await sleep(300);
  processNextEpisode();
}

function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 30000);

    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);

    chrome.tabs.get(tabId).then(tab => {
      if (tab.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }).catch(() => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
