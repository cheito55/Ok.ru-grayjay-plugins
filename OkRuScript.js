// ============================================================
// Plugin de GrayJay para OK.ru (Odnoklassniki)
// ============================================================
// Reproducción por URL + búsqueda de videos.
//
// La reproducción usa data-options -> flashvars -> metadata,
// con HLS como fuente principal y MP4 como fallback.
// La búsqueda consulta la página de videos de OK.ru y devuelve
// resultados como PlatformVideo para que GrayJay pueda mostrarlos.
// ============================================================

const PLATFORM_NAME = "OK.ru";
const REGEX_VIDEO_URL = /ok.ru/(?:video|videoembed)/(\d+)/i;

let PLUGIN_ID = "";

// ------------------------------------------------------------
// Habilitación
// ------------------------------------------------------------
source.enable = function (conf, settings, savedState) {
PLUGIN_ID = (conf && conf.id) ? conf.id : "";
};

// ------------------------------------------------------------
// Detección de URLs
// ------------------------------------------------------------
source.isContentDetailsUrl = function (url) {
return REGEX_VIDEO_URL.test(url || "");
};

// ------------------------------------------------------------
// Detalle / reproducción del video
// ------------------------------------------------------------
source.getContentDetails = function (url) {
const match = (url || "").match(REGEX_VIDEO_URL);

```
if (!match) {
    throw new ScriptException("URL de OK.ru no reconocida: " + url);
}

const videoId = match[1];
const pageUrl = "https://ok.ru/video/" + videoId;

const resp = http.GET(pageUrl, {
    "Referer": "https://ok.ru/",
    "User-Agent":
        "Mozilla/5.0 (Linux; Android 12) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/120.0 Mobile Safari/537.36"
}, false);

if (!resp.isOk) {
    throw new ScriptException(
        "No se pudo cargar la página de OK.ru (status " +
        resp.code + ")"
    );
}

const html = resp.body || "";

const stubError = html.match(
    /class=["'][^"']*vp_video_stub_txt[^"']*["'][^>]*>([^<]+)</i
);

if (stubError) {
    throw new ScriptException(
        "Video no disponible: " +
        cleanText(unescapeHtml(stubError[1]))
    );
}

const optionsMatch = html.match(/data-options=["']([^"']+)["']/i);

if (!optionsMatch) {
    throw new ScriptException(
        "No se encontró data-options en la página de OK.ru (¿cambió el sitio?)"
    );
}

const optionsJson = unescapeHtml(optionsMatch[1]);
let options;

try {
    options = JSON.parse(optionsJson);
} catch (e) {
    throw new ScriptException(
        "No se pudo parsear data-options: " + e
    );
}

const flashvars = options.flashvars || {};
let metadata;

if (flashvars.metadata) {
    try {
        metadata = typeof flashvars.metadata === "string"
            ? JSON.parse(flashvars.metadata)
            : flashvars.metadata;
    } catch (e) {
        throw new ScriptException(
            "No se pudo parsear flashvars.metadata: " + e
        );
    }
}
else if (flashvars.metadataUrl) {
    let metadataUrl;

    try {
        metadataUrl = decodeURIComponent(flashvars.metadataUrl);
    } catch (_) {
        metadataUrl = flashvars.metadataUrl;
    }

    const metaResp = http.POST(metadataUrl, "", {
        "Referer": pageUrl,
        "User-Agent":
            "Mozilla/5.0 (Linux; Android 12) " +
            "AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/120.0 Mobile Safari/537.36",
        "Content-Type": "application/x-www-form-urlencoded"
    }, false);

    if (!metaResp.isOk) {
        throw new ScriptException(
            "No se pudo obtener metadataUrl (status " +
            metaResp.code + ")"
        );
    }

    try {
        metadata = JSON.parse(metaResp.body);
    } catch (e) {
        throw new ScriptException(
            "metadataUrl devolvió JSON inválido: " + e
        );
    }
}
else {
    throw new ScriptException(
        "No se encontró metadata ni metadataUrl en flashvars"
    );
}

return buildVideoDetails(videoId, pageUrl, metadata);
```

};

// ------------------------------------------------------------
// Detalle reproducible
// ------------------------------------------------------------
function buildVideoDetails(videoId, pageUrl, metadata) {
metadata = metadata || {};

```
const movie = metadata.movie || {};
const author = metadata.author || {};

const hlsUrl =
    metadata.hlsManifestUrl ||
    metadata.hlsMasterPlaylistUrl;

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
        throw new ScriptException(
            "Este video es pago en OK.ru, no se puede reproducir sin comprarlo."
        );
    }

    throw new ScriptException(
        "No se encontró ninguna fuente de video reproducible."
    );
}

return new PlatformVideoDetails({
    id: new PlatformID(
        PLATFORM_NAME,
        videoId,
        PLUGIN_ID
    ),

    name: movie.title || "Video de OK.ru",

    thumbnails: movie.poster
        ? new Thumbnails([
            new Thumbnail(movie.poster, 720)
        ])
        : new Thumbnails([]),

    duration: intOrZero(movie.duration),
    viewCount: 0,
    url: pageUrl,
    isLive: false,

    author: new PlatformAuthorLink(
        new PlatformID(
            PLATFORM_NAME,
            String(author.id || ""),
            PLUGIN_ID
        ),
        author.name || "OK.ru",
        "",
        ""
    ),

    video: new VideoSourceDescriptor(sources)
});
```

}

