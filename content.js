// CizgiVeDizi.com Video Link Extractor
// video.sibnet.ru linklerini bulur - Sezon desteği ile

// Sayfadaki tüm sibnet video linklerini bul
function findSibnetVideoLinks() {
    const links = [];

    // 1. iframe src'lerinde ara
    const iframes = document.querySelectorAll('iframe');
    iframes.forEach(iframe => {
        if (iframe.src && iframe.src.includes('video.sibnet.ru')) {
            links.push({
                url: iframe.src,
                type: 'iframe',
                title: document.title
            });
        }
    });

    // 2. Tüm elementlerin attribute'larında sibnet linki ara
    const allElements = document.querySelectorAll('*');
    allElements.forEach(el => {
        for (let i = 0; i < el.attributes.length; i++) {
            const attr = el.attributes[i];
            if (attr.value.includes('video.sibnet.ru') && !links.some(l => l.url === attr.value)) {
                let url = attr.value;
                if (url.startsWith('//')) {
                    url = 'https:' + url;
                }
                if (url.includes('video.sibnet.ru')) {
                    links.push({
                        url: url,
                        type: 'attribute',
                        attrName: attr.name,
                        title: document.title
                    });
                }
            }
        }
    });

    // 3. Script içeriğinde sibnet linki ara
    const scripts = document.querySelectorAll('script');
    const sibnetRegex = /https?:\/\/video\.sibnet\.ru\/[^\s"'<>]+/g;
    scripts.forEach(script => {
        if (script.textContent) {
            const matches = script.textContent.match(sibnetRegex);
            if (matches) {
                matches.forEach(match => {
                    if (!links.some(l => l.url === match)) {
                        links.push({
                            url: match,
                            type: 'script',
                            title: document.title
                        });
                    }
                });
            }
        }
    });

    // Duplicate'ları temizle
    const uniqueLinks = [];
    const seen = new Set();
    links.forEach(link => {
        if (!seen.has(link.url)) {
            seen.add(link.url);
            uniqueLinks.push(link);
        }
    });

    return uniqueLinks;
}

// Sezon bilgilerini bul
function findSeasons() {
    const seasons = [];

    // Sezon butonlarını bul (label.btn-outline-primary)
    const seasonLabels = document.querySelectorAll('label.btn-outline-primary');

    seasonLabels.forEach(label => {
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
    });

    // Sezon numarasına göre sırala (Tüm Bölümler en başta)
    seasons.sort((a, b) => a.seasonNum - b.seasonNum);

    return seasons;
}

// Dizi ana sayfasındaki tüm bölüm linklerini bul (TÜM SEZONLAR DAHİL)
function findEpisodeLinks() {
    const episodes = [];
    const baseUrl = window.location.href.replace(/\/$/, '');

    // Tüm a.bolum linklerini al (gizli olanlar dahil - DOM'da hepsi mevcut)
    const episodeLinks = document.querySelectorAll('a.bolum');

    episodeLinks.forEach(link => {
        if (link.href && link.href !== baseUrl && !link.href.includes('random')) {
            // Bölüm numarası ve adını çıkar
            const urlParts = link.href.split('/');
            const episodeNum = urlParts[urlParts.length - 2] || '';
            const episodeName = urlParts[urlParts.length - 1] || '';

            // Sezon bilgisini bulmaya çalış
            // URL'den veya parent element'ten sezon numarası çıkarılabilir
            let seasonNum = null;
            const parent = link.closest('[data-season]');
            if (parent) {
                seasonNum = parent.getAttribute('data-season');
            }

            // Thumbnail varsa al
            const img = link.querySelector('img');
            const thumbnail = img ? img.src : null;

            // Bölüm başlığını al
            const titleEl = link.querySelector('.bolum_isim') || link.querySelector('h5') || link;
            let title = titleEl.textContent?.trim() || `Bölüm ${episodeNum}`;

            // Başlıktan gereksiz boşlukları ve formatı temizle
            title = title.replace(/\s+/g, ' ').trim();

            // "11)" veya "1)" gibi başlangıç numaralarını temizle
            title = title.replace(/^\d+\)\s*/, '');

            // Eğer başlık boş kaldıysa bölüm numarasını kullan
            if (!title) {
                title = `Bölüm ${episodeNum}`;
            } else {
                // Başlığın başına düzgün bölüm numarası ekle
                title = `${episodeNum}. ${title}`;
            }

            if (!episodes.some(e => e.url === link.href)) {
                episodes.push({
                    url: link.href,
                    episodeNum: episodeNum,
                    episodeName: episodeName,
                    seasonNum: seasonNum,
                    title: title,
                    thumbnail: thumbnail
                });
            }
        }
    });

    // Eğer a.bolum bulunamazsa, genel link araması yap
    if (episodes.length === 0) {
        const currentPath = window.location.pathname;
        const allLinks = document.querySelectorAll(`a[href*="${currentPath}"]`);
        allLinks.forEach(link => {
            const segments = link.href.split('/').filter(s => s);
            if (segments.length >= 6 && link.href !== baseUrl && !link.href.includes('random')) {
                const episodeNum = segments[segments.length - 2] || '';
                const episodeName = segments[segments.length - 1] || '';

                if (!episodes.some(e => e.url === link.href)) {
                    episodes.push({
                        url: link.href,
                        episodeNum: episodeNum,
                        episodeName: episodeName,
                        title: link.textContent?.trim() || `Bölüm ${episodeNum}`
                    });
                }
            }
        });
    }

    // Bölüm numarasına göre sırala
    episodes.sort((a, b) => {
        const numA = parseInt(a.episodeNum) || 0;
        const numB = parseInt(b.episodeNum) || 0;
        return numA - numB;
    });

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

// Popup'tan gelen mesajları dinle
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "get_sibnet_links") {
        const links = findSibnetVideoLinks();
        console.log("Bulunan Sibnet linkleri:", links);
        sendResponse({ links: links });
    }

    if (request.action === "get_episode_links") {
        const episodes = findEpisodeLinks();
        console.log("Bulunan bölümler:", episodes);
        sendResponse({ episodes: episodes });
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

    return true;
});

// Debug için sayfa yüklendiğinde bilgi logla
console.log("CizgiVeDizi Video Extractor yüklendi - Sayfa türü:", getPageType());
const pageType = getPageType();
if (pageType === 'series') {
    const seasons = findSeasons();
    const episodes = findEpisodeLinks();
    console.log(`Sezon sayısı: ${seasons.length}, Toplam bölüm: ${episodes.length}`);
}
