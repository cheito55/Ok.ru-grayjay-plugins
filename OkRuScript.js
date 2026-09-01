// ============================================================
// Plugin de GrayJay para OK.ru (Odnoklassniki)
// ============================================================
//
// LOGIN OPCIONAL:
// Si el navegador integrado de GrayJay no carga OK.ru, podes
// hacer login manualmente pegando tus cookies en el bloque
// COOKIES de abajo.
//
// Como obtenerlas:
//   1. Abri ok.ru en el navegador de tu celular/PC
//   2. Inicia sesion
//   3. Busca las cookies JSESSIONID, AUTHCODE y domain_sid
//   4. Pegalas abajo entre las comillas.
// ============================================================

const PLATFORM_NAME = "OK.ru";
const REGEX_VIDEO_URL = /ok\.ru\/(?:video|videoembed)\/(\d+)/;
const SEARCH_URL_BASE = "https://ok.ru/dk?st.cmd=searchResult&st.mode=Movie&st.grmode=Groups&st.query=";

// ============================================================
// COOKIES MANUALES
// Pega aca las cookies que obtuviste del navegador.
// Deja vacio "" si usas el login normal de GrayJay.
// ============================================================
const MANUAL_JSESSIONID = "9249fef29c13e61ff271bbbd9e1140ec72384bb6d43b36c.7d71e5de";
const MANUAL_AUTHCODE = "_OZM5rnTmi_AnnX-uT1e3teX8PVWIf6cFOiel2Le_VV2_zw7WD9cwuJfxfaKJ2NoG8YmIleZSvWAs2mE4UI8_gLsrUNKVF8piJXdg8dVJTqqPMv5CtO43ayWeb4-Ur_fWmhXTOrMhe70mZbfYg_5";
const MANUAL_DOMAIN_SID = "c50T0RmY5G6B7bBAXzmNB%3A1788115233512";

let PLUGIN_ID = "";

source.enable = function (conf, settings, savedState) {
    PLUGIN_ID = (conf && conf.id) ? conf.id : "";
};

source.isContentDetailsUrl = function (url) {
    return REGEX_VIDEO_URL.test(url);
};

// ------------------------------------------------------------
// Obtencion del detalle/reproduccion del video
// ------------------------------------------------------------
source.getContentDetails = function (url) {
    const match = url.match(REGEX_VIDEO_URL);
    if (!match) {
        throw new ScriptException("URL de OK.ru no reconocida: " + url);
    }
    const videoId = match[1];
    const pageUrl = "https://ok.ru/video/" + videoId;
    const mobileUrl = "https://m.ok.ru/video/" + videoId;

    let html = fetchPageHtml(pageUrl);
    let optionsMatch = html ? html.match(/data-options="([^"]+)"/) : null;

    if (!optionsMatch) {
        html = fetchPageHtml(mobileUrl);
        optionsMatch = html ? html.match(/data-options="([^"]+)"/) : null;
    }

    if (!html) {
        throw new ScriptException("No se pudo cargar la pagina de OK.ru");
    }

    const stubError = html.match(/class="vp_video_stub_txt"[^>]*>([^<]+)</);
    if (stubError) {
        throw new ScriptException("Video no disponible: " + stubError[1]);
    }

    if (!optionsMatch) {
        throw new ScriptException("No se encontro data-options en la pagina");
    }

    const optionsJson = unescapeHtml(optionsMatch[1]);
    let options;
    try {
        options = JSON.parse(optionsJson);
    } catch (e) {
        throw new ScriptException("No se pudo parsear data-options: " + e);
    }

    const flashvars = options.flashvars || {};
    let metadata;

    if (flashvars.metadata) {
        metadata = (typeof flashvars.metadata === "string")
            ? JSON.parse(flashvars.metadata)
            : flashvars.metadata;
    } else if (flashvars.metadataUrl) {
        const metadataUrl = decodeURIComponent(flashvars.metadataUrl);
        const metaResp = http.POST(metadataUrl, "", {
            "Referer": pageUrl,
            "Content-Type": "application/x-www-form-urlencoded"
        }, false);
        if (!metaResp.isOk) {
            throw new ScriptException("No se pudo obtener metadataUrl (status " + metaResp.code + ")");
        }
        metadata = (typeof metaResp.body === "string")
            ? JSON.parse(metaResp.body)
            : metaResp.body;
    } else {
        throw new ScriptException("No se encontro metadata ni metadataUrl en flashvars");
    }

    return buildVideoDetails(videoId, pageUrl, metadata);
};

