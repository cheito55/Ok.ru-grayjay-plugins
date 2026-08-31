// ============================================================
// Plugin de GrayJay para OK.ru (Odnoklassniki)
// ============================================================
// Basado en la lógica de extracción usada por streamlink y yt-dlp:
// - La página del video trae un atributo data-options="{...}" con
//   flashvars.metadata (o flashvars.metadataUrl para pedirlo aparte).
// - Dentro de metadata está movie (título, poster, duración) y
//   hlsManifestUrl / hlsMasterPlaylistUrl con el link HLS firmado.
// - La búsqueda usa el endpoint interno st.cmd=searchResult, que
//   SÍ EXIGE sesión logueada (confirmado con debug: sin login,
//   devuelve la pantalla de "unite a OK" en vez de resultados).
//   Por eso, en vez de fabricar cookies a mano, este plugin usa el
//   mecanismo oficial de autenticación de GrayJay (ver el bloque
//   "authentication" en OkRuConfig.json): GrayJay muestra un login
//   real en un navegador embebido, y una vez que el usuario inicia
//   sesión, captura las cookies (JSESSIONID, AUTHCODE, domain_sid)
//   y las reutiliza automáticamente en cualquier request que se
//   haga con el flag "useAuth" en true.
//
// IMPORTANTE - revisar antes de usar:
// - Los nombres exactos de clases (HLSSource, VideoUrlSource,
//   PlatformVideoDetails, PlatformVideo, PlatformID, PlatformAuthorLink,
//   Thumbnails, VideoSourceDescriptor, VideoPager) son los que usan los
//   plugins oficiales de GrayJay (ej. Odysee). Si alguna vuelve a tirar
//   ReferenceError, es la próxima sospechosa.
// - "PLATFORM" ya no se asume como global: se guarda el id real del
//   plugin en PLUGIN_ID durante source.enable(conf, ...).
// - Si el usuario nunca inició sesión desde GrayJay (Sources > este
//   plugin > Login), la búsqueda va a seguir fallando -- eso es
//   esperado, no es un bug del script.
// ============================================================