// ============================================================
// BÚSQUEDA DE VIDEOS EN OK.RU
// ============================================================

source.search = function (
query,
type,
order,
filters,
continuationToken
) {

```
if (!query || query.trim() === "") {
    return new OKSearchPager([], false, {
        query: "",
        type: type,
        order: order,
        filters: filters,
        continuationToken: null
    });
}

query = query.trim();

let pageUrl =
    "https://ok.ru/video/search" +
    "?st.cmd=anonymVideo" +
    "&st.ft=search" +
    "&st.gsq=" + encodeURIComponent(query) +
    "&st.m=SEARCH";

// El parámetro de página se usa como fallback para la
// paginación. La primera búsqueda no lleva st.page.
if (continuationToken) {
    pageUrl +=
        "&st.page=" +
        encodeURIComponent(String(continuationToken));
}

const resp = http.GET(pageUrl, {
    "Referer": "https://ok.ru/",
    "User-Agent":
        "Mozilla/5.0 (Linux; Android 12) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/120.0 Mobile Safari/537.36"
}, false);

if (!resp.isOk) {
    throw new ScriptException(
        "No se pudo realizar la búsqueda en OK.ru. HTTP " +
        resp.code
    );
}

const html = resp.body || "";
const videos = parseSearchResults(html);

// Si OK.ru devuelve menos de 10 resultados, consideramos
// que no hay otra página.
const hasMore = videos.length >= 10;

let nextToken = null;

if (hasMore) {
    const currentPage = continuationToken
        ? parseInt(continuationToken, 10)
        : 1;

    nextToken = isNaN(currentPage)
        ? "2"
        : String(currentPage + 1);
}

return new OKSearchPager(
    videos,
    hasMore,
    {
        query: query,
        type: type,
        order: order,
        filters: filters,
        continuationToken: nextToken
    }
);
```

};

// ------------------------------------------------------------
// Parsear resultados del buscador de OK.ru
// ------------------------------------------------------------
function parseSearchResults(html) {
const results = [];
const seen = {};

```
// Enlaces /video/123456789.
const videoRegex =
    /href=(["'])((?:https?:\\/\\/(?:www\\.)?ok\\.ru)?\\/video\\/(\\d+)(?:[^"']*)?)\1/gi;

let match;

while ((match = videoRegex.exec(html)) !== null) {
    const fullHref = match[2];
    const videoId = match[3];

    if (!videoId || seen[videoId]) {
        continue;
    }

    seen[videoId] = true;

    const videoUrl = fullHref.indexOf("http") === 0
        ? fullHref
        : "https://ok.ru" + fullHref;

    // Tomamos el bloque alrededor de la tarjeta para extraer
    // título, miniatura, duración y autor.
    const start = Math.max(0, match.index - 3000);
    const end = Math.min(html.length, match.index + 5000);
    const block = html.substring(start, end);

    results.push(createSearchVideo(
        videoId,
        videoUrl,
        extractTitleFromBlock(block),
        extractThumbnailFromBlock(block),
        extractDurationFromBlock(block),
        extractViewsFromBlock(block),
        extractAuthorFromBlock(block)
    ));
}

return results;
```

}

// ------------------------------------------------------------
// Crear PlatformVideo
// ------------------------------------------------------------
function createSearchVideo(
videoId,
videoUrl,
title,
thumbnail,
duration,
views,
author
) {
const thumbs = thumbnail
? new Thumbnails([
new Thumbnail(thumbnail, 720)
])
: new Thumbnails([]);

```
const authorId = author && author.id
    ? String(author.id)
    : "";

const authorName = author && author.name
    ? author.name
    : "OK.ru";

return new PlatformVideo({
    id: new PlatformID(
        PLATFORM_NAME,
        String(videoId),
        PLUGIN_ID
    ),

    name: title || "Video de OK.ru",
    thumbnails: thumbs,
    duration: duration || 0,
    viewCount: views || 0,
    url: videoUrl,

    author: new PlatformAuthorLink(
        new PlatformID(
            PLATFORM_NAME,
            authorId,
            PLUGIN_ID
        ),
        authorName,
        authorId
            ? "https://ok.ru/profile/" + authorId
            : "",
        ""
    )
});
```

}

