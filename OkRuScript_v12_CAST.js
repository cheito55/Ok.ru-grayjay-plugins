/*
 * GrayJay - OK.ru Source v12
 *
 * Objetivos:
 *  - Extraccion robusta OK.ru desktop/mobile.
 *  - HLS primero, con varias alternativas reales cuando OK.ru las expone.
 *  - MP4/M4V como fallback real, no como URL inventada.
 *  - Fuentes construidas con la API actual de GrayJay (objetos).
 *  - URLs directas: evita entregar paginas intermedias a Cast.
 *  - Busqueda y sugerencias.
 *  - Parseo tolerante de JSON, data-options, flashvars y metadataUrl.
 *  - Reconocimiento de los campos encontrados en el APK de XuperTv.
 *
 * IMPORTANTE SOBRE XUPER:
 * El APK real contiene los modelos/campos play_params, playlistUrl,
 * verificationToken y signdata. El analisis DEX muestra que son datos de
 * beans de request/result y que /startPlayVOD forma parte del flujo de VOD.
 * No se debe inventar una firma local ni un endpoint privado. Este plugin
 * consume playlistUrl/play_url/media_url cuando OK.ru o los metadatos ya los
 * entregan. El resolver privado no se simula.
 */

const PLATFORM_NAME = "OK.ru";
const PLUGIN_ID = "62af0e2f-bfd9-489f-afe1-f66583d2f7d0";
const REGEX_VIDEO_URL = /(?:https?:\/\/)?(?:www\.|m\.)?ok\.ru\/(?:video|videoembed)\/(\d+)/i;
const SEARCH_URL_BASES = [
    "https://ok.ru/video/search?st.cmd=anonymVideo&st.ft=search&st.gsq=",
    "https://ok.ru/dk?st.cmd=searchResult&st.mode=Movie&st.grmode=Groups&st.query="
];

const MAX_HTML_SIZE = 5000000;
const MAX_JSON_DEPTH = 14;
const MAX_SOURCES = 32;
const MAX_SEARCH = 48;
const MAX_DEBUG = 60;

const UA_DESKTOP =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
const UA_MOBILE =
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/136.0.0.0 Mobile Safari/537.36";

/*
 * Sesion OK.ru local.
 * Sustituye el valor por una cookie propia antes de instalar.
 * No compartas el archivo una vez que hayas puesto la cookie real.
 * La cookie solo se envia a ok.ru; nunca a YouTube.
 */
const EMBEDDED_OK_COOKIE = "REPLACE_WITH_YOUR_OK_RU_COOKIE";

let DEBUG = [];

function safeStr(v) {
    try {
        if (v === null || v === undefined) return "";
        if (typeof v === "string") return v;
        return String(v);
    } catch (_) {
        return "";
    }
}

function safeObj(v) {
    return v !== null && typeof v === "object";
}

function addDebug(v) {
    try {
        let s = safeStr(v);
        if (!s) return;
        if (s.length > 700) s = s.substring(0, 700) + "…";
        if (DEBUG.length >= MAX_DEBUG) DEBUG.shift();
        DEBUG.push(s);
    } catch (_) {}
}

function resetDebug() {
    DEBUG = [];
}

function debugText() {
    return DEBUG.join("\n");
}