const PLATFORM_NAME = "OK.ru";
const REGEX_VIDEO_URL = /ok\.ru\/(?:video|videoembed)\/(\d+)/;
const SEARCH_URL_BASE = "https://ok.ru/dk?st.cmd=searchResult&st.mode=Movie&st.grmode=Groups&st.query=";

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
// Ojo: esto funciona sin login (confirmado), así que se deja el
// tercer parámetro de http.GET en false a propósito -- no atar la
// reproducción a que el usuario tenga que loguearse.
source.getContentDetails = function (url) {
    const match = url.match(REGEX_VIDEO_URL);
    if (!match) {
        throw new ScriptException("URL de OK.ru no reconocida: " + url);
    }
    const videoId = match[1];
    // pageUrl (desktop) es la que se guarda en los resultados/detalles;
    // pero para el fetch en sí probamos primero la versión móvil, que
    // es bastante más liviana y baja más rápido.
    const pageUrl = "https://ok.ru/video/" + videoId;
    const mobileUrl = "https://m.ok.ru/video/" + videoId;

    let html = fetchPageHtml(mobileUrl);
    let optionsMatch = html ? html.match(/data-options="([^"]+)"/) : null;

    // Si la versión móvil no trajo data-options (estructura distinta,
    // bloqueo, lo que sea), caemos a la de escritorio de toda la vida.
    if (!optionsMatch) {
        html = fetchPageHtml(pageUrl);
        optionsMatch = html ? html.match(/data-options="([^"]+)"/) : null;
    }

    if (!html) {
        throw new ScriptException("No se pudo cargar la página de OK.ru");
    }

    // Chequeo de video no disponible / privado / borrado
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
// Búsqueda de videos
// ------------------------------------------------------------
// Usa el endpoint interno de búsqueda de OK.ru (st.cmd=searchResult).
// Requiere sesión logueada -- por eso el tercer parámetro de
// http.GET va en TRUE: le pide a GrayJay que inyecte automáticamente
// las cookies de la sesión que el usuario inició a través del login
// nativo de la app (ver bloque "authentication" del config).
source.search = function (query, type, order, filters) {
    if (!query) {
        return new VideoPager([], false, {});
    }

    const searchUrl = SEARCH_URL_BASE + encodeURIComponent(query);

    const resp = http.GET(searchUrl, {
        "Referer": "https://ok.ru/video"
    }, true); // <-- useAuth = true: reutiliza la sesión logueada

    if (!resp.isOk) {
        if (resp.code === 401 || resp.code === 403) {
            throw new ScriptException("Iniciá sesión con tu cuenta de OK.ru desde este plugin (Sources > OK.ru > Login) para poder buscar.");
        }
        throw new ScriptException("Error al buscar en OK.ru (status " + resp.code + ")");
    }

    // El HTML viene con el JSON doble-escapado como entidades HTML
    const html = resp.body
        .replace(/&amp;quot;/g, '"')
        .replace(/&amp;amp;/g, "&");

    const hasLoginWall = html.indexOf("\u041f\u0440\u0438\u0441\u043e\u0435\u0434\u0438\u043d") !== -1;
    if (hasLoginWall) {
        throw new ScriptException("OK.ru pidió iniciar sesión de nuevo. Volvé a loguearte desde Sources > OK.ru > Login.");
    }

    const results = [];
    // Cada resultado trae un bloque "movie":{"info":{...}} con
    // href, id, provider, title, description, thumbnail y demás.
    const regex = /"movie":\{"info":\{"href":"([^"]+)","id":"(\d+)","provider":"[^"]*","title":"((?:[^"\\]|\\.)*)","description":"(?:[^"\\]|\\.)*","thumbnail":\{"small":"((?:[^"\\]|\\.)*)"[^}]*\},[^}]*"duration":(\d+)[^}]*"totalViews":(\d+)/g;

    let match;
    while ((match = regex.exec(html)) !== null) {
        const videoId = match[2];
        const title = safeJsonUnescape(match[3]);
        const thumbUrl = safeJsonUnescape(match[4]).replace(/\\u0026/g, "&");
        const durationMs = parseInt(match[5], 10) || 0;
        const viewCount = parseInt(match[6], 10) || 0;

        results.push(new PlatformVideo({
            id: new PlatformID(PLATFORM_NAME, videoId, PLUGIN_ID),
            name: title,
            thumbnails: new Thumbnails([{ url: thumbUrl, quality: 480 }]),
            author: new PlatformAuthorLink(
                new PlatformID(PLATFORM_NAME, "", PLUGIN_ID),
                "OK.ru",
                "",
                ""
            ),
            uploadDate: 0,
            duration: Math.round(durationMs / 1000),
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

// GET simple que devuelve el body si sale bien, o null si falla --
// pensado para poder probar mobile primero y desktop como fallback
// sin repetir el manejo de errores dos veces.
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

    // Agregamos User-Agent para engañar a la seguridad de OK.ru en el Chromecast
    const castHeaders = {
        "Referer": pageUrl,
        "Origin": "https://ok.ru",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36"
    };

    // 1. PRIORIDAD CHROMECAST: Extraemos los MP4 primero.
    // Al ser un solo archivo, el Chromecast no pierde los encabezados.
    if (Array.isArray(metadata.videos)) {
        // OK.ru suele traer calidades como "mobile", "lowest", "low", "sd", "hd"
        // Los invertimos para que GrayJay agarre la mejor calidad por defecto
        const videosInvertidos = metadata.videos.reverse();
        
        for (const v of videosInvertidos) {
            if (v && v.url) {
                sources.push(new VideoUrlSource({
                    name: v.name || "mp4",
                    url: v.url,
                    container: "video/mp4",
                    headers: castHeaders
                }));
            }
        }
    }

    // 2. RESPALDO: Dejamos HLS solo si por alguna razón no hay MP4
    const hlsUrl = metadata.hlsManifestUrl || metadata.hlsMasterPlaylistUrl;
    if (hlsUrl && sources.length === 0) {
        sources.push(new HLSSource({
            name: "HLS",
            url: hlsUrl,
            duration: intOrZero(movie.duration),
            headers: castHeaders
        }));
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
        isLive: false, // Nota: Las transmisiones en vivo reales usarán otro método si es necesario
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

// Los títulos/urls extraídos por regex vienen como fragmentos de un
// string JSON (con \/ , \uXXXX, etc). Envolverlos entre comillas y
// pasarlos por JSON.parse es la forma más segura de desescaparlos.
function safeJsonUnescape(fragment) {
    try {
        return JSON.parse('"' + fragment + '"');
    } catch (e) {
        return fragment;
    }
}

// ------------------------------------------------------------
// Stubs requeridos por la interfaz de plugin
// ------------------------------------------------------------
// OJO: antes esto tiraba throw, y como GrayJay llama a getHome solo
// para armar el feed principal, terminaba mostrando el error repetido
// en la pantalla de inicio. Ahora devuelve una lista vacía en vez de
// romper: si la clase VideoPager no coincide con la real de GrayJay,
// este es el próximo lugar a revisar.
source.getHome = function () {
    return new VideoPager([], false, {});
};
