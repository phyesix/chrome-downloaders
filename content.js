// CizgiVeDizi.com Video Link Extractor
// video.sibnet.ru linklerini bulur - Sezon desteği ile

// Manifest content script'i + executeScript ile ikinci kez enjekte edilirse
// tekrar listener eklenmesin (aksi halde her mesaja iki kez cevap verilir).
if (!window.__cvdExtractorLoaded) {
window.__cvdExtractorLoaded = true;

const SIBNET_URL_RE = /(?:https?:)?\/\/video\.sibnet\.ru\/[^\s"'<>)\\]+/g;

function normalizeSibnetUrl(url) {
    return url.startsWith('//') ? 'https:' + url : url;
}

// Sayfadaki tüm sibnet video linklerini bul
function findSibnetVideoLinks() {
    const links = [];
    const seen = new Set();
    const title = document.title;

    const add = (url, type, extra) => {
        url = normalizeSibnetUrl(url);
        if (seen.has(url)) return;
        seen.add(url);
        links.push({ url, type, title, ...extra });
    };

    // 1. iframe src'lerinde ara
    for (const iframe of document.querySelectorAll('iframe[src*="video.sibnet.ru"]')) {
        add(iframe.src, 'iframe');
    }

    // 2. Attribute'larda ara (XPath ile tek native sorgu; tüm DOM'u JS'te gezmekten çok daha hızlı)
    const attrs = document.evaluate(
        '//@*[contains(., "video.sibnet.ru")]',
        document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null
    );
    for (let i = 0; i < attrs.snapshotLength; i++) {
        const attr = attrs.snapshotItem(i);
        const value = attr.value.trim();
        const urls = value.match(SIBNET_URL_RE) || (value.startsWith('video.sibnet.ru/') ? ['https://' + value] : []);
        for (const url of urls) {
            add(url, 'attribute', { attrName: attr.name });
        }
    }

    // 3. Script içeriğinde ara
    for (const script of document.scripts) {
        const text = script.textContent;
        if (!text || !text.includes('video.sibnet.ru')) continue;
        for (const url of text.match(SIBNET_URL_RE) || []) {
            if (url.startsWith('http')) add(url, 'script');
        }
    }

    return links;
}

// Sezon bilgilerini bul
function findSeasons() {
    const seasons = [];

    // Sezon butonlarını bul (label.btn-outline-primary)
    for (const label of document.querySelectorAll('label.btn-outline-primary')) {
        const text = label.textContent.trim();
        // "Tüm Bölümler" veya sezon numarası
        if (text === 'Tüm Bölümler' || /^\d+$/.test(text)) {
            const input = label.querySelector('input') || document.getElementById(label.getAttribute('for'));
            seasons.push({
                text: text,
                isAll: text === 'Tüm Bölümler',
                seasonNum: text === 'Tüm Bölümler' ? 0 : parseInt(text),
                isActive: label.classList.contains('active'),
                inputId: input ? input.id : null
            });
        }
    }

    // Sezon numarasına göre sırala (Tüm Bölümler en başta)
    seasons.sort((a, b) => a.seasonNum - b.seasonNum);

    return seasons;
}

// Dizi ana sayfasındaki tüm bölüm linklerini bul (TÜM SEZONLAR DAHİL)
function findEpisodeLinks() {
    const episodes = [];
    const seen = new Set();
    const baseUrl = window.location.href.replace(/\/$/, '');

    // Tüm a.bolum linklerini al (gizli olanlar dahil - DOM'da hepsi mevcut)
    for (const link of document.querySelectorAll('a.bolum')) {
        if (!link.href || link.href === baseUrl || link.href.includes('random') || seen.has(link.href)) continue;
        seen.add(link.href);

        // Bölüm numarası ve adını çıkar
        const urlParts = link.href.split('/');
        const episodeNum = urlParts[urlParts.length - 2] || '';
        const episodeName = urlParts[urlParts.length - 1] || '';

        // Sezon bilgisi (varsa parent element'ten)
        const parent = link.closest('[data-season]');
        const seasonNum = parent ? parent.getAttribute('data-season') : null;

        // Thumbnail varsa al
        const img = link.querySelector('img');
        const thumbnail = img ? img.src : null;

        // Bölüm başlığını al
        const titleEl = link.querySelector('.bolum_isim') || link.querySelector('h5') || link;
        let title = (titleEl.textContent || '')
            .replace(/\s+/g, ' ')
            .trim()
            // "11)" veya "1)" gibi başlangıç numaralarını temizle
            .replace(/^\d+\)\s*/, '');

        // Başlık boşsa bölüm numarasını, değilse numaralı başlığı kullan
        title = title ? `${episodeNum}. ${title}` : `Bölüm ${episodeNum}`;

        episodes.push({ url: link.href, episodeNum, episodeName, seasonNum, title, thumbnail });
    }

    // Eğer a.bolum bulunamazsa, genel link araması yap
    if (episodes.length === 0) {
        const currentPath = window.location.pathname;
        for (const link of document.querySelectorAll(`a[href*="${CSS.escape(currentPath)}"]`)) {
            const segments = link.href.split('/').filter(s => s);
            if (segments.length < 6 || link.href === baseUrl || link.href.includes('random') || seen.has(link.href)) continue;
            seen.add(link.href);

            const episodeNum = segments[segments.length - 2] || '';
            const episodeName = segments[segments.length - 1] || '';
            episodes.push({
                url: link.href,
                episodeNum,
                episodeName,
                title: link.textContent?.trim() || `Bölüm ${episodeNum}`
            });
        }
    }

    // Bölüm numarasına göre sırala
    episodes.sort((a, b) => (parseInt(a.episodeNum) || 0) - (parseInt(b.episodeNum) || 0));

    return episodes;
}

// Sayfa türünü belirle (dizi sayfası mı, bölüm sayfası mı)
function getPageType() {
    const url = window.location.href;
    const segments = url.split('/').filter(s => s && s !== 'https:' && s !== 'http:');

    // /dizi/category/series = dizi sayfası (3-4 segment)
    // /dizi/category/series/ep/name = bölüm sayfası (5+ segment)
    if (segments.length >= 6) {
        return 'episode';
    } else if (segments.length >= 4 && url.includes('/dizi/')) {
        return 'series';
    }
    return 'unknown';
}

// Popup'tan / background'dan gelen mesajları dinle.
// Cevaplar senkron verildiği için kanalı açık tutmaya (return true) gerek yok.
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "get_sibnet_links") {
        sendResponse({ links: findSibnetVideoLinks() });
        return;
    }

    if (request.action === "get_episode_links") {
        sendResponse({ episodes: findEpisodeLinks() });
        return;
    }

    if (request.action === "get_page_info") {
        const pageType = getPageType();
        const seasons = pageType === 'series' ? findSeasons() : [];
        const episodes = pageType === 'series' ? findEpisodeLinks() : [];
        const videoLinks = pageType === 'episode' ? findSibnetVideoLinks() : [];

        sendResponse({
            pageType: pageType,
            url: window.location.href,
            title: document.title,
            hasMultipleSeasons: seasons.length > 1,
            seasonCount: seasons.filter(s => !s.isAll).length,
            seasons: seasons,
            episodeCount: episodes.length,
            episodes: episodes,
            videoLinks: videoLinks
        });
    }
});
}
