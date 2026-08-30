// ============================================================
// Plugin de GrayJay para OK.ru (Odnoklassniki)
// VERSIÓN 100% LOCAL (Sin Vercel) - Reproducción y Búsqueda
// ============================================================

const PLATFORM_NAME = "OK.ru";
const REGEX_VIDEO_URL = /ok\.ru\/(?:video|videoembed)\/(\d+)/;

let PLUGIN_ID = "";

// ------------------------------------------------------------
// Habilitación del plugin
// ------------------------------------------------------------
source.enable = function (conf, settings, savedState) {
    PLUGIN_ID = (conf && conf.id) ? conf.id : "";
};

// ------------------------------------------------------------
// Detección de URLs
// ------------------------------------------------------------
source.isContentDetailsUrl = function (url) {
    return REGEX_VIDEO_URL.test(url);
};

// ------------------------------------------------------------
// Búsqueda de videos (Usando la API web interna de OK.ru)
// ------------------------------------------------------------
source.search = function (query, type, order, filters) {
    if (!query) {
        return new VideoPager([], false, {});
    }

    try {
        // 1. Intentamos obtener una cookie de sesión anónima rápida
        let cookieHeader = "";
        try {
            const homeResp = http.GET("https://ok.ru/video", {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
            }, false);
            if (homeResp.headers && homeResp.headers["set-cookie"]) {
                cookieHeader = homeResp.headers["set-cookie"];
            } else if (homeResp.headers && homeResp.headers["Set-Cookie"]) {
                cookieHeader = homeResp.headers["Set-Cookie"];
            }
        } catch (e) {}

        // 2. Usamos el endpoint JSON en lugar del HTML para evadir el muro de login
        const searchUrl = "https://ok.ru/web-api/search/video?st.query=" + encodeURIComponent(query) + "&st.mode=SEARCH&page=1";
        
        const searchHeaders = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
            "Accept": "application/json, text/plain, */*",
            "Referer": "https://ok.ru/video",
            "X-Requested-With": "XMLHttpRequest" // Clave para evadir el bloqueo
        };
        
        if (cookieHeader) {
            searchHeaders["Cookie"] = cookieHeader;
        }

        const resp = http.GET(searchUrl, searchHeaders, false);

        if (!resp.isOk) {
            return new VideoPager([debugItem("Bloqueo HTTP " + resp.code + " (API web)")], false, {});
        }

        let data;
        try {
            data = JSON.parse(resp.body);
        } catch (e) {
            return new VideoPager([debugItem("Error parseando respuesta JSON")], false, {});
        }

        const items = data.videos || data.items || [];
        const results = [];

        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (!item.id) continue;
            
            const thumbUrl = item.thumbnailUrl || item.poster || "";
            
            results.push(new PlatformVideo({
                id: new PlatformID(PLATFORM_NAME, String(item.id), PLUGIN_ID),
                name: item.title || "Video sin título",
                thumbnails: thumbUrl ? new Thumbnails([{ url: thumbUrl, quality: 480 }]) : new Thumbnails([]),
                author: new PlatformAuthorLink(
                    new PlatformID(PLATFORM_NAME, String(item.authorId || ""), PLUGIN_ID),
                    item.authorName || "OK.ru", "", ""
                ),
                uploadDate: 0,
                duration: item.duration || 0,
                viewCount: item.viewsCount || 0,
                url: "https://ok.ru/video/" + item.id,
                isLive: item.type === "LIVE"
            }));
        }

        if (results.length === 0) {
            return new VideoPager([debugItem("Búsqueda exitosa pero sin resultados")], false, {});
        }

        return new VideoPager(results, false, {});
    } catch (e) {
        return new VideoPager([debugItem("Error en script: " + e.message)], false, {});
    }
};

function debugItem(message) {
    return new PlatformVideo({
        id: new PlatformID(PLATFORM_NAME, "debug", PLUGIN_ID),
        name: message,
        thumbnails: new Thumbnails([]),
        author: new PlatformAuthorLink(new PlatformID(PLATFORM_NAME, "", PLUGIN_ID), "Diagnóstico", "", ""),
        uploadDate: 0, duration: 0, viewCount: 0, url: "https://ok.ru/video", isLive: false
    });
}

// ------------------------------------------------------------
// Obtención del detalle/reproducción del video (LOCAL)
// ------------------------------------------------------------
source.getContentDetails = function (url) {
    const match = url.match(REGEX_VIDEO_URL);
    if (!match) {
        throw new ScriptException("URL de OK.ru no reconocida: " + url);
    }
    const videoId = match[1];
    const pageUrl = "https://ok.ru/video/" + videoId;

    const resp = http.GET(pageUrl, {
        "Referer": "https://ok.ru/"
    }, false);

    if (!resp.isOk) {
        throw new ScriptException("No se pudo cargar la página de OK.ru (status " + resp.code + ")");
    }

    const html = resp.body;

    const stubError = html.match(/class="vp_video_stub_txt"[^>]*>([^<]+)</);
    if (stubError) {
        throw new ScriptException("Video no disponible: " + stubError[1]);
    }

    const optionsMatch = html.match(/data-options="([^"]+)"/);
    if (!optionsMatch) {
        throw new ScriptException("No se encontró data-options en la página (¿cambió el sitio?)");
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
        metadata = JSON.parse(flashvars.metadata);
    } else if (flashvars.metadataUrl) {
        const metadataUrl = decodeURIComponent(flashvars.metadataUrl);
        const metaResp = http.POST(metadataUrl, "", {
            "Referer": pageUrl,
            "Content-Type": "application/x-www-form-urlencoded"
        }, false);
        if (!metaResp.isOk) {
            throw new ScriptException("No se pudo obtener metadataUrl (status " + metaResp.code + ")");
        }
        metadata = JSON.parse(metaResp.body);
    } else {
        throw new ScriptException("No se encontró metadata ni metadataUrl en flashvars");
    }

    return buildVideoDetails(videoId, pageUrl, metadata);
};

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------
function buildVideoDetails(videoId, pageUrl, metadata) {
    const movie = metadata.movie || {};
    const author = metadata.author || {};

    const hlsUrl = metadata.hlsManifestUrl || metadata.hlsMasterPlaylistUrl;
    const sources = [];

    if (hlsUrl) {
        sources.push(new HLSSource({
            name: "HLS",
            url: hlsUrl,
            duration: intOrZero(movie.duration)
        }));
    }

    if (Array.isArray(metadata.videos)) {
        for (const v of metadata.videos) {
            if (v && v.url) {
                sources.push(new VideoUrlSource({
                    name: v.name || "mp4",
                    url: v.url,
                    container: "video/mp4"
                }));
            }
        }
    }

    if (sources.length === 0) {
        if (metadata.paymentInfo) {
            throw new ScriptException("Este video es pago en OK.ru, no se puede reproducir sin comprarlo.");
        }
        throw new ScriptException("No se encontró ninguna fuente de video reproducible.");
    }

    return new PlatformVideoDetails({
        id: new PlatformID(PLATFORM_NAME, videoId, PLUGIN_ID),
        name: movie.title || "Video de OK.ru",
        thumbnails: movie.poster ? new Thumbnails([{ url: movie.poster, quality: 720 }]) : new Thumbnails([]),
        duration: intOrZero(movie.duration),
        viewCount: 0,
        url: pageUrl,
        isLive: false,
        author: new PlatformAuthorLink(
            new PlatformID(PLATFORM_NAME, String(author.id || ""), PLUGIN_ID),
            author.name || "OK.ru", "", ""
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

source.getHome = function () {
    return new VideoPager([], false, {});
};
