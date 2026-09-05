// ============================================================
// Plugin de GrayJay para OK.ru (Odnoklassniki) v2
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
//
// NOTA: Algunos videos en OK.ru son embeds de YouTube
// (provider: USER_YOUTUBE). Estos NO se pueden reproducir
// desde el plugin de OK.ru. Buscalos directamente en YouTube.
// ============================================================

const PLATFORM_NAME = "OK.ru";
const REGEX_VIDEO_URL = /ok\.ru\/(?:video|videoembed)\/(\d+)/;
const SEARCH_URL_BASE = "https://ok.ru/dk?st.cmd=searchResult&st.mode=Movie&st.grmode=Groups&st.query=";

// URLs de embeds externos (no reproducibles desde OK.ru plugin)
const EXTERNAL_EMBED_REGEX = /(?:youtube\.com\/v\/|youtu\.be\/|youtube\.com\/embed\/|vimeo\.com\/|dailymotion\.com\/)/i;

// ============================================================
// COOKIES MANUALES
// ============================================================
const MANUAL_JSESSIONID = "9249fef29c13e61ff271bbbd9e1140ec72384bb6d43b36c.7d71e5de";
const MANUAL_AUTHCODE = "_OZM5rnTmi_AnnX-uT1e3teX8PVWIf6cFOiel2Le_VV2_zw7WD9cwuJfxfaKJ2NoG8YmIleZSvWAs2mE4UI8_gLsrUNKVF8piJXdg8dVJTqqPMv5CtO43ayWeb4-Ur_fWmhXTOrMhe70mZbfYg_5";
const MANUAL_DOMAIN_SID = "c50T0RmY5G6B7bBAXzmNB%3A1788115233512";

let PLUGIN_ID = "";

// curl-impersonate para Cast (solo si httpimp existe)
const IS_DESKTOP = (typeof bridge !== 'undefined') ? bridge.buildPlatform === "desktop" : false;
const IMPERSONATION_TARGET = IS_DESKTOP ? 'chrome136' : 'chrome131_android';
const IS_IMPERSONATION_AVAILABLE = (typeof httpimp !== 'undefined');

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

    // Intentar cargar la pagina con múltiples estrategias
    let html = null;
    let optionsData = null;

    // Estrategia 1: desktop con cookies manuales
    if (MANUAL_JSESSIONID || MANUAL_AUTHCODE) {
        var cookieHeader = buildCookieHeader();
        html = fetchPageWithCookie(pageUrl, cookieHeader);
        optionsData = extractDataOptions(html);
    }

    // Estrategia 2: desktop con auth de GrayJay
    if (!optionsData) {
        html = fetchPageAuthenticated(pageUrl);
        optionsData = extractDataOptions(html);
    }

    // Estrategia 3: movil con cookies manuales
    if (!optionsData) {
        var mobileUrl = "https://m.ok.ru/video/" + videoId;
        html = fetchPageWithCookie(mobileUrl, cookieHeader || "");
        optionsData = extractDataOptions(html);
    }

    // Estrategia 4: movil con auth de GrayJay
    if (!optionsData) {
        var mobileUrl2 = "https://m.ok.ru/video/" + videoId;
        html = fetchPageAuthenticated(mobileUrl2);
        optionsData = extractDataOptions(html);
    }

    if (!html) {
        throw new ScriptException("No se pudo cargar la pagina de OK.ru");
    }

    if (!optionsData) {
        // Verificar si es un stub de error
        var stubError = html.match(/class="vp_video_stub_txt"[^>]*>([^<]+)</);
        if (stubError) {
            throw new ScriptException("Video no disponible: " + stubError[1].trim());
        }
        throw new ScriptException("No se encontro data-options en la pagina");
    }

    var metadata = parseMetadata(optionsData, pageUrl);

    // Detectar videos externos (YouTube embeds, etc.)
    var provider = safeStr(metadata.provider);
    if (provider.indexOf("YOUTUBE") !== -1 || provider.indexOf("VIMEO") !== -1) {
        throw new ScriptException(
            "Este video es un embed de " + provider.replace("USER_", "") +
            " alojado en OK.ru. No se puede reproducir desde este plugin. " +
            "Buscalo directamente en " + provider.replace("USER_", "") + "."
        );
    }

    // Verificar URLs de video antes de procesar
    var videos = metadata.videos || [];
    var hasRealVideo = false;
    for (var vi = 0; vi < videos.length; vi++) {
        if (videos[vi] && videos[vi].url && !EXTERNAL_EMBED_REGEX.test(videos[vi].url)) {
            hasRealVideo = true;
            break;
        }
    }

    // Si no hay videos reales y no hay HLS, es un embed externo
    if (!hasRealVideo && !hasHls(metadata)) {
        if (provider.indexOf("YOUTUBE") !== -1) {
            throw new ScriptException(
                "Este video es un embed de YouTube alojado en OK.ru. " +
                "Buscalo directamente en YouTube."
            );
        }
        throw new ScriptException("No se encontro ninguna fuente de video reproducible.");
    }

    return buildVideoDetails(videoId, pageUrl, metadata);
};