function htmlDecode(s) {
    s = safeStr(s);
    return s
        .replace(/&quot;/gi, '"')
        .replace(/&#34;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/gi, "'")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&#x2F;/gi, "/")
        .replace(/&#47;/g, "/")
        .replace(/&#x3D;/gi, "=")
        .replace(/&#61;/g, "=");
}

function cleanText(s) {
    return htmlDecode(safeStr(s).replace(/<[^>]*>/g, " "))
        .replace(/\\n/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function cleanUrl(s) {
    return htmlDecode(safeStr(s))
        .replace(/^\s*["']+|["']+\s*$/g, "")
        .replace(/\\\//g, "/")
        .replace(/\\u002F/gi, "/")
        .replace(/\\u003A/gi, ":")
        .replace(/\\u003D/gi, "=")
        .trim();
}

function normalizeUrl(s, base) {
    s = cleanUrl(s);
    if (!s) return "";
    if (s.indexOf("//") === 0) return "https:" + s;
    if (/^https?:\/\//i.test(s)) return s;
    if (base && s.charAt(0) === "/") {
        let m = safeStr(base).match(/^(https?:\/\/[^/]+)/i);
        if (m) return m[1] + s;
    }
    return s;
}

function isHttpUrl(s) {
    return /^https?:\/\//i.test(cleanUrl(s));
}

function isHlsUrl(s) {
    return /\.m3u8(?:$|[?#])/i.test(cleanUrl(s));
}

function isMp4Url(s) {
    return /\.(?:mp4|m4v|mov|webm)(?:$|[?#])/i.test(cleanUrl(s));
}

function hostOf(url) {
    let m = safeStr(url).match(/^https?:\/\/([^/]+)/i);
    return m ? m[1].toLowerCase() : "";
}

function isExternalProvider(url) {
    let h = hostOf(url);
    return !!h && /(?:youtube(?:-nocookie)?\.com|youtu\.be|vimeo\.com)$/i.test(h);
}


function isYouTubeUrl(url) {
    let s = safeStr(url);
    return /youtube(?:-nocookie)?\.com\/(?:watch|embed|shorts|live|v)\//i.test(s) ||
        /youtu\.be\//i.test(s);
}

function extractVideoId(url) {
    let m = safeStr(url).match(REGEX_VIDEO_URL);
    return m ? m[1] : "";
}

function mergeHeaders(dst, src) {
    dst = dst || {};
    if (!safeObj(src)) return dst;
    try {
        for (let k in src) {
            if (src[k] !== null && src[k] !== undefined) {
                let v = safeStr(src[k]);
                if (v) dst[k] = v;
            }
        }
    } catch (_) {}
    return dst;
}

function httpGet(url, extraHeaders) {
    try {
        let headers = {
            "User-Agent": UA_DESKTOP,
            "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Cache-Control": "no-cache",
            "Pragma": "no-cache"
        };
        mergeHeaders(headers, extraHeaders);

        let r = http.GET(url, headers, false);
        if (!r) return "";

        let body = "";
        try { body = r.body; } catch (_) {}
        if (!body) {
            try { body = r.getBody(); } catch (_) {}
        }
        body = safeStr(body);
        if (body.length > MAX_HTML_SIZE) body = body.substring(0, MAX_HTML_SIZE);
        return body;
    } catch (e) {
        addDebug("GET: " + e);
        return "";
    }
}

function httpGetAuth(url, extraHeaders) {
    /*
     * NO usa la sesion autenticada de GrayJay.
     * La autenticacion, si se configura, es exclusivamente la cookie local.
     */
    try {
        let headers = {
            "User-Agent": UA_DESKTOP,
            "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Cache-Control": "no-cache",
            "Pragma": "no-cache"
        };

        let host = hostOf(url);
        if (EMBEDDED_OK_COOKIE &&
            EMBEDDED_OK_COOKIE.indexOf("REPLACE_WITH_") !== 0 &&
            /(?:^|\.)ok\.ru$/i.test(host)) {
            headers["Cookie"] = EMBEDDED_OK_COOKIE;
        }

        mergeHeaders(headers, extraHeaders);

        let r = http.GET(url, headers, false);
        if (!r) return "";

        let body = "";
        try { body = r.body; } catch (_) {}
        if (!body) { try { body = r.getBody(); } catch (_) {} }

        body = safeStr(body);
        if (body.length > MAX_HTML_SIZE) body = body.substring(0, MAX_HTML_SIZE);
        return body;
    } catch (e) {
        addDebug("OK GET: " + e);
        return "";
    }
}
function loadOkPage(url) {
    let id = extractVideoId(url);
    let urls = [
        url,
        id ? "https://m.ok.ru/video/" + id : "",
        id ? "https://ok.ru/videoembed/" + id : ""
    ];
    let uas = [UA_DESKTOP, UA_MOBILE];
    for (let i = 0; i < urls.length; i++) {
        if (!urls[i]) continue;
        for (let j = 0; j < uas.length; j++) {
            try {
                let body = httpGetAuth(urls[i], { "User-Agent": uas[j] });
                if (body && body.length > 250) {
                    addDebug("page=" + i + ",ua=" + j + ",len=" + body.length);
                    return body;
                }
            } catch (_) {}
        }
    }
    return "";
}

function tryParseJson(value) {
    if (safeObj(value)) return value;
    let s = cleanUrl(value);
    if (!s) return null;

    for (let i = 0; i < 6; i++) {
        try { return JSON.parse(s); } catch (_) {}

        let d = htmlDecode(s);
        if (d !== s) {
            s = d;
            continue;
        }

        if ((s.charAt(0) === '"' && s.charAt(s.length - 1) === '"') ||
            (s.charAt(0) === "'" && s.charAt(s.length - 1) === "'")) {
            s = s.substring(1, s.length - 1);
            continue;
        }

        let u = s
            .replace(/\\"/g, '"')
            .replace(/\\'/g, "'")
            .replace(/\\\\/g, "\\");
        if (u !== s) {
            s = u;
            continue;
        }
        break;
    }
    return null;
}

function extractDataOptions(html) {
    let out = [];
    let re = /data-options\s*=\s*["']([\s\S]*?)["']/gi;
    let m;
    while ((m = re.exec(html)) !== null && out.length < 20) {
        let o = tryParseJson(m[1]);
        if (o) out.push(o);
    }
    return out;
}

function looksLikeVideoObject(o) {
    if (!safeObj(o)) return false;
    let keys = [
        "hls", "hlsUrl", "hlsManifestUrl", "hlsMasterPlaylistUrl",
        "playlistUrl", "manifestUrl", "videoUrl", "video_url",
        "play_url", "media_url", "source_url", "file", "url",
        "play_params", "playParams", "verificationToken", "signdata"
    ];
    for (let i = 0; i < keys.length; i++) {
        try {
            if (o[keys[i]] !== undefined && o[keys[i]] !== null) return true;
        } catch (_) {}
    }
    return false;
}

function findMetadataInObject(root, depth) {
    if (!safeObj(root) || depth > MAX_JSON_DEPTH) return null;
    if (looksLikeVideoObject(root)) return root;

    if (Array.isArray(root)) {
        for (let i = 0; i < root.length; i++) {
            let found = findMetadataInObject(root[i], depth + 1);
            if (found) return found;
        }
        return null;
    }

    try {
        let preferred = ["video", "movie", "player", "flashvars", "data", "result", "response", "media", "content"];
        for (let i = 0; i < preferred.length; i++) {
            if (root[preferred[i]] !== undefined) {
                let found = findMetadataInObject(root[preferred[i]], depth + 1);
                if (found) return found;
            }
        }

        for (let k in root) {
            let v = root[k];
            if (safeObj(v)) {
                let found = findMetadataInObject(v, depth + 1);
                if (found) return found;
            } else if (typeof v === "string") {
                let parsed = tryParseJson(v);
                if (parsed) {
                    let found2 = findMetadataInObject(parsed, depth + 1);
                    if (found2) return found2;
                }
            }
        }
    } catch (_) {}
    return null;
}

function extractJsonObjectsFromHtml(html) {
    let out = [];
    let patterns = [
        /<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi,
        /<script[^>]*>([\s\S]*?\{[\s\S]*?\}[\s\S]*?)<\/script>/gi
    ];

    for (let p = 0; p < patterns.length; p++) {
        let re = patterns[p], m;
        while ((m = re.exec(html)) !== null && out.length < 40) {
            let o = tryParseJson(m[1]);
            if (o) out.push(o);
        }
    }
    return out;
}

function extractMetadataFromHtml(html) {
    let dataOptions = extractDataOptions(html);
    for (let i = 0; i < dataOptions.length; i++) {
        let found = findMetadataInObject(dataOptions[i], 0);
        if (found) return found;
    }

    let jsons = extractJsonObjectsFromHtml(html);
    for (let i = 0; i < jsons.length; i++) {
        let found2 = findMetadataInObject(jsons[i], 0);
        if (found2) return found2;
    }

    // OK.ru changes its markup frequently. A media-bearing object is useful,
    // but a page-wide URL scan below is the final playback fallback.
    let attrs = ["flashvars", "data-player", "data-options", "data-video", "data-json"];
    for (let i = 0; i < attrs.length; i++) {
        let re = new RegExp(attrs[i] + "\\s*=\\s*(?:\"([\\s\\S]*?)\"|\'([\\s\\S]*?)\')", "i");
        let m = html.match(re);
        if (m) {
            let o = tryParseJson(m[1] || m[2]);
            if (o) return findMetadataInObject(o, 0) || o;
        }
    }
    return {};
}

function collectMediaFromHtml(html, baseUrl) {
    let result = { hls: [], mp4: [] };
    scanStringForUrls(html, result.hls, result.mp4, baseUrl);

    // Also catch escaped/encoded URLs whose extension is split by markup.
    let normalized = htmlDecode(safeStr(html))
        .replace(/\\\//g, "/")
        .replace(/\\u002f/gi, "/")
        .replace(/\\u003a/gi, ":")
        .replace(/\\u003d/gi, "=");
    scanStringForUrls(normalized, result.hls, result.mp4, baseUrl);
    return result;
}

function fetchMetadataUrl(meta, baseUrl) {
    if (!safeObj(meta)) return null;

    let keys = [
        "metadataUrl", "metadata_url", "metaUrl", "metadataURL",
        "playerMetadataUrl", "videoMetadataUrl"
    ];

    let urls = [];
    for (let i = 0; i < keys.length; i++) {
        try {
            if (meta[keys[i]]) urls.push(normalizeUrl(meta[keys[i]], baseUrl));
        } catch (_) {}
    }

    for (let i = 0; i < urls.length; i++) {
        if (!isHttpUrl(urls[i])) continue;
        let body = httpGetAuth(urls[i]);
        if (!body) body = httpGet(urls[i]);
        let o = tryParseJson(body);
        if (o) return findMetadataInObject(o, 0) || o;
    }
    return null;
}

function parseMetadata(html, pageUrl) {
    let meta = extractMetadataFromHtml(html);
    if (!meta) return null;
    let remote = fetchMetadataUrl(meta, pageUrl);
    return remote || meta;
}

function pushUnique(arr, url, base) {
    url = normalizeUrl(url, base);
    if (!isHttpUrl(url)) return;
    if (arr.indexOf(url) >= 0) return;
    if (arr.length >= MAX_SOURCES) return;
    arr.push(url);
}

function scanStringForUrls(s, hls, mp4, base) {
    s = safeStr(s);
    if (!s) return;

    let d = cleanUrl(s);
    let abs = /https?:\/\/[^\s"'<>\\]+/gi;
    let m;
    while ((m = abs.exec(d)) !== null) {
        let u = cleanUrl(m[0]);
        if (isHlsUrl(u)) pushUnique(hls, u, base);
        else if (isMp4Url(u)) pushUnique(mp4, u, base);
    }

    let proto = /\/\/[^\s"'<>\\]+/g;
    while ((m = proto.exec(d)) !== null) {
        let u2 = "https:" + cleanUrl(m[0]);
        if (isHlsUrl(u2)) pushUnique(hls, u2, base);
        else if (isMp4Url(u2)) pushUnique(mp4, u2, base);
    }

    if (isHlsUrl(d)) pushUnique(hls, d, base);
    if (isMp4Url(d)) pushUnique(mp4, d, base);
}

function collectMedia(meta, baseUrl) {
    let result = { hls: [], mp4: [] };

    function walk(obj, depth) {
        if (depth > MAX_JSON_DEPTH || result.hls.length + result.mp4.length >= MAX_SOURCES) return;

        if (typeof obj === "string") {
            scanStringForUrls(obj, result.hls, result.mp4, baseUrl);
            let parsed = tryParseJson(obj);
            if (parsed) walk(parsed, depth + 1);
            return;
        }
        if (!safeObj(obj)) return;

        if (Array.isArray(obj)) {
            for (let i = 0; i < obj.length; i++) walk(obj[i], depth + 1);
            return;
        }

        try {
            for (let k in obj) {
                let v = obj[k];
                let key = safeStr(k).toLowerCase();

                if (typeof v === "string") {
                    if (/hls|m3u8|playlist|manifest|stream|source|video|media|file|url|play_url|media_url/.test(key)) {
                        scanStringForUrls(v, result.hls, result.mp4, baseUrl);
                    } else if (isHlsUrl(v) || isMp4Url(v)) {
                        scanStringForUrls(v, result.hls, result.mp4, baseUrl);
                    }
                } else if (safeObj(v)) {
                    walk(v, depth + 1);
                }

                if (result.hls.length + result.mp4.length >= MAX_SOURCES) break;
            }
        } catch (_) {}
    }

    walk(meta, 0);
    return result;
}

function firstValue(obj, keys) {
    if (!safeObj(obj)) return "";
    for (let i = 0; i < keys.length; i++) {
        try {
            let v = obj[keys[i]];
            if (v !== undefined && v !== null) {
                let s = safeStr(v);
                if (s) return s;
            }
        } catch (_) {}
    }
    return "";
}

function recursiveValue(root, keys, depth) {
    if (!safeObj(root) || depth > MAX_JSON_DEPTH) return "";
    let direct = firstValue(root, keys);
    if (direct) return direct;

    if (Array.isArray(root)) {
        for (let i = 0; i < root.length; i++) {
            let v = recursiveValue(root[i], keys, depth + 1);
            if (v) return v;
        }
        return "";
    }

    try {
        for (let k in root) {
            let v = root[k];
            if (safeObj(v)) {
                let found = recursiveValue(v, keys, depth + 1);
                if (found) return found;
            }
        }
    } catch (_) {}
    return "";
}

function getTitle(meta, fallback) {
    return cleanText(firstValue(meta, [
        "title", "name", "movieTitle", "videoTitle", "caption", "contentTitle"
    ])) || cleanText(fallback) || "OK.ru video";
}

function getDescription(meta) {
    return cleanText(firstValue(meta, ["description", "desc", "text", "summary"]));
}

function getPoster(meta, baseUrl) {
    return normalizeUrl(firstValue(meta, [
        "poster", "posterUrl", "thumbnail", "thumbnailUrl", "cover", "coverUrl",
        "image", "imageUrl", "preview", "previewUrl", "__ok_poster"
    ]), baseUrl);
}

function getDuration(meta) {
    let v = firstValue(meta, [
        "duration", "durationMs", "durationSec", "length", "videoDuration", "mediaDuration"
    ]);
    let n = parseFloat(v);
    if (!isFinite(n) || n <= 0) return 0;
    if (n > 1000) n = n / 1000;
    return Math.round(n);
}

function getAuthorName(meta) {
    return cleanText(firstValue(meta, [
        "authorName", "author", "ownerName", "uploader", "userName", "username", "owner"
    ]));
}


/* -------------------- External embeds -------------------- */

function extractYouTubeIdFromString(value) {
    let s = cleanUrl(value)
        .replace(/\\\//g, "/")
        .replace(/&amp;/gi, "&");
    let patterns = [
        /(?:youtube(?:-nocookie)?\.com\/embed\/)([A-Za-z0-9_-]{6,20})/i,
        /(?:youtube(?:-nocookie)?\.com\/watch\?(?:[^#\s"']*?&)?v=)([A-Za-z0-9_-]{6,20})/i,
        /(?:youtu\.be\/)([A-Za-z0-9_-]{6,20})/i,
        /(?:youtube\.com\/shorts\/)([A-Za-z0-9_-]{6,20})/i,
        /(?:youtube\.com\/live\/)([A-Za-z0-9_-]{6,20})/i,
        /(?:youtube(?:-nocookie)?\.com\/v\/)([A-Za-z0-9_-]{6,20})/i
    ];
    for (let i = 0; i < patterns.length; i++) {
        let m = s.match(patterns[i]);
        if (m) return m[1];
    }
    return "";
}

function findYouTubeEmbed(html) {
    let s = safeStr(html)
        .replace(/\\u002F/gi, "/")
        .replace(/\\\//g, "/")
        .replace(/&amp;/gi, "&");

    let patterns = [
        /<iframe[^>]+(?:src|data-src)\s*=\s*["']([^"']+)["'][^>]*>/gi,
        /(?:youtube(?:-nocookie)?\.com|youtu\.be)[^\s"'<>]+/gi,
        /(?:playerResponse|videoData|externalVideo|embedUrl)[^\n]{0,1000}/gi
    ];

    for (let p = 0; p < patterns.length; p++) {
        let re = patterns[p], m;
        while ((m = re.exec(s)) !== null) {
            let candidate = m[1] || m[0] || "";
            let id = extractYouTubeIdFromString(candidate);
            if (id) {
                return {
                    id: id,
                    url: "https://www.youtube.com/watch?v=" + id,
                    embedUrl: "https://www.youtube.com/embed/" + id
                };
            }
        }
    }
    return null;
}


function extractJsonObjectAfterMarker(text, marker) {
    let s = safeStr(text);
    let pos = s.indexOf(marker);
    if (pos < 0) return null;
    let start = s.indexOf("{", pos + marker.length);
    if (start < 0) return null;
    let depth = 0, quote = false, esc = false;
    for (let i = start; i < s.length && i < start + 3000000; i++) {
        let c = s.charAt(i);
        if (quote) {
            if (esc) esc = false;
            else if (c === "\\") esc = true;
            else if (c === '"') quote = false;
            continue;
        }
        if (c === '"') { quote = true; continue; }
        if (c === "{") depth++;
        else if (c === "}") {
            depth--;
            if (depth === 0) {
                try { return JSON.parse(s.substring(start, i + 1)); } catch (_) { return null; }
            }
        }
    }
    return null;
}

function collectYouTubeDirectMedia(videoId) {
    let out = { hls: [], mp4: [] };
    if (!videoId) return out;
    try {
        let url = "https://www.youtube.com/watch?v=" + encodeURIComponent(videoId);
        let html = httpGet(url);
        if (!html) return out;

        let pr = extractJsonObjectAfterMarker(html, "ytInitialPlayerResponse =");
        if (!pr) pr = extractJsonObjectAfterMarker(html, "var ytInitialPlayerResponse =");
        if (!pr) return out;

        let sd = pr.streamingData || {};
        if (isHttpUrl(sd.hlsManifestUrl)) pushUnique(out.hls, sd.hlsManifestUrl, url);

        let lists = [];
        if (Array.isArray(sd.formats)) lists = lists.concat(sd.formats);
        if (Array.isArray(sd.adaptiveFormats)) lists = lists.concat(sd.adaptiveFormats);

        for (let i = 0; i < lists.length && out.mp4.length < 24; i++) {
            let f = lists[i] || {};
            // Only use URLs already resolved by YouTube. Do not attempt to
            // invent/decode signature ciphers here; the official YT plugin
            // has its own cipher/UMP implementation.
            if (!isHttpUrl(f.url)) continue;
            let mime = safeStr(f.mimeType).toLowerCase();
            if (mime.indexOf("video/") < 0) continue;
            out.mp4.push(f.url);
        }
        addDebug("youtube direct hls=" + out.hls.length + " mp4=" + out.mp4.length);
    } catch (e) {
        addDebug("youtube resolver=" + e);
    }
    return out;
}


function collectYouTubePlayerApiMedia(videoId) {
    let out = { hls: [], mp4: [] };
    if (!videoId) return out;

    let endpoint = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";
    let clients = [
        {
            name: "ANDROID",
            version: "19.44.38",
            ua: UA_MOBILE,
            body: {
                context: { client: { clientName: "ANDROID", clientVersion: "19.44.38", androidSdkVersion: 34, hl: "en", gl: "US" } },
                videoId: videoId, contentCheckOk: true, racyCheckOk: true
            }
        },
        {
            name: "WEB",
            version: "2.20260901.01.00",
            ua: UA_DESKTOP,
            body: {
                context: { client: { clientName: "WEB", clientVersion: "2.20260901.01.00", hl: "en", gl: "US" } },
                videoId: videoId, contentCheckOk: true, racyCheckOk: true
            }
        }
    ];

    for (let i = 0; i < clients.length; i++) {
        try {
            let c = clients[i];
            let headers = {
                "User-Agent": c.ua,
                "Content-Type": "application/json",
                "Accept": "application/json",
                "Origin": "https://www.youtube.com",
                "Referer": "https://www.youtube.com/watch?v=" + videoId
            };

            // Igual que el plugin oficial: la peticion puede usar la sesion
            // de GrayJay sin copiar cookies privadas al plugin.
            let r = http.POST(endpoint, JSON.stringify(c.body), headers, false);
            if (!r) continue;

            let body = "";
            try { body = r.body; } catch (_) {}
            if (!body) { try { body = r.getBody(); } catch (_) {} }
            body = safeStr(body);
            if (!body) continue;

            let data = null;
            try { data = JSON.parse(body); } catch (_) { continue; }
            let sd = data && data.streamingData ? data.streamingData : {};

            if (isHttpUrl(sd.hlsManifestUrl))
                pushUnique(out.hls, sd.hlsManifestUrl, "https://www.youtube.com/watch?v=" + videoId);

            // Primero formatos progresivos: son los mas seguros para
            // VideoUrlSource/Cast porque ya contienen audio+video.
            if (Array.isArray(sd.formats)) {
                for (let j = 0; j < sd.formats.length && out.mp4.length < MAX_SOURCES; j++) {
                    let f = sd.formats[j] || {};
                    let mime = safeStr(f.mimeType).toLowerCase();
                    if (mime.indexOf("video/mp4") !== 0) continue;
                    if (!isHttpUrl(f.url)) continue;
                    pushUnique(out.mp4, f.url, "https://www.youtube.com/watch?v=" + videoId);
                }
            }

            // adaptiveFormats solo se usa si no hay ningun progresivo. No
            // aceptamos cipher/signatureCipher sin resolver.
            if (out.mp4.length === 0 && Array.isArray(sd.adaptiveFormats)) {
                for (let j = 0; j < sd.adaptiveFormats.length && out.mp4.length < MAX_SOURCES; j++) {
                    let f = sd.adaptiveFormats[j] || {};
                    let mime = safeStr(f.mimeType).toLowerCase();
                    if (mime.indexOf("video/mp4") !== 0) continue;
                    if (!isHttpUrl(f.url)) continue;
                    pushUnique(out.mp4, f.url, "https://www.youtube.com/watch?v=" + videoId);
                }
            }

            addDebug("youtube player[" + c.name + "] hls=" + out.hls.length + " mp4=" + out.mp4.length);
            if (out.hls.length || out.mp4.length) break;
        } catch (e) {
            addDebug("youtube player api=" + e);
        }
    }

    return out;
}

function mergeMediaLists(dst, src, baseUrl) {
    if (!dst || !src) return;
    let h = Array.isArray(src.hls) ? src.hls : [];
    let m = Array.isArray(src.mp4) ? src.mp4 : [];

    for (let i = 0; i < h.length; i++) {
        pushUnique(dst.hls, h[i], baseUrl);
    }
    for (let i = 0; i < m.length; i++) {
        pushUnique(dst.mp4, m[i], baseUrl);
    }
}

function makeEmptyDescriptor() {
    try { return new MuxVideoSourceDescriptor({ isUnMuxed: false, videoSources: [] }); } catch (_) {}
    try { return new VideoSourceDescriptor([]); } catch (_) {}
    return null;
}

/* -------------------- Comment extraction -------------------- */

function parseCommentDate(value) {
    if (value === null || value === undefined || value === "") return 0;
    let s = safeStr(value).trim();
    let n = Number(s);
    if (isFinite(n) && n > 0) {
        if (n > 100000000000) n = n / 1000;
        return Math.round(n);
    }
    let t = Date.parse(s);
    return isNaN(t) ? 0 : Math.round(t / 1000);
}

function findCommentMessage(obj) {
    return cleanText(firstValue(obj, [
        "message", "text", "body", "content", "commentText", "comment_text",
        "msg", "textHtml", "text_html"
    ]));
}

function findCommentAuthor(obj) {
    if (!safeObj(obj)) return { name: "", id: "0", url: "", thumbnail: "" };
    let author = obj.author || obj.user || obj.profile || obj.owner || obj.userInfo || obj.authorInfo;
    if (!safeObj(author)) author = obj;
    return {
        name: cleanText(firstValue(author, ["name", "displayName", "fullName", "userName", "username", "nickName"])),
        id: safeStr(firstValue(author, ["id", "userId", "uid", "user_id", "profileId"])),
        url: normalizeUrl(firstValue(author, ["url", "profileUrl", "link"]), "https://ok.ru/"),
        thumbnail: normalizeUrl(firstValue(author, ["avatar", "avatarUrl", "photo", "photoUrl", "thumbnail"]), "https://ok.ru/")
    };
}

function isCommentObject(obj) {
    if (!safeObj(obj) || Array.isArray(obj)) return false;
    let msg = findCommentMessage(obj);
    if (!msg) return false;
    let hasCommentKey = false;
    try {
        for (let k in obj) {
            if (/comment|message|reply/i.test(k)) { hasCommentKey = true; break; }
        }
    } catch (_) {}
    return hasCommentKey || !!obj.author || !!obj.user || !!obj.commentId || !!obj.comment_id;
}

function collectCommentObjects(root, out, depth) {
    if (!safeObj(root) || depth > MAX_JSON_DEPTH || out.length >= 200) return;
    if (Array.isArray(root)) {
        for (let i = 0; i < root.length && out.length < 200; i++) {
            collectCommentObjects(root[i], out, depth + 1);
        }
        return;
    }
    if (isCommentObject(root)) out.push(root);
    try {
        for (let k in root) {
            let v = root[k];
            if (safeObj(v)) collectCommentObjects(v, out, depth + 1);
            else if (typeof v === "string" && v.length > 20) {
                let parsed = tryParseJson(v);
                if (parsed) collectCommentObjects(parsed, out, depth + 1);
            }
            if (out.length >= 200) break;
        }
    } catch (_) {}
}

function extractCommentsFromHtml(html, videoUrl) {
    let objects = [];
    let jsons = extractJsonObjectsFromHtml(html);
    for (let i = 0; i < jsons.length; i++) collectCommentObjects(jsons[i], objects, 0);

    // Also inspect data-* attributes commonly used by OK's comment widgets.
    let attrRe = /(?:data-comment|data-comment-data|data-comments|data-options|data-json)\s*=\s*["']([\s\S]*?)["']/gi;
    let am;
    while ((am = attrRe.exec(html)) !== null && objects.length < 200) {
        let parsed = tryParseJson(am[1]);
        if (parsed) collectCommentObjects(parsed, objects, 0);
    }

    // Server-rendered comment DOM fallback.
    try {
        let doc = new DOMParser().parseFromString(html, "text/html");
        let nodes = doc.querySelectorAll(
            "[data-comment-id], .comment, .comments-item, .comments__item, .ucard-comment, [class*='comment']"
        );
        for (let i = 0; i < nodes.length && objects.length < 200; i++) {
            let node = nodes[i];
            let text = cleanText(node.textContent || node.innerText || "");
            if (!text || text.length > 4000) continue;
            let id = "";
            try { id = node.getAttribute("data-comment-id") || node.getAttribute("data-id") || ""; } catch (_) {}
            objects.push({ commentId: id, message: text });
        }
    } catch (e) {
        addDebug("comment DOM=" + e);
    }

    let out = [];
    let seen = {};
    for (let i = 0; i < objects.length; i++) {
        let o = objects[i];
        let message = findCommentMessage(o);
        if (!message) continue;
        let a = findCommentAuthor(o);
        let cid = safeStr(firstValue(o, ["commentId", "comment_id", "id"])) || ("c" + i);
        let key = cid + "|" + message.substring(0, 120);
        if (seen[key]) continue;
        seen[key] = true;

        let author = null;
        try {
            author = new PlatformAuthorLink(
                new PlatformID(PLATFORM_NAME, a.id || "0", PLUGIN_ID),
                a.name || "OK.ru user",
                a.url || "https://ok.ru/",
                a.thumbnail || "",
                0
            );
        } catch (_) {}

        let replies = Number(firstValue(o, ["replyCount", "repliesCount", "reply_count", "replies"]));
        if (!isFinite(replies) || replies < 0) replies = 0;

        let context = {
            videoUrl: videoUrl,
            commentId: cid,
            raw: o
        };

        try {
            out.push(new Comment({
                contextUrl: videoUrl,
                author: author,
                message: message,
                rating: new RatingLikes(0),
                date: parseCommentDate(firstValue(o, ["date", "timestamp", "createdAt", "created_at", "time"])),
                replyCount: Math.round(replies),
                context: context
            }));
        } catch (_) {}
    }
    return out;
}

function makeCommentPager(results, hasMore, context) {
    try { return new CommentPager(results, hasMore, context); }
    catch (_) { return { results: results, hasMore: hasMore, context: context }; }
}

function discoverCommentUrls(html, videoId) {
    let out = [];
    let s = safeStr(html).replace(/\\\//g, "/").replace(/&amp;/gi, "&");
    let re = /https?:\/\/[^\s"'<>\\]+/gi;
    let m;
    while ((m = re.exec(s)) !== null && out.length < 12) {
        let u = cleanUrl(m[0]);
        if (!isHttpUrl(u)) continue;
        if (/ok\.ru/i.test(hostOf(u)) && /comment|comments|discussion|discussions|widget/i.test(u)) {
            if (out.indexOf(u) < 0) out.push(u);
        }
    }
    let rel = /(?:href|src|data-url|data-endpoint)\s*=\s*["']([^"']*(?:comment|discussion|widget)[^"']*)["']/gi;
    while ((m = rel.exec(s)) !== null && out.length < 12) {
        let u2 = normalizeUrl(m[1], "https://ok.ru/video/" + videoId);
        if (isHttpUrl(u2) && out.indexOf(u2) < 0) out.push(u2);
    }
    return out;
}

function extractCommentsFromBodies(bodies, videoUrl) {
    let all = [];
    for (let i = 0; i < bodies.length; i++) {
        let body = bodies[i];
        if (!body) continue;
        let parsed = tryParseJson(body);
        if (parsed) {
            let objects = [];
            collectCommentObjects(parsed, objects, 0);
            all = all.concat(objects);
        }
        all = all.concat(extractCommentsFromHtml(body, videoUrl));
        if (all.length >= 200) break;
    }
    return all;
}

function getCommentsOk(url, continuationToken) {
    let id = extractVideoId(url);
    if (!id) return makeCommentPager([], false, { url: url, offset: 0 });

    let canonical = "https://ok.ru/video/" + id;
    let html = loadOkPage(canonical);
    if (!html) return makeCommentPager([], false, { url: url, offset: 0 });

    let all = extractCommentsFromHtml(html, canonical);

    // OK.ru may lazy-load comments after the initial page. When the page
    // exposes a comment/discussion/widget URL, fetch those endpoints with
    // the same authenticated HTTP client. No cookie values are read or logged.
    if (all.length === 0) {
        let endpoints = discoverCommentUrls(html, id);
        let bodies = [];
        for (let i = 0; i < endpoints.length && bodies.length < 6; i++) {
            let body = httpGetAuth(endpoints[i], {
                "Referer": canonical,
                "Accept": "application/json,text/html,*/*;q=0.8"
            });
            if (body) bodies.push(body);
        }
        if (bodies.length) all = extractCommentsFromBodies(bodies, canonical);
    }

    let offset = 0;
    try {
        if (continuationToken && typeof continuationToken === "object") offset = Number(continuationToken.offset) || 0;
        else if (continuationToken) offset = Number(continuationToken) || 0;
    } catch (_) {}

    let pageSize = 20;
    let page = all.slice(offset, offset + pageSize);
    let next = offset + page.length;
    let hasMore = next < all.length;
    return makeCommentPager(page, hasMore, { url: url, offset: next });
}

/* -------------------- Xuper APK findings -------------------- */

function xuperGetPlayParams(meta) {
    return recursiveValue(meta, ["play_params", "playParams"], 0);
}

function xuperGetVerificationToken(meta) {
    return recursiveValue(meta, ["verificationToken", "verification_token"], 0);
}

function xuperGetPlaylistUrl(meta) {
    return recursiveValue(meta, ["playlistUrl", "playlist_url"], 0);
}

function xuperGetSigndata(meta) {
    return recursiveValue(meta, ["signdata", "signature", "sign"], 0);
}

function xuperDirectPlaylist(meta, baseUrl) {
    let candidates = [
        xuperGetPlaylistUrl(meta),
        recursiveValue(meta, ["play_url", "playUrl", "media_url", "mediaUrl", "source_url", "sourceUrl"], 0)
    ];

    for (let i = 0; i < candidates.length; i++) {
        let u = normalizeUrl(candidates[i], baseUrl);
        if (isHlsUrl(u)) return u;
    }
    return "";
}

/*
 * No se implementa un firmador Xuper inventado.
 * Si el sitio entrega playlistUrl, se usa. Si no, se utiliza el flujo normal
 * de OK.ru. Esto evita fabricar tokens que produzcan URLs invalidas y evita
 * enviar a Cast una URL de pagina intermedia.
 */

function makeHlsSource(url, duration) {
    try {
        return new HLSSource({
            name: "OK.ru HLS",
            duration: duration || 0,
            url: url
        });
    } catch (_) {
        return null;
    }
}

function makeMp4Source(url, duration, index) {
    try {
        return new VideoUrlSource({
            width: 0,
            height: 0,
            container: /\.m4v(?:$|[?#])/i.test(url) ? "m4v" :
                /\.webm(?:$|[?#])/i.test(url) ? "webm" : "mp4",
            codec: "",
            name: "OK.ru MP4 " + (index + 1),
            bitrate: 0,
            duration: duration || 0,
            url: url
        });
    } catch (_) {
        return null;
    }
}

function makeDescriptor(sources) {
    try {
        return new MuxVideoSourceDescriptor({
            isUnMuxed: false,
            videoSources: sources
        });
    } catch (_) {}

    // Compatibilidad con algunas versiones antiguas del runtime.
    try {
        return new VideoSourceDescriptor(sources);
    } catch (_) {}

    return null;
}

function extractPosterFromHtml(html, baseUrl) {
    let s = safeStr(html);
    let patterns = [
        /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
        /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
        /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
        /<img[^>]+(?:data-src|data-lazy-src|src)=["']([^"']+)["'][^>]*>/i
    ];

    for (let i = 0; i < patterns.length; i++) {
        let m = s.match(patterns[i]);
        if (m && m[1]) {
            let u = normalizeUrl(m[1], baseUrl);
            if (isHttpUrl(u)) return u;
        }
    }
    return "";
}

function makeThumbnailList(poster) {
    let out = [];
    if (!isHttpUrl(poster)) return out;
    try { out.push(new Thumbnail(poster, 0)); } catch (_) {}
    return out;
}

function makeAuthor(name, id) {
    if (!name) return null;
    try {
        return new PlatformAuthorLink(
            new PlatformID(PLATFORM_NAME, id || "0", PLUGIN_ID),
            name,
            "https://ok.ru/",
            "",
            0
        );
    } catch (_) {}
    return null;
}

function buildDetails(meta, pageUrl, videoId) {
    let title = getTitle(meta, "OK.ru video " + videoId);
    let description = getDescription(meta);
    let poster = getPoster(meta, pageUrl);
    let duration = getDuration(meta);
    let authorName = getAuthorName(meta);

    let media = { hls: [], mp4: [] };
    if (Array.isArray(meta.__ok_hls)) media.hls = meta.__ok_hls.slice(0);
    if (Array.isArray(meta.__ok_mp4)) media.mp4 = meta.__ok_mp4.slice(0);
    if (media.hls.length === 0 && media.mp4.length === 0) media = collectMedia(meta, pageUrl);
    let xuper = xuperDirectPlaylist(meta, pageUrl);
    if (xuper && media.hls.indexOf(xuper) < 0) media.hls.unshift(xuper);

    addDebug("media hls=" + media.hls.length + " mp4=" + media.mp4.length);
    addDebug("xuper play_params=" + (xuperGetPlayParams(meta) ? "yes" : "no") +
        " verificationToken=" + (xuperGetVerificationToken(meta) ? "yes" : "no") +
        " playlistUrl=" + (xuperGetPlaylistUrl(meta) ? "yes" : "no") +
        " signdata=" + (xuperGetSigndata(meta) ? "yes" : "no"));

    let sources = [];

    // 1) HLS: primero y sin RequestModifier. La URL directa es mucho mas
    // compatible con FCast/Chromecast que una fuente que dependa de headers
    // del plugin que el receptor puede no conocer.
    for (let i = 0; i < media.hls.length && sources.length < MAX_SOURCES; i++) {
        let hls = makeHlsSource(media.hls[i], duration);
        if (hls) sources.push(hls);
    }

    // 2) MP4: se conserva como fallback real incluso cuando existe HLS.
    // Esto permite que SourceAuto tenga una alternativa si el receptor/player
    // no acepta una variante HLS concreta.
    for (let j = 0; j < media.mp4.length && sources.length < MAX_SOURCES; j++) {
        let mp4 = makeMp4Source(media.mp4[j], duration, j);
        if (mp4) sources.push(mp4);
    }

    if (sources.length === 0) {
        throw new Error("No playable direct HLS/MP4 source found\n" + debugText());
    }

    let thumbs = makeThumbnailList(poster);
    let author = makeAuthor(authorName, videoId);
    let descriptor = makeDescriptor(sources);
    if (!descriptor) throw new Error("GrayJay VideoSourceDescriptor unavailable");

    let firstHls = null;
    if (media.hls.length > 0) firstHls = makeHlsSource(media.hls[0], duration);

    let obj = {
        id: new PlatformID(PLATFORM_NAME, videoId, PLUGIN_ID),
        name: title,
        thumbnails: new Thumbnails(thumbs),
        author: author,
        uploadDate: 0,
        url: pageUrl,
        duration: duration,
        viewCount: 0,
        isLive: false,
        description: description,
        video: descriptor,
        dash: null,
        hls: firstHls,
        live: []
    };

    try {
        return new PlatformVideoDetails(obj);
    } catch (e) {
        // Fallback minimo para runtimes que no aceptan campos opcionales null.
        let minimal = {
            id: obj.id,
            name: obj.name,
            thumbnails: obj.thumbnails,
            author: obj.author,
            uploadDate: 0,
            url: obj.url,
            duration: obj.duration,
            viewCount: 0,
            isLive: false,
            description: obj.description,
            video: obj.video,
            live: []
        };
        return new PlatformVideoDetails(minimal);
    }
}

/* -------------------- Search -------------------- */

function parseDurationText(s) {
    s = cleanText(s);
    let p = s.split(":");
    if (p.length === 2) return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0);
    if (p.length === 3) return (parseInt(p[0], 10) || 0) * 3600 +
        (parseInt(p[1], 10) || 0) * 60 + (parseInt(p[2], 10) || 0);
    return 0;
}

function extractSearchResults(html) {
    let results = [];
    let seen = {};
    html = safeStr(html);

    /*
     * OK.ru changed the anonymous video-search markup. The old parser
     * depended on data-movie-id, which is no longer present on the current
     * /video/search page. Current pages expose normal /video/<id> links.
     */
    let anchorRe = /<a\b([^>]*?href\s*=\s*["'](?:https?:\/\/[^"']+)?(?:\/)?video\/(\d+)(?:[?#][^"']*)?["'][^>]*)>([\s\S]*?)<\/a>/gi;
    let m;

    while ((m = anchorRe.exec(html)) !== null && results.length < MAX_SEARCH) {
        let id = m[2];
        if (!id || seen[id]) continue;

        let title = cleanText(m[3] || "");
        title = title.replace(/\s+/g, " ").trim();

        /* Ignore navigation/player links without a useful title. */
        if (!title || title.length < 2) continue;
        if (/^(image|video|more|next|previous|menu)$/i.test(title)) continue;

        let blockStart = Math.max(0, m.index - 1200);
        let blockEnd = Math.min(html.length, anchorRe.lastIndex + 1800);
        let block = html.substring(blockStart, blockEnd);

        let poster = "";
        let pm = block.match(/(?:poster|thumbnail|data-poster|og:image)[^>:=]{0,80}[=:]\s*["']([^"']+)["']/i);
        if (pm) poster = normalizeUrl(pm[1]);

        /* Look for an image URL in the same result block. */
        if (!poster) {
            let im = block.match(/<img[^>]+(?:src|data-src|data-lazy-src)\s*=\s*["']([^"']+)["']/i);
            if (im) poster = normalizeUrl(im[1]);
        }

        let duration = 0;
        let dm = block.match(/(?:duration|movie-duration|video-duration)[^>]*>[\s\S]{0,80}?([0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?)/i);
        if (dm) duration = parseDurationText(dm[1]);

        seen[id] = true;
        results.push({
            id: id,
            url: "https://ok.ru/video/" + id,
            title: title,
            thumbnail: poster,
            duration: duration
        });
    }

    /*
     * Fallback for older OK.ru markup. This keeps compatibility with pages
     * that still return data-movie-id instead of normal video anchors.
     */
    if (results.length === 0) {
        let re = /data-movie-id\s*=\s*["']?(\d+)["']?([\s\S]{0,5000}?)(?=data-movie-id|$)/gi;
        while ((m = re.exec(html)) !== null && results.length < MAX_SEARCH) {
            let id = m[1];
            if (!id || seen[id]) continue;
            let block = m[2] || "";
            let title = "";
            let poster = "";
            let duration = 0;

            let tm = block.match(/(?:data-title|title)\s*=\s*["']([^"']+)["']/i);
            if (tm) title = cleanText(tm[1]);
            if (!title) {
                tm = block.match(/<(?:span|div|a)[^>]*class=["'][^"']*(?:title|name)[^"']*["'][^>]*>([\s\S]{1,500}?)<\/(?:span|div|a)>/i);
                if (tm) title = cleanText(tm[1]);
            }
            let pm = block.match(/(?:poster|thumbnail|data-poster|data-options)\s*=\s*["']([^"']+)["']/i);
            if (pm) poster = normalizeUrl(pm[1]);
            let dm = block.match(/(?:duration|movie-duration)[^>]*>([^<]{1,30})</i);
            if (dm) duration = parseDurationText(dm[1]);

            seen[id] = true;
            results.push({
                id: id,
                url: "https://ok.ru/video/" + id,
                title: title || "OK.ru video " + id,
                thumbnail: poster,
                duration: duration
            });
        }
    }

    return results;
}
function makeSearchVideo(r) {
    let thumbs = makeThumbnailList(r.thumbnail);
    let author = null;
    try {
        return new PlatformVideo({
            id: new PlatformID(PLATFORM_NAME, r.id, PLUGIN_ID),
            name: r.title,
            thumbnails: new Thumbnails(thumbs),
            author: author,
            uploadDate: 0,
            url: r.url,
            duration: r.duration || 0,
            viewCount: 0,
            isLive: false
        });
    } catch (_) {
        return null;
    }
}

function searchOk(query) {
    let q = safeStr(query).trim();
    if (!q) return new VideoPager([], false, null);

    let combined = [];
    let seen = {};

    /*
     * Combina ambos endpoints actuales de busqueda.
     * Asi se pierde menos cobertura cuando cada endpoint devuelve un conjunto
     * ligeramente distinto de resultados.
     */
    for (let i = 0; i < SEARCH_URL_BASES.length; i++) {
        let url = SEARCH_URL_BASES[i] + encodeURIComponent(q);
        let html = httpGetAuth(url);

        if (!html) html = httpGet(url);
        if (!html || html.length <= 500) continue;

        addDebug("search endpoint=" + i + " len=" + html.length);

        let raw = extractSearchResults(html);

        for (let j = 0; j < raw.length && combined.length < MAX_SEARCH; j++) {
            let r = raw[j] || {};
            let id = safeStr(r.id);

            if (!id || seen[id]) continue;

            let v = makeSearchVideo(r);
            if (!v) continue;

            seen[id] = true;
            combined.push(v);
        }
    }

    if (combined.length) return new VideoPager(combined, false, null);

    throw new Error("OK.ru search returned no video results\n" + debugText());
}
function searchSuggestions(query) {
    let q = safeStr(query).trim();
    if (!q) return [];
    let out = [];
    try {
        for (let i = 0; i < SEARCH_URL_BASES.length && out.length < 10; i++) {
            let url = SEARCH_URL_BASES[i] + encodeURIComponent(q);
            let html = httpGetAuth(url);
            if (!html) html = httpGet(url);
            if (!html) continue;
            let raw = extractSearchResults(html);
            for (let j = 0; j < raw.length && out.length < 10; j++) {
                if (raw[j].title && out.indexOf(raw[j].title) < 0) out.push(raw[j].title);
            }
            if (out.length) break;
        }
    } catch (e) {
        addDebug("suggestions=" + e);
    }
    return out;
}

/* -------------------- Details -------------------- */

function waitMs(ms) {
    try {
        if (typeof Utilities !== "undefined" && Utilities && typeof Utilities.sleep === "function") {
            Utilities.sleep(ms);
            return true;
        }
    } catch (_) {}
    return false;
}

function getVideoDetails(url) {
    resetDebug();
    let id = extractVideoId(url);
    if (!id) throw new Error("Invalid OK.ru video URL");

    let canonical = "https://ok.ru/video/" + id;
    let delays = [0, 500, 1000, 2000, 3000];
    let lastMeta = {};
    let external = null;

    for (let attempt = 0; attempt < delays.length; attempt++) {
        if (delays[attempt] > 0) waitMs(delays[attempt]);

        let html = loadOkPage(canonical);
        if (!html) {
            addDebug("attempt " + attempt + ": page unavailable");
            continue;
        }

        external = findYouTubeEmbed(html);
        if (external) addDebug("YouTube embed=" + external.id);

        let meta = parseMetadata(html, canonical) || {};

        if (!getPoster(meta, canonical)) {
            let pagePoster = extractPosterFromHtml(html, canonical);
            if (pagePoster) {
                meta.__ok_poster = pagePoster;
            } else if (external) {
                meta.__ok_poster =
                    "https://i.ytimg.com/vi/" + external.id + "/hqdefault.jpg";
            }
        }

        if (!getPoster(meta, canonical)) {
            let pagePoster = extractPosterFromHtml(html, canonical);
            if (pagePoster) meta.__ok_poster = pagePoster;
        }

        let pageMedia = collectMediaFromHtml(html, canonical);
        let objectMedia = collectMedia(meta, canonical);
        let merged = { hls: [], mp4: [] };

        // If OK.ru hosts a YouTube embed and the YouTube page exposes already
        // resolved media URLs, use those direct URLs. Ciphered formats are
        // deliberately left to the official YouTube plugin/native UMP path.
        if (external) {
            let ytMedia = collectYouTubeDirectMedia(external.id);
            mergeMediaLists(merged, ytMedia, canonical);

            /*
             * Second YouTube route: youtubei/player. It is only a fallback
             * and only contributes fully resolved URLs, so it does not
             * interfere with the normal OK.ru path.
             */
            if (merged.hls.length === 0 && merged.mp4.length === 0) {
                let ytApiMedia = collectYouTubePlayerApiMedia(external.id);
                mergeMediaLists(merged, ytApiMedia, canonical);
            }
        }

        for (let i = 0; i < objectMedia.hls.length; i++) pushUnique(merged.hls, objectMedia.hls[i], canonical);
        for (let i = 0; i < pageMedia.hls.length; i++) pushUnique(merged.hls, pageMedia.hls[i], canonical);
        for (let i = 0; i < objectMedia.mp4.length; i++) pushUnique(merged.mp4, objectMedia.mp4[i], canonical);
        for (let i = 0; i < pageMedia.mp4.length; i++) pushUnique(merged.mp4, pageMedia.mp4[i], canonical);

        merged.hls.sort(function(a, b) { return scoreMediaUrl(b) - scoreMediaUrl(a); });
        merged.mp4.sort(function(a, b) { return scoreMediaUrl(b) - scoreMediaUrl(a); });

        lastMeta = meta;
        addDebug("attempt=" + attempt + " hls=" + merged.hls.length + " mp4=" + merged.mp4.length);

        if (merged.hls.length || merged.mp4.length) {
            meta.__ok_hls = merged.hls;
            meta.__ok_mp4 = merged.mp4;
            return buildDetails(meta, canonical, id);
        }
    }

    // Do not throw the misleading old "YouTube embed" exception. The embed
    // is reported as an external reference. GrayJay's JS source API does not
    // expose a supported way to invoke another installed plugin from here,
    // so we cannot honestly fabricate a playable YouTube stream URL.
    if (external) {
        let title = getTitle(lastMeta, "YouTube video " + external.id);
        let poster = getPoster(lastMeta, canonical);
        let thumbs = makeThumbnailList(poster);
        let descriptor = makeEmptyDescriptor();
        let obj = {
            id: new PlatformID(PLATFORM_NAME, id, PLUGIN_ID),
            name: title,
            thumbnails: new Thumbnails(thumbs),
            author: null,
            uploadDate: 0,
            url: external.url,
            duration: getDuration(lastMeta),
            viewCount: 0,
            isLive: false,
            description: "Video de YouTube embebido en OK.ru. Se intentan fuentes directas cuando YouTube las expone; si requiere cipher/UMP, la resolucion queda fuera de este plugin. URL: " + external.url,
            video: descriptor || {},
            dash: null,
            hls: null,
            live: []
        };
        try { return new PlatformVideoDetails(obj); }
        catch (_) {
            return new PlatformVideoDetails({
                id: obj.id, name: obj.name, thumbnails: obj.thumbnails,
                author: null, uploadDate: 0, url: obj.url, duration: obj.duration,
                viewCount: 0, isLive: false, description: obj.description,
                video: descriptor || {}, live: []
            });
        }
    }

    throw new Error("No playable direct HLS/MP4 source found after retries\n" + debugText());
}

function scoreMediaUrl(url) {
    let s = safeStr(url).toLowerCase();
    let score = 0;
    if (s.indexOf("master") >= 0) score += 1000;
    if (s.indexOf("m3u8") >= 0) score += 500;
    let m = s.match(/(?:^|[^0-9])(2160|1440|1080|900|720|576|540|480|360|240)(?:p)?(?:[^0-9]|$)/);
    if (m) score += parseInt(m[1], 10);
    return score;
}

/* -------------------- GrayJay API -------------------- */

source.setSettings = function (settings) {
    // No requiere ajustes privados.
};

source.enable = function (config) {
    try {
        if (config && config.id) {
            // GrayJay normalmente suministra el id del plugin en config.
            // Se conserva el UUID de fallback para instalaciones antiguas.
            // No se toca si el runtime no lo proporciona.
        }
    } catch (_) {}
    return true;
};

source.disable = function () {};

source.getHome = function () {
    return new VideoPager([], false, null);
};

source.getSearchCapabilities = function () {
    try {
        return new ResultCapabilities(
            ["video"],
            [],
            []
        );
    } catch (_) {
        return { supportsSearch: true, supportsSuggestions: true };
    }
};

source.search = function (query, type, order, filters) {
    return searchOk(query);
};

source.searchSuggestions = function (query) {
    return searchSuggestions(query);
};

source.isVideoDetailsUrl = function (url) {
    return REGEX_VIDEO_URL.test(safeStr(url));
};

source.isContentDetailsUrl = function (url) {
    return REGEX_VIDEO_URL.test(safeStr(url));
};

source.getVideoDetails = function (url) {
    return getVideoDetails(url);
};

source.getContentDetails = function (url) {
    return getVideoDetails(url);
};

source.getComments = function (url, continuationToken) {
    return getCommentsOk(url, continuationToken);
};

source.getSubComments = function (comment) {
    // OK.ru does not expose a stable public replies endpoint through the
    // plugin API. Return an empty pager instead of throwing after playback.
    return makeCommentPager([], false, { comment: comment });
};

source.isChannelUrl = function (url) {
    return false;
};

source.getChannelCapabilities = function () {
    try { return new ResultCapabilities([], [], []); } catch (_) { return null; }
};