// ------------------------------------------------------------
// Busqueda de videos
// ------------------------------------------------------------
// Usa st.cmd=searchResult que EXIGE sesion logueada.
// Intenta: 1) cookies manuales, 2) cookies de GrayJay (useAuth).
source.search = function (query, type, order, filters) {
    if (!query) {
        return new VideoPager([], false, {});
    }

    const searchUrl = SEARCH_URL_BASE + encodeURIComponent(query);
    const results = [];

    // Intento 1: Cookies manuales
    if (MANUAL_JSESSIONID || MANUAL_AUTHCODE || MANUAL_DOMAIN_SID) {
        const cookieHeader = [
            MANUAL_JSESSIONID ? "JSESSIONID=" + MANUAL_JSESSIONID : "",
            MANUAL_AUTHCODE ? "AUTHCODE=" + MANUAL_AUTHCODE : "",
            MANUAL_DOMAIN_SID ? "domain_sid=" + MANUAL_DOMAIN_SID : ""
        ].filter(function(c) { return c; }).join("; ");

        if (cookieHeader) {
            const resp = http.GET(searchUrl, {
                "Referer": "https://ok.ru/video",
                "Cookie": cookieHeader
            }, false);

            if (resp.isOk) {
                parseSearchResults(resp.body, results);
                if (results.length > 0) {
                    return new VideoPager(results, false, {});
                }
            }
        }
    }

    // Intento 2: Cookies de GrayJay (login normal)
    const resp = http.GET(searchUrl, {
        "Referer": "https://ok.ru/video"
    }, true);

    if (!resp.isOk) {
        throw new ScriptException("Error al buscar en OK.ru (status " + resp.code + ")");
    }

    parseSearchResults(resp.body, results);

    if (results.length === 0) {
        throw new ScriptException(
            "No se encontraron resultados. Verifica que las cookies " +
            "manuales sean validas o hace login desde Sources > OK.ru."
        );
    }

    return new VideoPager(results, false, {});
};

// ------------------------------------------------------------
// Parseo de resultados de busqueda
// ------------------------------------------------------------
function parseSearchResults(html, results) {
    const seen = {};
    const movieIdRegex = /data-movie-id="(\d+)"/g;
    let idMatch;

    while ((idMatch = movieIdRegex.exec(html)) !== null) {
        const videoId = idMatch[1];
        if (seen[videoId]) continue;
        seen[videoId] = true;

        const searchStart = Math.max(0, idMatch.index - 3000);
        const searchEnd = Math.min(idMatch.index + 8000, html.length);
        const block = html.substring(searchStart, searchEnd);

        const titleMatch = block.match(/portal_search_name"[^>]*title="([^"]+)"/);
        const title = titleMatch
            ? unescapeHtml(titleMatch[1])
            : "Video de OK.ru";

        const durMatch = block.match(/video-card_duration"[^>]*>([^<]+)/);
        const durStr = durMatch ? durMatch[1].trim() : "0:00";
        const durationSec = parseDuration(durStr);

        const viewsMatch = block.match(/portal_search_info-i">([^<]+)/);
        const viewsStr = viewsMatch ? viewsMatch[1].trim() : "0";
        const viewCount = parseViewCount(viewsStr);

        let posterUrl = posterFromHtml(block);
        if (!posterUrl) {
            const anyImg = block.match(
                /(?:https?:)?\/\/[^'"\s]+(?:okcdn\.(?:ru|net)|userapi\.com)[^'"\s]*\.(?:jpe?g|png|webp)/i
            );
            if (anyImg) {
                posterUrl = anyImg[0];
                if (posterUrl.indexOf("http") !== 0 && posterUrl.indexOf("//") === 0) {
                    posterUrl = "https:" + posterUrl;
                }
            }
        }

        results.push(new PlatformVideo({
            id: new PlatformID(PLATFORM_NAME, videoId, PLUGIN_ID),
            name: title,
            thumbnails: posterUrl
                ? new Thumbnails([{ url: posterUrl, quality: 480 }])
                : new Thumbnails([]),
            author: new PlatformAuthorLink(
                new PlatformID(PLATFORM_NAME, "", PLUGIN_ID),
                "OK.ru",
                "",
                ""
            ),
            uploadDate: 0,
            duration: durationSec,
            viewCount: viewCount,
            url: "https://ok.ru/video/" + videoId,
            isLive: false
        }));
    }
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

function posterFromHtml(block) {
    let m = block.match(/data-poster-src="([^"]+)"/);
    if (!m) m = block.match(/data-poster-url="([^"]+)"/);
    if (!m) m = block.match(/poster-src="([^"]+)"/);
    if (!m) m = block.match(/background-image:\s*url\(['"]?([^'")]+)['"]?\)/);
    if (!m) m = block.match(/<img[^>]+src="([^"]+)"/);
    if (!m) m = block.match(/<img[^>]+data-src="([^"]+)"/);
    if (!m) m = block.match(/data-src="([^"]+)"/);

    if (!m) return "";

    let url = m[1];
    url = url.replace(/&amp;/g, "&");
    if (url.indexOf("http") !== 0 && url.indexOf("//") === 0) {
        url = "https:" + url;
    }
    if (!/(?:okcdn|userapi\.com)/.test(url)) {
        return "";
    }
    return url;
}