// ------------------------------------------------------------
// Busqueda de videos
// ------------------------------------------------------------
source.search = function (query, type, order, filters) {
    if (!query) {
        return new VideoPager([], false, {});
    }

    var searchUrl = SEARCH_URL_BASE + encodeURIComponent(query);
    var results = [];

    // Intento 1: Cookies manuales
    if (MANUAL_JSESSIONID || MANUAL_AUTHCODE || MANUAL_DOMAIN_SID) {
        var cookieHeader = buildCookieHeader();
        var resp = http.GET(searchUrl, {
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

    // Intento 2: Cookies de GrayJay
    var resp2 = http.GET(searchUrl, {
        "Referer": "https://ok.ru/video"
    }, true);

    if (!resp2.isOk) {
        throw new ScriptException("Error al buscar en OK.ru (status " + resp2.code + ")");
    }

    parseSearchResults(resp2.body, results);

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
    var seen = {};
    var movieIdRegex = /data-movie-id="(\d+)"/g;
    var idMatch;

    while ((idMatch = movieIdRegex.exec(html)) !== null) {
        var videoId = idMatch[1];
        if (seen[videoId]) continue;
        seen[videoId] = true;

        var searchStart = Math.max(0, idMatch.index - 3000);
        var searchEnd = Math.min(idMatch.index + 8000, html.length);
        var block = html.substring(searchStart, searchEnd);

        var titleMatch = block.match(/portal_search_name"[^>]*title="([^"]+)"/);
        var title = titleMatch ? unescapeHtml(titleMatch[1]) : "Video de OK.ru";

        var durMatch = block.match(/video-card_duration"[^>]*>([^<]+)/);
        var durStr = durMatch ? durMatch[1].trim() : "0:00";
        var durationSec = parseDuration(durStr);

        var viewsMatch = block.match(/portal_search_info-i">([^<]+)/);
        var viewsStr = viewsMatch ? viewsMatch[1].trim() : "0";
        var viewCount = parseViewCount(viewsStr);

        var posterUrl = posterFromHtml(block);

        results.push(new PlatformVideo({
            id: new PlatformID(PLATFORM_NAME, videoId, PLUGIN_ID),
            name: title,
            thumbnails: posterUrl
                ? new Thumbnails([{ url: posterUrl, quality: 480 }])
                : new Thumbnails([]),
            author: new PlatformAuthorLink(
                new PlatformID(PLATFORM_NAME, "", PLUGIN_ID),
                "OK.ru",
                "", ""
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
// Funciones HTTP
// ------------------------------------------------------------

function buildCookieHeader() {
    var parts = [];
    if (MANUAL_JSESSIONID) parts.push("JSESSIONID=" + MANUAL_JSESSIONID);
    if (MANUAL_AUTHCODE) parts.push("AUTHCODE=" + MANUAL_AUTHCODE);
    if (MANUAL_DOMAIN_SID) parts.push("domain_sid=" + MANUAL_DOMAIN_SID);
    return parts.join("; ");
}

function fetchPageWithCookie(url, cookieHeader) {
    try {
        var headers = { "Referer": "https://ok.ru/" };
        if (cookieHeader) headers["Cookie"] = cookieHeader;
        var resp = http.GET(url, headers, false);
        return resp.isOk ? resp.body : null;
    } catch (e) {
        return null;
    }
}

function fetchPageAuthenticated(url) {
    try {
        var resp = http.GET(url, { "Referer": "https://ok.ru/" }, true);
        return resp.isOk ? resp.body : null;
    } catch (e) {
        return null;
    }
}

function extractDataOptions(html) {
    if (!html) return null;
    // Buscar data-options que contenga flashvars (el del video, no otros)
    var match = html.match(/data-options="([^"]*flashvars[^"]*)"/);
    if (match) return match[1];
    // Fallback: cualquier data-options
    var match2 = html.match(/data-options="([^"]+)"/);
    return match2 ? match2[1] : null;
}

function parseMetadata(optionsStr, pageUrl) {
    var optionsJson = unescapeHtml(optionsStr);
    var options;
    try {
        options = JSON.parse(optionsJson);
    } catch (e) {
        throw new ScriptException("No se pudo parsear data-options: " + e);
    }

    var flashvars = options.flashvars || {};
    var metadata;

    if (flashvars.metadata) {
        metadata = (typeof flashvars.metadata === "string")
            ? JSON.parse(flashvars.metadata)
            : flashvars.metadata;
    } else if (flashvars.metadataUrl) {
        var metadataUrl = decodeURIComponent(flashvars.metadataUrl);
        // Intentar POST primero, luego GET
        var metaResp = http.POST(metadataUrl, "", {
            "Referer": pageUrl,
            "Content-Type": "application/x-www-form-urlencoded"
        }, false);
        if (!metaResp.isOk) {
            metaResp = http.GET(metadataUrl, {
                "Referer": pageUrl
            }, false);
        }
        if (!metaResp.isOk) {
            throw new ScriptException("No se pudo obtener metadata (status " + metaResp.code + ")");
        }
        metadata = (typeof metaResp.body === "string")
            ? JSON.parse(metaResp.body)
            : metaResp.body;
    } else {
        throw new ScriptException("No se encontro metadata ni metadataUrl en flashvars");
    }

    return metadata;
}

// ------------------------------------------------------------
// Helpers de metadata
// ------------------------------------------------------------

function safeStr(val) {
    return (typeof val === "string") ? val : "";
}

function safeObj(val) {
    return (val && typeof val === "object" && !Array.isArray(val)) ? val : {};
}

function hasHls(metadata) {
    var hlsKeys = ["hlsManifestUrl", "hlsMasterPlaylistUrl", "hlsUrl", "hls", "hlsUrlMobile"];
    for (var i = 0; i < hlsKeys.length; i++) {
        var val = metadata[hlsKeys[i]];
        if (val && typeof val === "string" && val.indexOf("m3u8") !== -1) return true;
    }
    return false;
}

function posterFromHtml(block) {
    var m = block.match(/data-poster-src="([^"]+)"/);
    if (!m) m = block.match(/data-poster-url="([^"]+)"/);
    if (!m) m = block.match(/poster-src="([^"]+)"/);
    if (!m) m = block.match(/background-image:\s*url\(['"]?([^'")]+)['"]?\)/);
    if (!m) m = block.match(/<img[^>]+src="([^"]+)"/);
    if (!m) m = block.match(/<img[^>]+data-src="([^"]+)"/);
    if (!m) m = block.match(/data-src="([^"]+)"/);

    if (!m) return "";

    var url = m[1].replace(/&amp;/g, "&");
    if (url.indexOf("http") !== 0 && url.indexOf("//") === 0) {
        url = "https:" + url;
    }
    if (!/(?:okcdn|userapi\.com)/.test(url)) return "";
    return url;
}

function fetchPageHtml(url) {
    return fetchPageWithCookie(url, buildCookieHeader()) || fetchPageAuthenticated(url);
}

// ------------------------------------------------------------
// Construccion del video
// ------------------------------------------------------------
function buildVideoDetails(videoId, pageUrl, metadata) {
    var movie = safeObj(metadata.movie);
    var author = safeObj(metadata.author);

    // impersonateTarget solo si httpimp existe
    var impOpts = IS_IMPERSONATION_AVAILABLE ? {
        options: {
            applyAuthClient: "",
            applyCookieClient: "",
            applyOtherHeaders: false,
            impersonateTarget: IMPERSONATION_TARGET
        }
    } : null;

    var sources = [];
    var seenUrls = {};

    // === HLS (prioridad máxima) ===
    var hlsCandidates = collectHlsUrls(metadata);
    for (var i = 0; i < hlsCandidates.length; i++) {
        var u = hlsCandidates[i];
        if (seenUrls[u]) continue;
        seenUrls[u] = true;
        var hlsOpts = {
            name: "HLS",
            url: u,
            duration: intOrZero(movie.duration)
        };
        if (impOpts) hlsOpts.requestModifier = impOpts;
        sources.push(new HLSSource(hlsOpts));
    }

    // === MP4 (fallback) ===
    var videos = metadata.videos || [];
    for (var j = 0; j < videos.length; j++) {
        var v = videos[j];
        if (!v || !v.url || seenUrls[v.url]) continue;
        // Saltar embeds externos
        if (EXTERNAL_EMBED_REGEX.test(v.url)) continue;
        seenUrls[v.url] = true;
        var mp4Opts = {
            name: v.name || ("mp4-" + (j + 1)),
            url: v.url,
            container: "video/mp4"
        };
        if (impOpts) mp4Opts.requestModifier = impOpts;
        sources.push(new VideoUrlSource(mp4Opts));
    }

    if (sources.length === 0) {
        var provider = safeStr(metadata.provider);
        if (provider.indexOf("YOUTUBE") !== -1) {
            throw new ScriptException("Este video es un embed de YouTube. Buscalo en YouTube.");
        }
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

function collectHlsUrls(metadata) {
    var candidates = [];
    var seen = {};

    // 1. Buscar en campos conocidos
    var hlsKeys = [
        "hlsManifestUrl", "hlsMasterPlaylistUrl",
        "hlsUrl", "hls_playlist", "hls", "hlsUrlMobile"
    ];
    for (var i = 0; i < hlsKeys.length; i++) {
        var val = metadata[hlsKeys[i]];
        if (val && typeof val === "string" && val.indexOf("m3u8") !== -1) {
            var clean = cleanUrl(val);
            if (clean && !seen[clean]) {
                seen[clean] = true;
                candidates.push(clean);
            }
        }
    }

    // 2. Buscar en JSON serializado (método amplio)
    try {
        var rawStr = JSON.stringify(metadata);
        var re = /(?:https?:)?\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*/gi;
        var m;
        while ((m = re.exec(rawStr)) !== null) {
            var u = cleanUrl(m[0]);
            if (u && !seen[u]) {
                seen[u] = true;
                candidates.push(u);
            }
        }
    } catch (e) {}

    return candidates;
}

function cleanUrl(u) {
    if (!u || typeof u !== "string") return "";
    u = u.replace(/\\u0026/g, "&").replace(/&amp;/g, "&");
    if (u.indexOf("http") !== 0 && u.indexOf("//") === 0) u = "https:" + u;
    if (u.indexOf("http") !== 0) return "";
    return u;
}

// ------------------------------------------------------------
// Utilidades
// ------------------------------------------------------------

function intOrZero(v) {
    var n = parseInt(v, 10);
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

function parseDuration(str) {
    var parts = str.split(":").map(Number);
    if (parts.length === 3) {
        return parts[0] * 3600 + parts[1] * 60 + parts[2];
    } else if (parts.length === 2) {
        return parts[0] * 60 + parts[1];
    }
    return 0;
}

function parseViewCount(str) {
    var cleaned = str
        .replace(/&nbsp;/g, "")
        .replace(/\u00a0/g, "")
        .replace(/[^\d]/g, "");
    var n = parseInt(cleaned, 10);
    return isNaN(n) ? 0 : n;
}

// ------------------------------------------------------------
// Stubs
// ------------------------------------------------------------
source.getHome = function () {
    return new VideoPager([], false, {});
};








// PlayPelis GrayJay Source v41
// Multi-servidor + HLS + diagnóstico
var PID = "8a2f4b7e-3c1d-4f6a-9b8e-5d2c1a9f6e40";
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

var PPID = new PlatformID("PlayPelis", "PlayPelis", PID);
var _settings = {};
var _debugLog = "";

var IPTV_URL = "https://plpro.org";
var IPTV_USER = "p";
var IPTV_PASS = "p";
var JK = "https://jkanime.net";
var TMDB_IMG = "https://image.tmdb.org/t/p/w500";

// =========================================================
// CONFIGURACIÓN
// =========================================================

// Ahora prueba hasta 10 servidores.
// Si hay menos, prueba los que existan.
var MAX_TRY = 10;

// =========================================================
// DEBUG
// =========================================================

function addDebug(msg) {
    _debugLog += String(msg) + "\n";
}

// =========================================================
// HTTP
// =========================================================

function httpGet(url, headers) {
    try {
        var h = headers || {};

        if (!h["User-Agent"] && !h["user-agent"]) {
            h["User-Agent"] = UA;
        }

        var r = http.GET(url, h);

        return (r && r.body) ? r.body : "";
    } catch (e) {
        addDebug("HTTP Exception en " + url + ": " + String(e));
        return "";
    }
}

// =========================================================
// UTILIDADES
// =========================================================

function getHost(url) {
    try {
        var m = String(url).match(/^https?:\/\/([^\/?#]+)/i);
        return m ? m[1].toLowerCase() : "";
    } catch (e) {
        return "";
    }
}

function slugify(s) {
    return String(s || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

function slugToTitle(s) {
    return String(s || "")
        .replace(/-/g, " ")
        .replace(/\b\w/g, function(c) {
            return c.toUpperCase();
        });
}

function b64decode(s) {
    try {
        return decodeURIComponent(
            atob(s).split("").map(function(c) {
                return "%" +
                    ("00" + c.charCodeAt(0).toString(16)).slice(-2);
            }).join("")
        );
    } catch (e) {
        try {
            return atob(s);
        } catch (e2) {
            return "";
        }
    }
}

function htmlDecode(s) {
    if (!s) return "";

    return String(s)
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&#(\d+);/g, function(m, d) {
            return String.fromCharCode(parseInt(d, 10));
        })
        .replace(/&#x([0-9a-fA-F]+);/g, function(m, x) {
            return String.fromCharCode(parseInt(x, 16));
        });
}

function stripTags(s) {
    if (!s) return "";

    return htmlDecode(
        String(s)
            .replace(/<script[\s\S]*?<\/script>/gi, " ")
            .replace(/<style[\s\S]*?<\/style>/gi, " ")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
    ).trim();
}

function fixImg(u) {
    if (!u) return "";

    var s = String(u).trim();

    if (s.indexOf("ttps://") === 0) {
        s = "https" + s.substring(4);
    }

    if (s.indexOf("http") === 0) {
        return s;
    }

    if (s.indexOf("/") === -1 && s.indexOf(".") !== -1) {
        if (
            s.indexOf(".jpg") === -1 &&
            s.indexOf(".png") === -1 &&
            s.indexOf(".webp") === -1
        ) {
            s += ".jpg";
        }

        return TMDB_IMG + "/" + s;
    }

    return "";
}

// =========================================================
// VIDEO OBJECTS
// =========================================================

function mkThumb(url) {
    if (!url) {
        return new Thumbnails([]);
    }

    return new Thumbnails([
        new Thumbnail(url, 100)
    ]);
}

function mkVideo(id, title, thumb, url, authorName) {
    return new PlatformVideo({
        id: new PlatformID(
            "PlayPelis",
            String(id),
            PID
        ),

        name: title || "Sin titulo",

        thumbnails: mkThumb(thumb),

        author: new PlatformAuthorLink(
            PPID,
            authorName || "PlayPelis",
            "https://playpelis.app",
            "",
            0
        ),

        uploadDate: 0,
        url: url,
        duration: 0,
        viewCount: 0,
        isLive: false
    });
}

function mkHls(url, name, duration) {
    if (!url) return null;

    return new HLSSource({
        name: name || "HLS",
        url: url,
        duration: duration || 0
    });
}

// =========================================================
// URL / HLS
// =========================================================

function isM3u8Url(url) {
    try {
        if (!url) return false;

        return /\.m3u8(?:[?#]|$)/i.test(
            String(url)
        );
    } catch (e) {
        return false;
    }
}

function cleanUrl(url) {
    if (!url) return "";

    var s = String(url).trim();

    s = htmlDecode(s);

    s = s.replace(/\\u0026/g, "&");
    s = s.replace(/\\\//g, "/");

    return s;
}

function directHls(url) {
    try {
        url = cleanUrl(url);

        if (!isM3u8Url(url)) {
            return null;
        }

        addDebug("[hls] m3u8 directa detectada");

        return url;
    } catch (e) {
        addDebug("[hls] EXCEPTION: " + String(e));
        return null;
    }
}

// =========================================================
// Vidhide
// =========================================================

function vidhideExtract(pageUrl) {
    try {
        var fetchUrl = pageUrl;

        if (
            fetchUrl.indexOf("vidhidefast.com") !== -1
        ) {
            fetchUrl = fetchUrl.replace(
                "vidhidefast.com",
                "callistanise.com"
            );
        }

        if (
            fetchUrl.indexOf("vidhide.com") !== -1 &&
            fetchUrl.indexOf("callistanise") === -1
        ) {
            fetchUrl = fetchUrl.replace(
                "vidhide.com",
                "callistanise.com"
            );
        }

        var embedHost = getHost(fetchUrl);

        var refererBase =
            "https://" + embedHost + "/";

        addDebug(
            "[vidhide] fetch=" + fetchUrl
        );

        var html = httpGet(
            fetchUrl,
            {
                "User-Agent": UA,
                "Referer": refererBase
            }
        );

        addDebug(
            "[vidhide] htmlLen=" +
            (html ? html.length : 0)
        );

        if (
            !html ||
            html.length < 500
        ) {
            addDebug(
                "[vidhide] HTML insuficiente"
            );

            return null;
        }

        var splitIdx =
            html.lastIndexOf(".split('|')");

        addDebug(
            "[vidhide] splitIdx=" +
            splitIdx
        );

        if (splitIdx === -1) {
            addDebug(
                "[vidhide] No se encontró .split('|')"
            );

            return null;
        }

        var keyEnd =
            html.lastIndexOf(
                "'",
                splitIdx
            );

        var keyStart =
            html.lastIndexOf(
                "'",
                keyEnd - 1
            ) + 1;

        var key =
            html.substring(
                keyStart,
                keyEnd
            );

        var keyArr =
            key.split("|");

        addDebug(
            "[vidhide] keyArrLen=" +
            keyArr.length
        );

        if (keyArr.length < 50) {
            addDebug(
                "[vidhide] Array demasiado corto"
            );

            return null;
        }

        function decode(str) {
            return str.replace(
                /[a-z0-9]+/g,
                function(token) {
                    var val =
                        parseInt(token, 36);

                    if (
                        !isNaN(val) &&
                        val > 0 &&
                        val < keyArr.length &&
                        keyArr[val] &&
                        keyArr[val].length > 1
                    ) {
                        return keyArr[val];
                    }

                    return token;
                }
            );
        }

        var urls =
            html.match(
                /["'][a-z0-9]+:\/\/[^"']+["']/gi
            ) || [];

        addDebug(
            "[vidhide] candidateUrls=" +
            urls.length
        );

        var best = null;

        for (
            var i = 0;
            i < urls.length;
            i++
        ) {
            var raw =
                urls[i].substring(
                    1,
                    urls[i].length - 1
                );

            var dec =
                cleanUrl(
                    decode(raw)
                );

            if (
                dec.indexOf("master.") !== -1 &&
                dec.indexOf(".m3u8") !== -1
            ) {
                best = dec;
                break;
            }

            if (
                !best &&
                dec.indexOf("master.") !== -1 &&
                dec.indexOf(".txt") !== -1
            ) {
                best = dec;
            }
        }

        addDebug(
            "[vidhide] best=" +
            (best || "none")
        );

        if (!best) {
            return null;
        }

        // Si ya es M3U8, devolver directamente.
        if (isM3u8Url(best)) {
            return best;
        }

        // Algunos servidores entregan master.txt.
        if (/\.txt(?:[?#]|$)/i.test(best)) {
            addDebug(
                "[vidhide] master.txt detectado"
            );

            var txt = httpGet(
                best,
                {
                    "User-Agent": UA,
                    "Referer": refererBase
                }
            );

            addDebug(
                "[vidhide] txtLen=" +
                (txt ? txt.length : 0)
            );

            if (txt) {
                var m3u =
                    txt.match(
                        /https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/i
                    );

                if (m3u && m3u[0]) {
                    var finalUrl =
                        cleanUrl(m3u[0]);

                    addDebug(
                        "[vidhide] m3u8 encontrada dentro de master.txt"
                    );

                    return finalUrl;
                }
            }
        }

        addDebug(
            "[vidhide] No se pudo convertir la fuente"
        );

        return null;

    } catch (e) {
        addDebug(
            "[vidhide] EXCEPTION: " +
            String(e)
        );

        return null;
    }
}

// =========================================================
// VOE
// =========================================================

function voeExtract(pageUrl) {
    try {
        addDebug(
            "[voe] fetch=" + pageUrl
        );

        var html = httpGet(
            pageUrl,
            {
                "User-Agent": UA,
                "Referer": pageUrl
            }
        );

        addDebug(
            "[voe] htmlLen=" +
            (html ? html.length : 0)
        );

        if (!html) {
            return null;
        }

        var m =
            html.match(
                /hls\s*:\s*['"]([^'"]+\.m3u8[^'"]*)['"]/i
            );

        if (m && m[1]) {
            addDebug(
                "[voe] match directo hls"
            );

            return cleanUrl(m[1]);
        }

        var am =
            html.match(
                /atob\(['"]([^'"]+)['"]\)/
            );

        addDebug(
            "[voe] atobMatch=" +
            (am ? "si" : "no")
        );

        if (am) {
            try {
                var d =
                    b64decode(am[1]);

                var u =
                    d.match(
                        /https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/i
                    );

                addDebug(
                    "[voe] atob m3u8=" +
                    (u ? "si" : "no")
                );

                if (u) {
                    return cleanUrl(u[0]);
                }
            } catch (e) {
                addDebug(
                    "[voe] atob exception=" +
                    String(e)
                );
            }
        }

        var fm =
            html.match(
                /file\s*:\s*['"]([^'"]+\.m3u8[^'"]*)['"]/i
            );

        if (fm && fm[1]) {
            addDebug(
                "[voe] match file"
            );

            return cleanUrl(fm[1]);
        }

        addDebug(
            "[voe] ningun patron encontro nada"
        );

        return null;

    } catch (e) {
        addDebug(
            "[voe] EXCEPTION: " +
            String(e)
        );

        return null;
    }
}

// =========================================================
// DOOD / DO7GO
// =========================================================

function doodExtract(pageUrl) {
    try {
        addDebug(
            "[dood] fetch=" + pageUrl
        );

        var html = httpGet(
            pageUrl,
            {
                "User-Agent": UA,
                "Referer": pageUrl
            }
        );

        addDebug(
            "[dood] htmlLen=" +
            (html ? html.length : 0)
        );

        if (!html) {
            return null;
        }

        var m =
            html.match(
                /(?:file|link|source)\s*[:=]\s*['"]([^'"]+\.m3u8[^'"]*)['"]/i
            );

        if (m && m[1]) {
            addDebug(
                "[dood] match m3u8"
            );

            return cleanUrl(m[1]);
        }

        var mp4 =
            html.match(
                /(?:file|link|source)\s*[:=]\s*['"]([^'"]+\.mp4[^'"]*)['"]/i
            );

        if (mp4 && mp4[1]) {
            addDebug(
                "[dood] match mp4"
            );

            return cleanUrl(mp4[1]);
        }

        addDebug(
            "[dood] ningun patron encontro nada"
        );

        return null;

    } catch (e) {
        addDebug(
            "[dood] EXCEPTION: " +
            String(e)
        );

        return null;
    }
}

// =========================================================
// GENERIC
// =========================================================

function genericExtract(pageUrl) {
    try {
        addDebug(
            "[generic] fetch=" + pageUrl
        );

        var html = httpGet(
            pageUrl,
            {
                "User-Agent": UA,
                "Referer": pageUrl
            }
        );

        addDebug(
            "[generic] htmlLen=" +
            (html ? html.length : 0)
        );

        if (!html) {
            return null;
        }

        var m =
            html.match(
                /file\s*:\s*['"]([^'"]+\.m3u8[^'"]*)['"]/i
            );

        if (m && m[1]) {
            addDebug(
                "[generic] match file"
            );

            return cleanUrl(m[1]);
        }

        m =
            html.match(
                /source\s*:\s*['"]([^'"]+\.m3u8[^'"]*)['"]/i
            );

        if (m && m[1]) {
            addDebug(
                "[generic] match source"
            );

            return cleanUrl(m[1]);
        }

        m =
            html.match(
                /https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/i
            );

        if (m) {
            addDebug(
                "[generic] match suelto m3u8"
            );

            return cleanUrl(m[0]);
        }

        addDebug(
            "[generic] ningun patron encontro nada"
        );

        return null;

    } catch (e) {
        addDebug(
            "[generic] EXCEPTION: " +
            String(e)
        );

        return null;
    }
}

// =========================================================
// EXTRACTOR UNIFICADO
// =========================================================

function extractVideo(pageUrl) {
    if (!pageUrl) {
        addDebug(
            "[extract] URL vacia"
        );

        return null;
    }

    pageUrl = cleanUrl(pageUrl);

    // Si ya es un manifest HLS.
    if (isM3u8Url(pageUrl)) {
        return directHls(pageUrl);
    }

    var host = getHost(pageUrl);

    addDebug(
        "[extract] host=" + host
    );

    if (
        host.indexOf("vidhide") !== -1 ||
        host.indexOf("callistanise") !== -1
    ) {
        return vidhideExtract(pageUrl);
    }

    if (
        host.indexOf("voe") !== -1
    ) {
        return voeExtract(pageUrl);
    }

    if (
        host.indexOf("dood") !== -1 ||
        host.indexOf("do7go") !== -1
    ) {
        return doodExtract(pageUrl);
    }

    return genericExtract(pageUrl);
}

// =========================================================
// DETAIL
// =========================================================

function mkDetail(
    id,
    name,
    thumb,
    url,
    videoSources,
    description
) {
    var valid = [];
    var src = videoSources || [];

    for (
        var i = 0;
        i < src.length;
        i++
    ) {
        if (src[i]) {
            valid.push(src[i]);
        }
    }

    var desc =
        description || "";

    // IMPORTANTE:
    // Ya no se agrega el vídeo de prueba.
    if (valid.length === 0) {
        desc +=
            "\n\n⚠️ No se encontró una fuente de vídeo reproducible.";
    } else {
        desc +=
            "\n\n✅ Fuentes reproducibles encontradas: " +
            valid.length;
    }

    if (_debugLog.length > 0) {
        desc +=
            "\n\n=== REPORTE TÉCNICO ===\n" +
            _debugLog;
    }

    return new PlatformVideoDetails({
        id: new PlatformID(
            "PlayPelis",
            String(id),
            PID
        ),

        name: name || "Sin titulo",

        thumbnails: mkThumb(thumb),

        author: new PlatformAuthorLink(
            PPID,
            "PlayPelis",
            "https://playpelis.app",
            "",
            0
        ),

        uploadDate: 0,
        url: url,
        duration: 0,
        viewCount: 0,
        isLive: false,

        video:
            new VideoSourceDescriptor(valid),

        description: desc
    });
}

// =========================================================
// PLAYERPRO
// =========================================================

function ppGet(path) {
    try {
        var sep =
            path.indexOf("?") !== -1
                ? "&"
                : "?";

        var url =
            IPTV_URL +
            path +
            sep +
            "username=" +
            encodeURIComponent(IPTV_USER) +
            "&password=" +
            encodeURIComponent(IPTV_PASS);

        var response =
            http.GET(
                url,
                {
                    "User-Agent": "PLPro/8"
                }
            );

        if (
            !response ||
            !response.body
        ) {
            return null;
        }

        return JSON.parse(
            response.body
        );

    } catch (e) {
        return null;
    }
}

function ppHome() {
    var videos = [];

    try {
        var data =
            ppGet("/movies/resume");

        if (
            !data ||
            !data.movies
        ) {
            return videos;
        }

        for (
            var i = 0;
            i < data.movies.length &&
            i < 40;
            i++
        ) {
            var m =
                data.movies[i];

            if (m.b) {
                videos.push(
                    mkVideo(
                        "pp_m_" + m.a,

                        (m.l
                            ? "[" + m.l + "] "
                            : "") +
                        m.b +
                        (m.f
                            ? " (" + m.f + ")"
                            : ""),

                        fixImg(m.d) ||
                        fixImg(m.c) ||
                        "",

                        "pp://movie/" +
                        m.a,

                        "PlayPelis"
                    )
                );
            }
        }

    } catch (e) {}

    return videos;
}

function ppSearch(query) {
    var videos = [];

    var q =
        String(query || "")
            .toLowerCase();

    try {
        var data =
            ppGet("/movies/resume");

        if (
            data &&
            data.movies
        ) {
            for (
                var i = 0;
                i < data.movies.length &&
                videos.length < 30;
                i++
            ) {
                var m =
                    data.movies[i];

                if (
                    String(m.b || "")
                        .toLowerCase()
                        .indexOf(q) !== -1 ||

                    String(m.i || "")
                        .toLowerCase()
                        .indexOf(q) !== -1
                ) {
                    videos.push(
                        mkVideo(
                            "pp_m_" + m.a,

                            (m.l
                                ? "[" + m.l + "] "
                                : "") +
                            m.b +
                            (m.f
                                ? " (" + m.f + ")"
                                : ""),

                            fixImg(m.d) ||
                            fixImg(m.c) ||
                            "",

                            "pp://movie/" +
                            m.a,

                            "PlayPelis"
                        )
                    );
                }
            }
        }

        var sdata =
            ppGet("/series");

        if (
            sdata &&
            sdata.series
        ) {
            for (
                var j = 0;
                j < sdata.series.length &&
                videos.length < 60;
                j++
            ) {
                var s =
                    sdata.series[j];

                if (
                    String(s.b || "")
                        .toLowerCase()
                        .indexOf(q) !== -1 ||

                    String(s.i || "")
                        .toLowerCase()
                        .indexOf(q) !== -1
                ) {
                    videos.push(
                        mkVideo(
                            "pp_s_" + s.a,
                            "[Serie] " + s.b,
                            fixImg(s.d) ||
                            fixImg(s.c) ||
                            "",
                            "pp://serie/" +
                            s.a,
                            "PlayPelis"
                        )
                    );
                }
            }
        }

    } catch (e) {}

    return videos;
}

// =========================================================
// PELÍCULA
// =========================================================

function ppMovieDetails(id) {
    _debugLog = "";

    var data =
        ppGet("/movies/" + id);

    if (!data) {
        return mkDetail(
            "pp_m_" + id,
            "Sin resultado",
            "",
            "pp://movie/" + id,
            [],
            ""
        );
    }

    var title =
        data.b || "";

    var thumb =
        fixImg(data.d) ||
        fixImg(data.c) ||
        "";

    var desc =
        data.e || "";

    var linksData =
        ppGet(
            "/movies/" +
            id +
            "/links"
        );

    var sources = [];

    if (
        linksData &&
        linksData.length
    ) {
        desc +=
            "\n\n--- Servidores ---";

        var tried = 0;

        for (
            var i = 0;
            i < linksData.length &&
            tried < MAX_TRY;
            i++
        ) {
            var link =
                linksData[i];

            var linkUrl =
                link.a || "";

            if (!linkUrl) {
                continue;
            }

            tried++;

            var serverName =
                (link.b || "Servidor") +
                " [" +
                (link.c || "") +
                "]";

            desc +=
                "\n" +
                serverName +
                " → " +
                linkUrl;

            addDebug(
                "[movie] probando " +
                tried +
                "/" +
                MAX_TRY +
                ": " +
                linkUrl
            );

            var extracted =
                extractVideo(
                    linkUrl
                );

            if (extracted) {
                var source =
                    mkHls(
                        extracted,
                        serverName
                    );

                if (source) {
                    sources.push(
                        source
                    );

                    addDebug(
                        "[movie] FUENTE OK: " +
                        serverName
                    );
                }
            } else {
                addDebug(
                    "[movie] FALLÓ: " +
                    serverName
                );
            }
        }

        if (
            linksData.length >
            tried
        ) {
            desc +=
                "\n\n(" +
                (
                    linksData.length -
                    tried
                ) +
                " servidores más sin probar)";
        }
    }

    return mkDetail(
        "pp_m_" + id,
        title,
        thumb,
        "pp://movie/" + id,
        sources,
        desc
    );
}

// =========================================================
// SERIES
// =========================================================

function ppSerieDetails(id) {
    _debugLog = "";

    var data =
        ppGet("/series/" + id);

    if (!data) {
        return mkDetail(
            "pp_s_" + id,
            "Sin resultado",
            "",
            "pp://serie/" + id,
            [],
            ""
        );
    }

    var title =
        data.b || "";

    var thumb =
        fixImg(data.d) ||
        fixImg(data.c) ||
        "";

    var desc =
        (data.e || "") +
        "\n\n--- Temporadas y Episodios ---";

    var seasons =
        data.seasons ||
        data.f ||
        [];

    if (
        typeof seasons === "number"
    ) {
        seasons = [];
    }

    for (
        var si = 0;
        si < seasons.length;
        si++
    ) {
        var season =
            seasons[si];

        var seasonNum =
            season.num ||
            season.a ||
            (si + 1);

        var episodes =
            season.episodes ||
            season.b ||
            [];

        desc +=
            "\n\nTemporada " +
            seasonNum +
            ":";

        for (
            var ei = 0;
            ei < episodes.length;
            ei++
        ) {
            var ep =
                episodes[ei];

            var epNum =
                ep.num ||
                ep.a ||
                (ei + 1);

            desc +=
                "\n  Ep " +
                epNum +
                " → pp://serie/" +
                id +
                "/" +
                seasonNum +
                "/" +
                epNum;
        }
    }

    return mkDetail(
        "pp_s_" + id,
        title,
        thumb,
        "pp://serie/" + id,
        [],
        desc
    );
}

// =========================================================
// EPISODIO
// =========================================================

function ppEpisodeLinks(
    id,
    season,
    episode
) {
    _debugLog = "";

    var data =
        ppGet("/series/" + id);

    if (!data) {
        return mkDetail(
            "pp_se_" + id,
            "Sin resultado",
            "",
            "",
            [],
            ""
        );
    }

    var title =
        (data.b || "") +
        " S" +
        season +
        "E" +
        episode;

    var thumb =
        fixImg(data.d) ||
        fixImg(data.c) ||
        "";

    var linksData =
        ppGet(
            "/series/" +
            id +
            "/links/" +
            season +
            "/" +
            episode
        );

    var desc =
        title +
        "\n\n--- Servidores ---";

    var sources = [];

    if (
        linksData &&
        linksData.length
    ) {
        var tried = 0;

        for (
            var i = 0;
            i < linksData.length &&
            tried < MAX_TRY;
            i++
        ) {
            var link =
                linksData[i];

            var linkUrl =
                link.a || "";

            if (!linkUrl) {
                continue;
            }

            tried++;

            var serverName =
                (link.b || "Servidor") +
                " [" +
                (link.c || "") +
                "]";

            desc +=
                "\n" +
                serverName +
                " → " +
                linkUrl;

            addDebug(
                "[episode] probando " +
                tried +
                "/" +
                MAX_TRY +
                ": " +
                linkUrl
            );

            var extracted =
                extractVideo(
                    linkUrl
                );

            if (extracted) {
                var source =
                    mkHls(
                        extracted,
                        serverName
                    );

                if (source) {
                    sources.push(
                        source
                    );

                    addDebug(
                        "[episode] FUENTE OK: " +
                        serverName
                    );
                }
            } else {
                addDebug(
                    "[episode] FALLÓ: " +
                    serverName
                );
            }
        }
    }

    var epNum =
        parseInt(
            episode,
            10
        );

    if (epNum > 1) {
        desc +=
            "\n\n← Ep Anterior: pp://serie/" +
            id +
            "/" +
            season +
            "/" +
            (epNum - 1);
    }

    desc +=
        "\n→ Ep Siguiente: pp://serie/" +
        id +
        "/" +
        season +
        "/" +
        (epNum + 1);

    return mkDetail(
        "pp_se_" +
        id +
        "_" +
        season +
        "_" +
        episode,

        title,

        thumb,

        "pp://serie/" +
        id +
        "/" +
        season +
        "/" +
        episode,

        sources,

        desc
    );
}

// =========================================================
// JKANIME
// =========================================================

function jkaSearch(query) {
    var out = [];

    try {
        var slug =
            slugify(query);

        if (!slug) {
            return out;
        }

        var html =
            httpGet(
                JK +
                "/buscar/" +
                slug +
                "/",
                {
                    "Referer":
                        JK + "/"
                }
            );

        if (!html) {
            return out;
        }

        var re =
            /<div class="anime__item">\s*<a\s+href="(https?:\/\/jkanime\.net\/[a-z0-9-]+\/)"[^>]*>[\s\S]*?<div[^>]*data-setbg="([^"]*)"[\s\S]*?<h5><a[^>]*>([^<]+)<\/a><\/h5>/gi;

        var m;

        while (
            (m = re.exec(html)) &&
            out.length < 30
        ) {
            out.push({
                title:
                    htmlDecode(m[3]),

                url:
                    m[1],

                thumb:
                    m[2]
            });
        }

    } catch (e) {}

    return out;
}

function jkaExtractVideo(
    episodeUrl
) {
    addDebug(
        "JKA: Extrayendo episodio " +
        episodeUrl
    );

    var html =
        httpGet(
            episodeUrl,
            {
                "Referer":
                    JK + "/"
            }
        );

    if (!html) {
        addDebug(
            "JKA: HTML nulo"
        );

        return null;
    }

    var re =
        /video\[\d+\]\s*=\s*'[^']*src="(https?:\/\/jkanime\.net\/jkplayer\/um[^"]*)"/i;

    var m =
        html.match(re);

    if (
        !m ||
        !m[1]
    ) {
        addDebug(
            "JKA: No se encontró iframe"
        );

        return null;
    }

    var playerUrl =
        m[1].replace(
            /&amp;/g,
            "&"
        );

    addDebug(
        "JKA: Cargando reproductor: " +
        playerUrl
    );

    var playerHtml =
        httpGet(
            playerUrl,
            {
                "Referer":
                    episodeUrl
            }
        );

    if (!playerHtml) {
        addDebug(
            "JKA: Player HTML nulo"
        );

        return null;
    }

    addDebug(
        "JKA Player HTML length: " +
        playerHtml.length
    );

    var m3u8 =
        playerHtml.match(
            /url\s*[:=]\s*['"]([^'"]+\.m3u8[^'"]*)['"]/i
        );

    if (
        m3u8 &&
        m3u8[1]
    ) {
        return mkHls(
            cleanUrl(m3u8[1]),
            "JkAnime"
        );
    }

    addDebug(
        "JKA: No se encontró m3u8"
    );

    return null;
}

function jkaDetails(url) {
    _debugLog = "";

    var html =
        httpGet(
            url,
            {
                "Referer":
                    JK + "/"
            }
        );

    if (!html) {
        return mkDetail(
            "jk_" + url,
            "Sin resultado",
            "",
            url,
            [],
            "No se pudo cargar"
        );
    }

    var title = "";

    var tm =
        html.match(
            /<h1[^>]*>([\s\S]*?)<\/h1>/i
        );

    if (tm) {
        title =
            stripTags(tm[1]);
    }

    title =
        (title || "")
            .replace(
                /\s*-\s*anime.*JkAnime/i,
                ""
            )
            .replace(
                /JkAnime/i,
                ""
            )
            .trim();

    var thumb = "";

    var im =
        html.match(
            /<img[^>]*src=["']([^"']*animes\/(?:image|video)\/[^"']+)["']/i
        );

    if (im) {
        thumb =
            im[1].indexOf("http") === 0
                ? im[1]
                : JK +
                  "/" +
                  im[1].replace(
                      /^\/+/,
                      ""
                  );
    }

    var desc = "";

    var seriesMatch =
        url.match(
            /jkanime\.net\/([a-z0-9-]+)\/?$/i
        );

    var episodeMatch =
        url.match(
            /jkanime\.net\/([a-z0-9-]+)\/(\d+)\/?$/i
        );

    if (
        seriesMatch &&
        !episodeMatch
    ) {
        var episodes = [];

        var re =
            /<a[^>]*href="\/([a-z0-9-]+)\/(\d+)\/?"[^>]*>/gi;

        var slug =
            seriesMatch[1];

        var m;

        while (
            (m = re.exec(html)) &&
            episodes.length < 200
        ) {
            if (
                m[1] === slug
            ) {
                episodes.push({
                    number:
                        parseInt(
                            m[2],
                            10
                        ),

                    url:
                        JK +
                        "/" +
                        m[1] +
                        "/" +
                        m[2] +
                        "/"
                });
            }
        }

        episodes.sort(
            function(a, b) {
                return (
                    a.number -
                    b.number
                );
            }
        );

        desc +=
            "\n\n--- Episodios (" +
            episodes.length +
            ") ---";

        for (
            var ei = 0;
            ei < episodes.length;
            ei++
        ) {
            desc +=
                "\nEp " +
                episodes[ei].number +
                " → " +
                episodes[ei].url;
        }

        var sources = [];

        if (
            episodes.length > 0
        ) {
            var firstSrc =
                jkaExtractVideo(
                    episodes[0].url
                );

            if (firstSrc) {
                sources.push(
                    firstSrc
                );
            }
        }

        return mkDetail(
            "jk_" + url,
            title ||
                slugToTitle(slug),
            thumb,
            url,
            sources,
            desc
        );
    }

    var episodeSources =
        jkaExtractVideo(url);

    var srcArray =
        episodeSources
            ? [episodeSources]
            : [];

    return mkDetail(
        "jk_" + url,
        title || "Anime",
        thumb,
        url,
        srcArray,
        desc
    );
}

// =========================================================
// UNIFIED
// =========================================================

function doSearch(query) {
    var results = [];

    try {
        var r =
            ppSearch(query);

        for (
            var i = 0;
            i < r.length;
            i++
        ) {
            results.push(
                r[i]
            );
        }
    } catch (e) {}

    try {
        var jka =
            jkaSearch(query);

        for (
            var j = 0;
            j < jka.length;
            j++
        ) {
            results.push(
                mkVideo(
                    "jk_" +
                    jka[j].url,

                    "[Anime] " +
                    jka[j].title,

                    jka[j].thumb,

                    jka[j].url,

                    "JkAnime"
                )
            );
        }

    } catch (e) {}

    return results;
}

function doDetails(url) {
    if (!url) {
        return mkDetail(
            "",
            "",
            "",
            "",
            [],
            "URL vacía"
        );
    }

    if (
        url.indexOf(
            "jkanime.net"
        ) !== -1
    ) {
        return jkaDetails(url);
    }

    if (
        url.indexOf(
            "pp://movie/"
        ) === 0
    ) {
        var mm =
            url.match(
                /pp:\/\/movie\/(\d+)/
            );

        if (mm) {
            return ppMovieDetails(
                mm[1]
            );
        }
    }

    if (
        url.indexOf(
            "pp://serie/"
        ) === 0
    ) {
        var se =
            url.match(
                /pp:\/\/serie\/(\d+)\/(\d+)\/(\d+)/
            );

        if (se) {
            return ppEpisodeLinks(
                se[1],
                se[2],
                se[3]
            );
        }

        var ss =
            url.match(
                /pp:\/\/serie\/(\d+)/
            );

        if (ss) {
            return ppSerieDetails(
                ss[1]
            );
        }
    }

    return mkDetail(
        "",
        "",
        "",
        url,
        [],
        ""
    );
}

// =========================================================
// HOME
// =========================================================

function doHome() {
    var videos = [];

    try {
        var r =
            ppHome();

        for (
            var i = 0;
            i < r.length;
            i++
        ) {
            videos.push(
                r[i]
            );
        }

    } catch (e) {}

    try {
        var jkHtml =
            httpGet(
                JK + "/",
                {
                    "Referer":
                        JK + "/"
                }
            );

        if (jkHtml) {
            var re =
                /data-setbg="([^"]*)"[^>]*>[\s\S]*?<h2[^>]*>([\s\S]*?)<\/h2>/gi;

            var m;

            while (
                (m = re.exec(jkHtml)) &&
                videos.length < 60
            ) {
                var linkRe =
                    /href="(https?:\/\/jkanime\.net\/[a-z0-9-]+\/?)"/i;

                var pos =
                    jkHtml.indexOf(
                        m[0]
                    );

                var anchor =
                    jkHtml.substring(
                        Math.max(
                            0,
                            pos - 500
                        ),
                        pos +
                        m[0].length
                    );

                var lm =
                    anchor.match(
                        linkRe
                    );

                videos.push(
                    mkVideo(
                        "jk_home_" +
                        (
                            lm
                                ? lm[1]
                                : JK + "/"
                        ),

                        "[Anime] " +
                        stripTags(m[2]),

                        m[1],

                        lm
                            ? lm[1]
                            : JK + "/",

                        "JkAnime"
                    )
                );
            }
        }

    } catch (e) {}

    return videos;
}

// =========================================================
// BINDINGS
// =========================================================

if (
    typeof source !== "undefined"
) {
    source.setSettings =
        function(s) {
            _settings =
                s || {};
        };

    source.enable =
        function(c, s) {
            _settings =
                s || {};
        };

    source.getSearchCapabilities =
        function() {
            return {
                types: [2],
                sorts: [],
                filters: []
            };
        };

    source.search =
        function(query) {
            try {
                return new VideoPager(
                    doSearch(
                        query || ""
                    ),
                    false,
                    null
                );
            } catch (e) {
                return new VideoPager(
                    [],
                    false,
                    null
                );
            }
        };

    source.isContentDetailsUrl =
        function(url) {
            return (
                url &&
                (
                    url.indexOf(
                        "jkanime.net"
                    ) !== -1 ||

                    url.indexOf(
                        "pp://"
                    ) !== -1
                )
            );
        };

    source.isVideoDetailsUrl =
        function(url) {
            return source
                .isContentDetailsUrl(
                    url
                );
        };

    source.getVideoDetails =
        function(url) {
            return source
                .getContentDetails(
                    url
                );
        };

    source.getHome =
        function() {
            try {
                return new VideoPager(
                    doHome(),
                    false,
                    null
                );
            } catch (e) {
                return new VideoPager(
                    [],
                    false,
                    null
                );
            }
        };

    source.isChannelUrl =
        function(url) {
            return false;
        };

    source.searchSuggestions =
        function(query) {
            return [];
        };

    source.getContentDetails =
        function(url) {
            try {
                var r =
                    doDetails(url);

                if (r) {
                    return r;
                }

                throw new Error(
                    "doDetails retornó null"
                );

            } catch (e) {
                return new PlatformVideoDetails({
                    id: new PlatformID(
                        "PlayPelis",
                        "error_fallo",
                        PID
                    ),

                    name:
                        "Error de Extractor",

                    thumbnails:
                        new Thumbnails([
                            new Thumbnail(
                                TMDB_IMG +
                                "/wwemzKWzjKYJFfCeiB57q3r4Bcm.png",
                                100
                            )
                        ]),

                    author:
                        new PlatformAuthorLink(
                            PPID,
                            "PlayPelis",
                            "https://playpelis.app",
                            "",
                            0
                        ),

                    uploadDate: 0,
                    url:
                        url ||
                        "https://playpelis.app",
                    duration: 0,
                    viewCount: 0,
                    isLive: false,

                    description:
                        "CRASH CRÍTICO: " +
                        String(e) +
                        "\n\nLOG TÉCNICO:\n" +
                        _debugLog,

                    // Sin vídeo falso.
                    video:
                        new VideoSourceDescriptor([])
                });
            }
        };
}
