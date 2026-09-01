// ============================================================
// Plugin de GrayJay para OK.ru (Odnoklassniki) v3
// ============================================================
//
// CAMBIO CLAVE (v3): el Cast a Chromecast fallaba porque el CDN
// de OK.ru (okcdn.ru) exige un header Referer que reconozca, y
// el codigo anterior intentaba resolver esto con "impersonateTarget"
// (impersonacion TLS via httpimp), lo cual requiere una libreria
// que no siempre esta disponible y ademas cambia el motor HTTP
// interno de GrayJay.
//
// La correccion usa el mismo patron que el plugin OFICIAL de
// Odysee (que sí castea sin problemas): requestModifier con
// headers planos, sin impersonacion:
//
//   requestModifier: { headers: { "Referer": "...", ... } }
//
// Esto le dice a GrayJay que adjunte esos headers a cada peticion
// que hace el reproductor/Chromecast al pedir el video, sin tocar
// el motor de conexion HTTP.
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
// ATENCION SEGURIDAD: si este archivo se sube a un repositorio
// PUBLICO de GitHub con las cookies rellenas, cualquiera que lo
// lea puede usar tu sesion de OK.ru. Se recomienda dejar estos
// tres campos vacios en la version que se publica, y pegarlos
// solo en una copia local del archivo.
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

// ------------------------------------------------------------
// Headers para reproduccion/Cast (patron Odysee: headers planos,
// sin impersonacion TLS). Referer y Origin son los que okcdn.ru
// revisa para autorizar la entrega del video/manifest.
// ------------------------------------------------------------
const PLAYBACK_HEADERS = {
    "Referer": "https://ok.ru/",
    "Origin": "https://ok.ru",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
};

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
    let cookieHeader = "";

    // Estrategia 1: desktop con cookies manuales
    if (MANUAL_JSESSIONID || MANUAL_AUTHCODE) {
        cookieHeader = buildCookieHeader();
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
        html = fetchPageWithCookie(mobileUrl, cookieHeader);
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

// ------------------------------------------------------------
// Construccion del video
// ------------------------------------------------------------
function buildVideoDetails(videoId, pageUrl, metadata) {
    var movie = safeObj(metadata.movie);
    var author = safeObj(metadata.author);

    var sources = [];
    var seenUrls = {};

    // === HLS (prioridad máxima) ===
    var hlsCandidates = collectHlsUrls(metadata);
    for (var i = 0; i < hlsCandidates.length; i++) {
        var u = hlsCandidates[i];
        if (seenUrls[u]) continue;
        seenUrls[u] = true;
        sources.push(new HLSSource({
            name: "HLS",
            url: u,
            duration: intOrZero(movie.duration),
            // Headers planos (patron Odysee) para que el CDN de OK.ru
            // acepte la peticion venga de donde venga (telefono o Chromecast)
            requestModifier: { headers: PLAYBACK_HEADERS }
        }));
    }

    // === MP4 (fallback) ===
    var videos = metadata.videos || [];
    for (var j = 0; j < videos.length; j++) {
        var v = videos[j];
        if (!v || !v.url || seenUrls[v.url]) continue;
        // Saltar embeds externos
        if (EXTERNAL_EMBED_REGEX.test(v.url)) continue;
        seenUrls[v.url] = true;
        sources.push(new VideoUrlSource({
            name: v.name || ("mp4-" + (j + 1)),
            url: v.url,
            container: "video/mp4",
            requestModifier: { headers: PLAYBACK_HEADERS }
        }));
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
