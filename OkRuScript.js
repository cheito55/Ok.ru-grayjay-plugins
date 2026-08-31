// ============================================================
// Plugin de GrayJay para OK.ru (Odnoklassniki)
// ============================================================
// Basado en la lógica de extracción usada por streamlink y yt-dlp:
// - La página del video trae un atributo data-options="{...}" con
//   flashvars.metadata (o flashvars.metadataUrl para pedirlo aparte).
// - Dentro de metadata está movie (título, poster, duración) y
//   hlsManifestUrl / hlsMasterPlaylistUrl con el link HLS firmado.
// - La búsqueda usa el endpoint público /search/content, que
//   NO requiere sesión logueada. Cada resultado viene en un bloque
//   vid-card con data-movie-id, data-options (contiene poster),
//   y un enlace con title y clase video-card_n.
//
// IMPORTANTE - revisar antes de usar:
// - Los nombres exactos de clases (HLSSource, VideoUrlSource,
//   PlatformVideoDetails, PlatformVideo, PlatformID, PlatformAuthorLink,
//   Thumbnails, VideoSourceDescriptor, VideoPager) son los que usan
//   los plugins oficiales de GrayJay (ej. Odysee). Si alguna vuelve
//   a tirar ReferenceError, es la próxima sospechosa.
// - "PLATFORM" ya no se asume como global: se guarda el id real del
//   plugin en PLUGIN_ID durante source.enable(conf, ...).
// - FIX: en la versión móvil (m.ok.ru), flashvars.metadata viene ya
//   como OBJETO, no como string JSON (a diferencia de la versión de
//   escritorio). Por eso getContentDetails ahora chequea el tipo
//   antes de decidir si hace falta JSON.parse o no.
// ============================================================

const PLATFORM_NAME = "OK.ru";
const REGEX_VIDEO_URL = /ok\.ru\/(?:video|videoembed)\/(\d+)/;
const SEARCH_URL_BASE = "https://ok.ru/search/content?query=";

// Guardamos acá el id real del plugin, que llega como parámetro en
// enable() -- NO existe un global "config" inyectado por GrayJay.
let PLUGIN_ID = "";

// ------------------------------------------------------------
// Habilitación del plugin (obligatorio en la mayoría de plugins)
// ------------------------------------------------------------
source.enable = function (conf, settings, savedState) {
    PLUGIN_ID = (conf && conf.id) ? conf.id : "";
};

// ------------------------------------------------------------
// Detección de URLs que este plugin puede manejar
// ------------------------------------------------------------
source.isContentDetailsUrl = function (url) {
    return REGEX_VIDEO_URL.test(url);
};

// ------------------------------------------------------------
// Obtención del detalle/reproducción del video
// ------------------------------------------------------------
source.getContentDetails = function (url) {
    const match = url.match(REGEX_VIDEO_URL);
    if (!match) {
        throw new ScriptException("URL de OK.ru no reconocida: " + url);
    }
    const videoId = match[1];
    const pageUrl = "https://ok.ru/video/" + videoId;
    const mobileUrl = "https://m.ok.ru/video/" + videoId;

    let html = fetchPageHtml(mobileUrl);
    let optionsMatch = html ? html.match(/data-options="([^"]+)"/) : null;

    if (!optionsMatch) {
        html = fetchPageHtml(pageUrl);
        optionsMatch = html ? html.match(/data-options="([^"]+)"/) : null;
    }

    if (!html) {
        throw new ScriptException("No se pudo cargar la página de OK.ru");
    }

    const stubError = html.match(/class="vp_video_stub_txt"[^>]*>([^<]+)</);
    if (stubError) {
        throw new ScriptException("Video no disponible: " + stubError[1]);
    }

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
        throw new ScriptException("No se encontró metadata ni metadataUrl en flashvars");
    }

    return buildVideoDetails(videoId, pageUrl, metadata);
};

// ------------------------------------------------------------
// Búsqueda de videos
// ------------------------------------------------------------
// Usa el endpoint público /search/content de OK.ru, que funciona
// SIN sesión logueada. Cada resultado viene en un bloque HTML con:
//   - data-movie-id="NUMERO" → ID del video
//   - data-options="..." con "poster":"URL" → thumbnail
//   - class="video-card_n" con title="..." → título del video
//   - class="vid-card_duration">XX:XX → duración
//   - class="video-card_info_i">N views → vistas
source.search = function (query, type, order, filters) {
    if (!query) {
        return new VideoPager([], false, {});
    }

    const searchUrl = SEARCH_URL_BASE + encodeURIComponent(query);

    const resp = http.GET(searchUrl, {
        "Referer": "https://ok.ru/"
    }, false);

    if (!resp.isOk) {
        throw new ScriptException("Error al buscar en OK.ru (status " + resp.code + ")");
    }

    const html = resp.body;
    const results = [];

    const movieIdRegex = /data-movie-id="(\d+)"/g;
    let idMatch;

    while ((idMatch = movieIdRegex.exec(html)) !== null) {
        const videoId = idMatch[1];

        const searchStart = idMatch.index;
        const searchEnd = Math.min(searchStart + 5000, html.length);
        const block = html.substring(searchStart, searchEnd);

        // El poster viene como &quot;poster&quot;:&quot;URL&quot; en
        // el HTML crudo (el &quot; es la entidad HTML de comilla doble).
        const posterMatch = block.match(/poster&quot;:&quot;(https?:\/\/[^&]+)/);
        let posterUrl = "";
        if (posterMatch) {
            posterUrl = posterMatch[1]
                .replace(/\\u0026/g, "&")
                .replace(/&#39;/g, "'");
        }

        // Título: class="video-card_n" con title="..." (comillas reales)
        const titleMatch = block.match(/class="video-card_n[^"]*"[^>]*title="([^"]+)"/);
        const title = titleMatch
            ? unescapeHtml(titleMatch[1])
            : "Video de OK.ru";

        // Duración: class="vid-card_duration">XX:XX
        const durMatch = block.match(/class="vid-card_duration"[^>]*>([^<]+)/);
        const durationStr = durMatch ? durMatch[1].trim() : "0:00";
        const durationSec = parseDuration(durationStr);

        // Vistas: class="video-card_info_i">N views
        const viewsMatch = block.match(/class="video-card_info_i"[^>]*>([^<]+)/);
        const viewsStr = viewsMatch ? viewsMatch[1].trim() : "0";
        const viewCount = parseViewCount(viewsStr);

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

    return new VideoPager(results, false, {});
};

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

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
            author.name || "OK.ru",
            "",
            ""
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

// Parsea duraciones como "02:58" o "1:23:45" a segundos
function parseDuration(str) {
    const parts = str.split(":").map(Number);
    if (parts.length === 3) {
        return parts[0] * 3600 + parts[1] * 60 + parts[2];
    } else if (parts.length === 2) {
        return parts[0] * 60 + parts[1];
    }
    return 0;
}

// Parsea strings de vistas como "72 771 просмотр" o "1 596 просмотров" a número.
// Limpia &nbsp;, espacios, y texto no numérico.
function parseViewCount(str) {
    const cleaned = str
        .replace(/&nbsp;/g, "")
        .replace(/\u00a0/g, "")
        .replace(/[^\d]/g, "");
    const n = parseInt(cleaned, 10);
    return isNaN(n) ? 0 : n;
}

// ------------------------------------------------------------
// Stubs requeridos por la interfaz de plugin
// ------------------------------------------------------------
source.getHome = function () {
    return new VideoPager([], false, {});
};