// ------------------------------------------------------------
// Extraer título
// ------------------------------------------------------------
function extractTitleFromBlock(block) {
let m = block.match(
/(?:title|aria-label)=(?:["'])(.*?)(?:["'])/i
);

```
if (m && m[1]) {
    const title = cleanText(unescapeHtml(m[1]));

    if (title && title.length > 2 && title.length < 500) {
        return title;
    }
}

const patterns = [
    /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i,
    /class=["'][^"']*(?:video-card|video-card_title|video_name|title)[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i
];

for (let i = 0; i < patterns.length; i++) {
    m = block.match(patterns[i]);

    if (m && m[1]) {
        const title = cleanText(unescapeHtml(m[1]));

        if (title && title.length > 2 && title.length < 500) {
            return title;
        }
    }
}

return "Video de OK.ru";
```

}

// ------------------------------------------------------------
// Extraer miniatura
// ------------------------------------------------------------
function extractThumbnailFromBlock(block) {
let m = block.match(
/(?:src|data-src|data-original)=(?:["'])(https?://[^"']+.(?:jpg|jpeg|png|webp)[^"']*)(?:["'])/i
);

```
if (m && m[1]) {
    return unescapeHtml(m[1]);
}

m = block.match(
    /(?:src|data-src|data-original)=(?:["'])(https?:\/\/(?:[^"']*mycdn\.me|[^"']*okcdn\.ru)[^"']*)(?:["'])/i
);

if (m && m[1]) {
    return unescapeHtml(m[1]);
}

return "";
```

}

// ------------------------------------------------------------
// Extraer duración
// ------------------------------------------------------------
function extractDurationFromBlock(block) {
const m = block.match(
/\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b/
);

```
if (!m) {
    return 0;
}

const a = parseInt(m[1], 10);
const b = parseInt(m[2], 10);

if (m[3]) {
    return a * 3600 + b * 60 + parseInt(m[3], 10);
}

return a * 60 + b;
```

}

// ------------------------------------------------------------
// Extraer visualizaciones
// ------------------------------------------------------------
function extractViewsFromBlock(block) {
const m = block.match(
/([\d.,\s]+)\s*(?:views|просмотр|visualizaciones|vistas)/i
);

```
if (!m) {
    return 0;
}

const value = m[1]
    .replace(/\s/g, "")
    .replace(/,/g, "")
    .replace(/\./g, "");

const n = parseInt(value, 10);
return isNaN(n) ? 0 : n;
```

}

// ------------------------------------------------------------
// Extraer autor
// ------------------------------------------------------------
function extractAuthorFromBlock(block) {
const result = {
id: "",
name: "OK.ru"
};

```
const profile = block.match(
    /href=(?:["'])https?:\/\/(?:www\.)?ok\.ru\/profile\/(\d+)[^"']*(?:["'])[^>]*>([\s\S]*?)<\/a>/i
);

if (profile) {
    result.id = profile[1];
    result.name = cleanText(unescapeHtml(profile[2])) || "OK.ru";
}

return result;
```

}

// ------------------------------------------------------------
// Pager de búsqueda
// ------------------------------------------------------------
class OKSearchPager extends VideoPager {
constructor(results, hasMore, context) {
super(results, hasMore, context);
}

```
nextPage() {
    return source.search(
        this.context.query,
        this.context.type,
        this.context.order,
        this.context.filters,
        this.context.continuationToken
    );
}
```

}

// ------------------------------------------------------------
// Home vacío
// ------------------------------------------------------------
source.getHome = function (continuationToken) {
return new VideoPager([], false, {
continuationToken: continuationToken || null
});
};

// ------------------------------------------------------------
// Sugerencias
// ------------------------------------------------------------
source.searchSuggestions = function (query) {
if (!query || query.trim() === "") {
return [];
}

```
return [query.trim()];
```

};

// ------------------------------------------------------------
// Capacidades de búsqueda
// ------------------------------------------------------------
source.getSearchCapabilities = function () {
return {
types: [Type.Feed.Mixed],
sorts: [],
filters: []
};
};

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------
function intOrZero(v) {
const n = parseInt(v, 10);
return isNaN(n) ? 0 : n;
}

function cleanText(text) {
return (text || "")
.replace(/<[^>]+>/g, " ")
.replace(/\u002F/g, "/")
.replace(/\u003A/gi, ":")
.replace(/\u0026/gi, "&")
.replace(/\s+/g, " ")
.trim();
}

function unescapeHtml(str) {
return (str || "")
.replace(/"/g, '"')
.replace(/"/g, '"')
.replace(/'/g, "'")
.replace(/'/gi, "'")
.replace(/&/g, "&")
.replace(/</g, "<")
.replace(/>/g, ">");
}
