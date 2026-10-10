document.addEventListener('DOMContentLoaded', async () => {
    // Elements
    const pageTitle = document.getElementById('pageTitle');
    const pageDesc = document.getElementById('pageDesc');
    const seriesView = document.getElementById('seriesView');
    const episodeView = document.getElementById('episodeView');
    const unknownView = document.getElementById('unknownView');
    const seasonSelector = document.getElementById('seasonSelector');
    const seasonButtons = document.getElementById('seasonButtons');
    const selectedEpisodeCount = document.getElementById('selectedEpisodeCount');
    const scanAllBtn = document.getElementById('scanAllBtn');
    const scanCurrentBtn = document.getElementById('scanCurrentBtn');
    const cancelBtn = document.getElementById('cancelBtn');
    const spinner = document.getElementById('spinner');
    const btnText = document.getElementById('btnText');
    const progressContainer = document.getElementById('progressContainer');
    const progressFill = document.getElementById('progressFill');
    const progressText = document.getElementById('progressText');
    const downloadProgressContainer = document.getElementById('downloadProgressContainer');
    const downloadProgressFill = document.getElementById('downloadProgressFill');
    const downloadProgressText = document.getElementById('downloadProgressText');
    const results = document.getElementById('results');
    const linkList = document.getElementById('linkList');
    const linkCountDisplay = document.getElementById('linkCountDisplay');
    const copyAllBtn = document.getElementById('copyAllBtn');
    const exportBtn = document.getElementById('exportBtn');
    const downloadAllBtn = document.getElementById('downloadAllBtn');
    const statusMsg = document.getElementById('statusMsg');
    const directUrlInput = document.getElementById('directUrlInput');
    const directDownloadBtn = document.getElementById('directDownloadBtn');
    const directDownloadStatus = document.getElementById('directDownloadStatus');

    let allEpisodes = [];
    let episodesBySeason = {};
    let selectedSeasons = new Set();
    let scanResults = [];
    let statusCheckInterval = null;
    let seriesTitle = '';
    let isDownloading = false;
    let downloadQueue = [];
    let downloadedCount = 0;

    // ÖNCELİKLE: Kayıtlı durumu kontrol et
    await checkSavedState();

    async function checkSavedState() {
        return new Promise((resolve) => {
            chrome.runtime.sendMessage({ action: "get_scan_status" }, (response) => {
                // Eğer tarama devam ediyorsa veya sonuçlar varsa, bunları göster
                if (response && (response.isScanning || response.results?.length > 0)) {
                    showSavedState(response);
                    if (response.isScanning) {
                        startStatusCheck();
                    }
                    resolve(true); // Kayıtlı durum gösterildi, getPageInfo çağırma
                } else {
                    // Sonuç yoksa mevcut sayfayı kontrol et
                    getPageInfo().then(() => resolve(false));
                }
            });
        });
    }


    function showSavedState(state) {
        pageTitle.textContent = state.isScanning ? '⏳ Tarama Devam Ediyor' : '✅ Son Tarama Sonuçları';
        pageDesc.textContent = state.seriesTitle || 'Önceki tarama';
        seriesTitle = state.seriesTitle || '';

        seriesView.style.display = 'block';
        episodeView.style.display = 'none';
        unknownView.style.display = 'none';
        seasonSelector.style.display = 'none';

        if (state.isScanning) {
            scanAllBtn.disabled = true;
            spinner.style.display = 'inline-block';
            btnText.textContent = 'Tarama devam ediyor...';
            progressContainer.style.display = 'block';

            const percent = state.total > 0 ? (state.completed / state.total) * 100 : 0;
            progressFill.style.width = percent + '%';
            progressText.textContent = `Taranıyor... ${state.completed} / ${state.total}`;
        } else {
            scanAllBtn.style.display = 'none';
            progressContainer.style.display = 'none';
        }

        if (state.results && state.results.length > 0) {
            displayResults(state.results);
        }

        addNewScanButton();
    }

    function addNewScanButton() {
        let newScanBtn = document.getElementById('newScanBtn');
        if (!newScanBtn) {
            newScanBtn = document.createElement('button');
            newScanBtn.id = 'newScanBtn';
            newScanBtn.className = 'scan-btn';
            newScanBtn.style.marginTop = '10px';
            newScanBtn.style.background = 'linear-gradient(135deg, #17a2b8 0%, #138496 100%)';
            newScanBtn.innerHTML = '🔄 Yeni Tarama Başlat';
            newScanBtn.addEventListener('click', async () => {
                chrome.runtime.sendMessage({ action: "clear_results" }, () => {
                    location.reload();
                });
            });

            const container = document.querySelector('.container');
            container.appendChild(newScanBtn);
        }
    }

    async function getPageInfo() {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

            if (!tab || !tab.url.includes('cizgivedizi.com')) {
                showUnknownView();
                return;
            }

            try {
                const response = await chrome.tabs.sendMessage(tab.id, { action: "get_page_info" });
                handlePageInfo(response);
            } catch (e) {
                await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    files: ['content.js']
                });

                setTimeout(async () => {
                    try {
                        const response = await chrome.tabs.sendMessage(tab.id, { action: "get_page_info" });
                        handlePageInfo(response);
                    } catch (err) {
                        showUnknownView();
                    }
                }, 500);
            }
        } catch (err) {
            console.error("Hata:", err);
            showUnknownView();
        }
    }

    function handlePageInfo(response) {
        if (!response) {
            showUnknownView();
            return;
        }

        if (response.pageType === 'series') {
            showSeriesView(response);
        } else if (response.pageType === 'episode') {
            showEpisodeView(response);
        } else {
            showUnknownView();
        }
    }

    function showSeriesView(data) {
        seriesTitle = data.title.replace(' Türkçe İzle', '').replace(' izle', '').trim();

        pageTitle.textContent = '📺 Dizi Sayfası';
        pageDesc.textContent = seriesTitle;

        seriesView.style.display = 'block';
        episodeView.style.display = 'none';
        unknownView.style.display = 'none';
        seasonSelector.style.display = 'block';
        scanAllBtn.style.display = 'flex';

        allEpisodes = data.episodes;
        groupEpisodesBySeason(data);
        createSeasonButtons(data);
        updateSelectedCount();
    }

    function groupEpisodesBySeason(data) {
        episodesBySeason = { 'all': allEpisodes };

        if (data.seasons && data.seasons.length > 1) {
            data.seasons.forEach(season => {
                if (!season.isAll) {
                    episodesBySeason[season.seasonNum] = [];
                }
            });

            const seasonsCount = data.seasons.filter(s => !s.isAll).length;
            const episodesPerSeason = Math.ceil(allEpisodes.length / seasonsCount);

            allEpisodes.forEach((ep, index) => {
                const seasonNum = Math.floor(index / episodesPerSeason) + 1;
                if (episodesBySeason[seasonNum]) {
                    episodesBySeason[seasonNum].push(ep);
                }
            });
        }
    }

    function createSeasonButtons(data) {
        seasonButtons.innerHTML = '';

        const allBtn = document.createElement('button');
        allBtn.className = 'season-btn all-btn selected';
        allBtn.textContent = `📺 Tümü (${allEpisodes.length})`;
        allBtn.dataset.season = 'all';
        seasonButtons.appendChild(allBtn);
        selectedSeasons.add('all');

        if (data.seasons && data.seasons.length > 1) {
            data.seasons.forEach(season => {
                if (!season.isAll) {
                    const btn = document.createElement('button');
                    btn.className = 'season-btn';
                    const count = episodesBySeason[season.seasonNum]?.length || 0;
                    btn.textContent = `${season.seasonNum}. Sezon (${count})`;
                    btn.dataset.season = season.seasonNum;
                    seasonButtons.appendChild(btn);
                }
            });
        }

        seasonButtons.querySelectorAll('.season-btn').forEach(btn => {
            btn.addEventListener('click', () => handleSeasonClick(btn));
        });
    }

    function handleSeasonClick(clickedBtn) {
        const season = clickedBtn.dataset.season;

        if (season === 'all') {
            selectedSeasons.clear();
            selectedSeasons.add('all');
            seasonButtons.querySelectorAll('.season-btn').forEach(btn => btn.classList.remove('selected'));
            clickedBtn.classList.add('selected');
        } else {
            selectedSeasons.delete('all');
            seasonButtons.querySelector('[data-season="all"]').classList.remove('selected');

            if (selectedSeasons.has(season)) {
                selectedSeasons.delete(season);
                clickedBtn.classList.remove('selected');
            } else {
                selectedSeasons.add(season);
                clickedBtn.classList.add('selected');
            }

            if (selectedSeasons.size === 0) {
                selectedSeasons.add('all');
                seasonButtons.querySelector('[data-season="all"]').classList.add('selected');
            }
        }

        updateSelectedCount();
    }

    function updateSelectedCount() {
        const episodes = getSelectedEpisodes();
        selectedEpisodeCount.textContent = episodes.length;
    }

    function getSelectedEpisodes() {
        if (selectedSeasons.has('all')) return allEpisodes;
        let episodes = [];
        selectedSeasons.forEach(season => {
            if (episodesBySeason[season]) {
                episodes = episodes.concat(episodesBySeason[season]);
            }
        });
        return episodes;
    }

    function showEpisodeView(data) {
        pageTitle.textContent = '🎬 Bölüm Sayfası';
        pageDesc.textContent = data.title;
        seriesView.style.display = 'none';
        episodeView.style.display = 'block';
        unknownView.style.display = 'none';

        if (data.videoLinks && data.videoLinks.length > 0) {
            displayResults(data.videoLinks.map(link => ({
                episodeTitle: data.title,
                videoLink: link.url
            })));
        }
    }

    function showUnknownView() {
        pageTitle.textContent = '⚠️ Desteklenmeyen Sayfa';
        pageDesc.textContent = 'cizgivedizi.com sitesine gidin';
        seriesView.style.display = 'none';
        episodeView.style.display = 'none';
        unknownView.style.display = 'block';
    }

    // Seçili bölümleri tara
    scanAllBtn.addEventListener('click', async () => {
        const episodesToScan = getSelectedEpisodes();

        if (episodesToScan.length === 0) {
            showStatus('Taranacak bölüm seçilmedi!', 'error');
            return;
        }

        scanAllBtn.disabled = true;
        spinner.style.display = 'inline-block';
        btnText.textContent = 'Tarama başlatılıyor...';
        progressContainer.style.display = 'block';
        results.style.display = 'none';

        chrome.runtime.sendMessage({
            action: "start_batch_scan",
            episodes: episodesToScan,
            seriesTitle: seriesTitle
        }, (response) => {
            if (response && response.status === "started") {
                startStatusCheck();
            }
        });
    });

    // Mevcut bölümü tara
    scanCurrentBtn.addEventListener('click', async () => {
        scanCurrentBtn.disabled = true;
        document.getElementById('btnText2').textContent = 'Taranıyor...';

        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            const response = await chrome.tabs.sendMessage(tab.id, { action: "get_sibnet_links" });

            if (response && response.links && response.links.length > 0) {
                displayResults(response.links.map(link => ({
                    episodeTitle: link.title,
                    videoLink: link.url
                })));
                showStatus(`${response.links.length} video linki bulundu!`, 'success');
            } else {
                showStatus('Bu sayfada video linki bulunamadı.', 'info');
            }
        } catch (err) {
            showStatus('Hata oluştu: ' + err.message, 'error');
        }

        scanCurrentBtn.disabled = false;
        document.getElementById('btnText2').textContent = '🔍 Bu Bölümün Video Linkini Bul';
    });

    // İptal
    cancelBtn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: "cancel_scan" }, () => {
            stopStatusCheck();
            resetUI();
            showStatus('Tarama iptal edildi.', 'info');
        });
    });

    // Tümünü kopyala
    copyAllBtn.addEventListener('click', () => {
        if (scanResults.length === 0) return;

        const allUrls = scanResults.filter(r => r.videoLink).map(r => r.videoLink).join('\n');
        navigator.clipboard.writeText(allUrls).then(() => {
            showStatus('Tüm linkler panoya kopyalandı!', 'success');
            copyAllBtn.textContent = '✅ Kopyalandı!';
            setTimeout(() => copyAllBtn.textContent = '📋 Kopyala', 2000);
        });
    });

    // Dışa aktar
    exportBtn.addEventListener('click', () => {
        if (scanResults.length === 0) return;

        let content = `# ${seriesTitle} - Video Linkleri\n`;
        content += `# Toplam: ${scanResults.filter(r => r.videoLink).length} bölüm\n`;
        content += `# Tarih: ${new Date().toLocaleDateString('tr-TR')}\n\n`;

        scanResults.forEach((result, index) => {
            if (result.videoLink) {
                content += `${index + 1}. ${result.episodeTitle}\n`;
                content += `   ${result.videoLink}\n\n`;
            }
        });

        const blob = new Blob([content], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${seriesTitle.replace(/[^a-zA-Z0-9ğüşıöçĞÜŞİÖÇ ]/g, '')}_linkler.txt`;
        a.click();
        URL.revokeObjectURL(url);

        showStatus('Dosya indirildi!', 'success');
    });

    // DİREKT URL İNDİRME
    directDownloadBtn.addEventListener('click', async () => {
        const url = directUrlInput.value.trim();

        if (!url) {
            directDownloadStatus.textContent = '⚠️ Lütfen bir Sibnet URL girin';
            directDownloadStatus.style.color = '#dc3545';
            return;
        }

        if (!url.includes('video.sibnet.ru')) {
            directDownloadStatus.textContent = '⚠️ Geçerli bir Sibnet URL girin';
            directDownloadStatus.style.color = '#dc3545';
            return;
        }

        directDownloadBtn.disabled = true;
        directDownloadBtn.textContent = '⏳ İndiriliyor...';
        directDownloadStatus.textContent = '🔄 Video linki alınıyor...';
        directDownloadStatus.style.color = '#667eea';

        try {
            // Video ID'yi çıkar
            const match = url.match(/videoid=(\d+)/);
            const videoId = match ? match[1] : 'video';
            const filename = `sibnet_${videoId}.mp4`;

            const result = await new Promise((resolve) => {
                chrome.runtime.sendMessage({
                    action: "get_direct_video_link",
                    sibnetUrl: url,
                    filename: filename
                }, resolve);
            });

            if (result && result.success) {
                directDownloadStatus.textContent = '✅ İndirme başlatıldı!';
                directDownloadStatus.style.color = '#28a745';
                directUrlInput.value = '';
            } else {
                directDownloadStatus.textContent = '❌ Hata: ' + (result?.error || 'Bilinmeyen hata');
                directDownloadStatus.style.color = '#dc3545';
            }
        } catch (err) {
            directDownloadStatus.textContent = '❌ Hata: ' + err.message;
            directDownloadStatus.style.color = '#dc3545';
        }

        directDownloadBtn.disabled = false;
        directDownloadBtn.textContent = '📥 İndir';
    });

    // TOPLU İNDİRME - Background'a delege et
    downloadAllBtn.addEventListener('click', async () => {
        const videosToDownload = scanResults.filter(r => r.videoLink);

        if (videosToDownload.length === 0) {
            showStatus('İndirilecek video bulunamadı!', 'error');
            return;
        }

        // Background script'e toplu indirme başlat
        chrome.runtime.sendMessage({
            action: "start_batch_download",
            videos: videosToDownload,
            seriesTitle: seriesTitle
        });

        downloadProgressContainer.style.display = 'block';
        downloadAllBtn.disabled = true;
        downloadAllBtn.textContent = '⏳ İndiriliyor...';

        showStatus(`${videosToDownload.length} video indirmeye başlandı. İndirmeler arka planda devam edecek.`, 'success');

        // İndirme durumunu kontrol et
        startDownloadStatusCheck();
    });

    let downloadCheckInterval = null;

    function startDownloadStatusCheck() {
        downloadCheckInterval = setInterval(() => {
            chrome.runtime.sendMessage({ action: "get_download_status" }, (response) => {
                if (!response) return;

                if (response.isDownloading) {
                    const percent = response.total > 0 ? (response.completed / response.total) * 100 : 0;
                    downloadProgressFill.style.width = percent + '%';
                    downloadProgressText.textContent = `İndiriliyor... ${response.completed} / ${response.total}`;
                } else if (response.completed > 0) {
                    clearInterval(downloadCheckInterval);
                    downloadProgressContainer.style.display = 'none';
                    downloadAllBtn.disabled = false;
                    downloadAllBtn.textContent = '📥 Tümünü İndir';
                    showStatus(`İndirme tamamlandı! ${response.completed} video indirildi.`, 'success');
                }
            });
        }, 1000);
    }

    // TEKLİ İNDİRME
    async function downloadSingleVideo(sibnetUrl, title, button) {
        button.disabled = true;
        button.textContent = '⏳';

        try {
            // Dosya adını hazırla
            const safeTitle = (title || 'video').replace(/[^a-zA-Z0-9ğüşıöçĞÜŞİÖÇ _-]/g, '').substring(0, 80);
            const filename = safeTitle + '.mp4';

            const result = await new Promise((resolve) => {
                chrome.runtime.sendMessage({
                    action: "get_direct_video_link",
                    sibnetUrl: sibnetUrl,
                    filename: filename
                }, resolve);
            });

            if (result && result.success) {
                button.textContent = '✅';
                showStatus(`"${title}" indiriliyor...`, 'success');
            } else {
                button.textContent = '❌';
                showStatus('Video linki alınamadı: ' + (result?.error || 'Bilinmeyen hata'), 'error');
            }
        } catch (err) {
            button.textContent = '❌';
            showStatus('İndirme hatası: ' + err.message, 'error');
        }

        setTimeout(() => {
            button.disabled = false;
            button.textContent = '📥';
        }, 3000);
    }

    function startStatusCheck() {
        statusCheckInterval = setInterval(checkScanStatus, 1000);
    }

    function stopStatusCheck() {
        if (statusCheckInterval) {
            clearInterval(statusCheckInterval);
            statusCheckInterval = null;
        }
    }

    async function checkScanStatus() {
        chrome.runtime.sendMessage({ action: "get_scan_status" }, (response) => {
            if (!response) return;

            const percent = response.total > 0 ? (response.completed / response.total) * 100 : 0;
            progressFill.style.width = percent + '%';
            progressText.textContent = `Taranıyor... ${response.completed} / ${response.total}`;

            if (response.results && response.results.length > 0) {
                displayResults(response.results);
            }

            if (!response.isScanning && response.completed > 0) {
                stopStatusCheck();
                scanResults = response.results;
                displayResults(response.results);
                resetUI();
                addNewScanButton();

                const found = response.results.filter(r => r.videoLink).length;
                showStatus(`Tarama tamamlandı! ${found}/${response.total} bölümde video linki bulundu.`, 'success');
            }
        });
    }

    function displayResults(resultsList) {
        scanResults = resultsList;
        linkList.innerHTML = '';

        const validResults = resultsList.filter(r => r.videoLink);
        linkCountDisplay.textContent = validResults.length;

        resultsList.forEach((result, index) => {
            const item = document.createElement('div');
            item.className = 'link-item' + (result.videoLink ? '' : ' no-video');
            item.innerHTML = `
                <div class="link-index">${index + 1}</div>
                <div class="link-info">
                    <div class="link-title">${result.episodeTitle || 'Bölüm ' + (index + 1)}</div>
                    <div class="link-url">${result.videoLink || 'Video linki bulunamadı'}</div>
                </div>
                ${result.videoLink ? `
                <div class="link-actions">
                    <button class="download-btn" data-url="${result.videoLink}" data-title="${result.episodeTitle}" title="İndir">📥</button>
                    <button class="copy-btn" data-url="${result.videoLink}" title="Kopyala">📋</button>
                    <button class="open-btn" data-url="${result.videoLink}" title="Aç">🔗</button>
                </div>
                ` : ''}
            `;
            linkList.appendChild(item);
        });

        results.style.display = 'block';

        // İndirme butonları
        linkList.querySelectorAll('.download-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                downloadSingleVideo(btn.dataset.url, btn.dataset.title, btn);
            });
        });

        // Kopyalama butonları
        linkList.querySelectorAll('.copy-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                navigator.clipboard.writeText(btn.dataset.url).then(() => {
                    btn.textContent = '✅';
                    setTimeout(() => btn.textContent = '📋', 1500);
                });
            });
        });

        // Açma butonları
        linkList.querySelectorAll('.open-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                chrome.tabs.create({ url: btn.dataset.url });
            });
        });
    }

    function resetUI() {
        scanAllBtn.disabled = false;
        spinner.style.display = 'none';
        btnText.textContent = '🚀 Seçili Bölümleri Tara';
        progressContainer.style.display = 'none';
    }

    function showStatus(message, type) {
        statusMsg.textContent = message;
        statusMsg.className = 'status-msg ' + type;
    }

    chrome.runtime.onMessage.addListener((request) => {
        if (request.action === "scan_complete") {
            scanResults = request.results;
            displayResults(request.results);
            resetUI();
            stopStatusCheck();
            addNewScanButton();
        }
    });
});