function fetchPageHtml(url) {
    try {
        const resp = http.GET(url, {
            "Referer": "https://ok.ru/"
        }, false);
        return resp.isOk ? resp.body : null;
    } catch (e) {
        return null;
    }
}

function buildVideoDetails(videoId, pageUrl, metadata) {
    const movie = metadata.movie || {};
    const author = metadata.author || {};

    const sources = [];
    const seenUrls = {};

    // Buscar URLs HLS
    const hlsCandidates = [];
    const hlsKeys = [
        "hlsManifestUrl", "hlsMasterPlaylistUrl",
        "hlsUrl", "hls_playlist", "hls", "hlsUrlMobile"
    ];
    for (let i = 0; i < hlsKeys.length; i++) {
        const val = metadata[hlsKeys[i]];
        if (val && typeof val === "string" && val.indexOf("m3u8") !== -1) {
            hlsCandidates.push(val);
        }
    }
    try {
        const rawStr = JSON.stringify(metadata);
        const re = /(?:https?:)?\/\/[^"'\s]+\.m3u8[^"'\s]*/gi;
        let m;
        while ((m = re.exec(rawStr)) !== null) {
            let u = m[0].replace(/\\u0026/g, "&").replace(/&amp;/g, "&");
            if (u.indexOf("http") !== 0 && u.indexOf("//") === 0) u = "https:" + u;
            let dup = false;
            for (let j = 0; j < hlsCandidates.length; j++) {
                if (hlsCandidates[j] === u) { dup = true; break; }
            }
            if (!dup) hlsCandidates.push(u);
        }
    } catch (e) {}

    for (let i = 0; i < hlsCandidates.length; i++) {
        const u = hlsCandidates[i];
        if (seenUrls[u]) continue;
        seenUrls[u] = true;
        sources.push(new HLSSource({
            name: "HLS",
            url: u,
            duration: intOrZero(movie.duration)
        }));
    }

    // MP4 fallback
    if (Array.isArray(metadata.videos)) {
        for (let i = 0; i < metadata.videos.length; i++) {
            const v = metadata.videos[i];
            if (v && v.url && !seenUrls[v.url]) {
                seenUrls[v.url] = true;
                sources.push(new VideoUrlSource({
                    name: v.name || ("mp4-" + (i + 1)),
                    url: v.url,
                    container: "video/mp4"
                }));
            }
        }
    }

    if (sources.length === 0) {
        if (metadata.paymentInfo) {
            throw new ScriptException("Este video es pago en OK.ru.");
        }
        throw new ScriptException("No se encontro ninguna fuente de video reproducible.");
    }

    return new PlatformVideoDetails({
        id: new PlatformID(PLATFORM_NAME, videoId, PLUGIN_ID),
        name: movie.title || "Video de OK.ru",
        thumbnails: movie.poster
            ? new Thumbnails([{ url: movie.poster, quality: 720 }])
            : new Thumbnails([]),
        duration: intOrZero(movie.duration),
        viewCount: 0,
        url: pageUrl,
        isLive: false,
        author: new PlatformAuthorLink(
            new PlatformID(PLATFORM_NAME, String(author.id || ""), PLUGIN_ID),
            author.name || "OK.ru",
            "", ""
        ),
        video: new VideoSourceDescriptor(sources)
    });
}

function intOrZero(v) {
    const n = parseInt(v, 10);
    return isNaN(n) ? 0 : n;
}

function unescapeHtml(str) {
    return str
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">");
}

function safeJsonUnescape(fragment) {
    try {
        return JSON.parse('"' + fragment + '"');
    } catch (e) {
        return fragment;
    }
}

function parseDuration(str) {
    const parts = str.split(":").map(Number);
    if (parts.length === 3) {
        return parts[0] * 3600 + parts[1] * 60 + parts[2];
    } else if (parts.length === 2) {
        return parts[0] * 60 + parts[1];
    }
    return 0;
}

function parseViewCount(str) {
    const cleaned = str
        .replace(/&nbsp;/g, "")
        .replace(/\u00a0/g, "")
        .replace(/[^\d]/g, "");
    const n = parseInt(cleaned, 10);
    return isNaN(n) ? 0 : n;
}

// ------------------------------------------------------------
// Stubs
// ------------------------------------------------------------
source.getHome = function () {
    return new VideoPager([], false, {});
};
