/*
 * GrayJay - OK.ru Source v24 (v5 search/parser preserved)
 *
 * Stable OK.ru video extraction with:
 *  - desktop/mobile page fallback
 *  - authenticated request fallback
 *  - data-options / metadata / metadataUrl parsing
 *  - recursive HLS/MP4 discovery
 *  - defensive URL normalization/deduplication
 *  - direct HLS preference for casting
 *  - Xuper-compatible metadata fallback
 *  - bounded debugging
 *
 * Important:
 * The Xuper APK contains fields such as play_params, verificationToken,
 * playlistUrl and signdata. This source deliberately does NOT invent a
 * signing algorithm or a private Xuper endpoint. If OK metadata exposes a
 * valid playlistUrl/playable URL, it is consumed directly. Otherwise the
 * normal OK.ru HLS path is used. This avoids returning an intermediate
 * player page to Cast.
 */

const PLATFORM_NAME = "OK.ru";

const REGEX_VIDEO_URL = /ok\.ru\/(?:video|videoembed)\/(\d+)/i;
const SEARCH_URL_BASE =
    "https://ok.ru/dk?st.cmd=searchResult&st.mode=Movie&st.grmode=Groups&st.query=";

const MAX_HTML_SIZE = 5000000;
const MAX_JSON_DEPTH = 12;
const MAX_SOURCES = 30;
const MAX_DEBUG = 50;

let DEBUG = [];

function addDebug(value) {
    try {
        let s = safeStr(value);
        if (!s) return;
        if (DEBUG.length >= MAX_DEBUG) DEBUG.shift();
        DEBUG.push(s.length > 600 ? s.substring(0, 600) + "…" : s);
    } catch (_) {}
}

function resetDebug() {
    DEBUG = [];
}

function debugText() {
    return DEBUG.join("\n");
}

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
        .replace(/&#47;/g, "/");
}

function stripTags(s) {
    return safeStr(s).replace(/<[^>]*>/g, " ");
}

function cleanText(s) {
    return htmlDecode(stripTags(s))
        .replace(/\s+/g, " ")
        .trim();
}

function cleanUrl(s) {
    return htmlDecode(safeStr(s))
        .replace(/^["']+|["']+$/g, "")
        .replace(/\\\//g, "/")
        .trim();
}

function normalizeUrl(s, base) {
    s = cleanUrl(s);
    if (!s) return "";

    if (s.indexOf("//") === 0) return "https:" + s;

    if (/^https?:\/\//i.test(s)) return s;

    if (base) {
        try {
            if (s.indexOf("/") === 0) {
                let m = safeStr(base).match(/^(https?:\/\/[^/]+)/i);
                if (m) return m[1] + s;
            }
        } catch (_) {}
    }

    return s;
}

function isHttpUrl(s) {
    return /^https?:\/\//i.test(cleanUrl(s));
}

function getHost(url) {
    try {
        let m = safeStr(url).match(/^https?:\/\/([^/]+)/i);
        return m ? m[1].toLowerCase() : "";
    } catch (_) {
        return "";
    }
}

function isExternalProvider(url) {
    let h = getHost(url);
    if (!h) return false;
    return /youtube\.com|youtu\.be|vimeo\.com/i.test(h);
}

function isM3u8Url(url) {
    return /\.m3u8(?:$|[?#])/i.test(cleanUrl(url));
}

function extractVideoId(url) {
    try {
        let m = safeStr(url).match(REGEX_VIDEO_URL);
        return m ? m[1] : "";
    } catch (_) {
        return "";
    }
}

function mergeHeaders(target, extra) {
    target = target || {};
    if (!extra) return target;

    try {
        for (let k in extra) {
            if (extra[k] !== null && extra[k] !== undefined) {
                target[k] = safeStr(extra[k]);
            }
        }
    } catch (_) {}

    return target;
}

function httpGet(url, headers) {
    try {
        let h = {
            "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
                "AppleWebKit/537.36 (KHTML, like Gecko) " +
                "Chrome/136.0.0.0 Safari/537.36",
            "Accept":
                "text/html,application/xhtml+xml,application/xml;q=0.9," +
                "image/avif,image/webp,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Cache-Control": "no-cache",
            "Pragma": "no-cache"
        };

        mergeHeaders(h, headers);

        let r = http.GET(url, h);
        if (!r) return "";

        let body = "";
        try {
            body = r.body;
        } catch (_) {}

        if (!body) {
            try {
                body = r.getBody();
            } catch (_) {}
        }

        body = safeStr(body);

        if (body.length > MAX_HTML_SIZE) {
            addDebug("HTTP body capped: " + body.length);
            body = body.substring(0, MAX_HTML_SIZE);
        }

        return body;
    } catch (e) {
        addDebug("httpGet: " + e);
        return "";
    }
}

function httpGetAuthenticated(url) {
    try {
        // Use GrayJay's authenticated HTTP client when the plugin session is logged in.
        // No session cookies are embedded in the source.
        let useLogin = false;
        try { useLogin = !!bridge.isLoggedIn(); } catch (_) {}

        let headers = {
            "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
                "AppleWebKit/537.36 (KHTML, like Gecko) " +
                "Chrome/136.0.0.0 Safari/537.36",
            "Accept":
                "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Cache-Control": "no-cache",
            "Pragma": "no-cache"
        };

        let r = http.GET(url, headers, useLogin);
        if (!r) return "";

        let body = "";
        try {
            body = r.body;
        } catch (_) {}

        if (!body) {
            try {
                body = r.getBody();
            } catch (_) {}
        }

        body = safeStr(body);
        if (body.length > MAX_HTML_SIZE) body = body.substring(0, MAX_HTML_SIZE);
        return body;
    } catch (e) {
        addDebug("authenticated GET: " + e);
        return "";
    }
}

function loadOkPage(url) {
    let desktop = {
        "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
            "AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/136.0.0.0 Safari/537.36"
    };

    let mobile = {
        "User-Agent":
            "Mozilla/5.0 (Linux; Android 14; Pixel 8) " +
            "AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/136.0.0.0 Mobile Safari/537.36"
    };

    let attempts = [
        function () { return httpGetAuthenticated(url); },
        function () { return httpGet(url, desktop); },
        function () { return httpGetAuthenticated(url); },
        function () { return httpGet(url, mobile); }
    ];

    for (let i = 0; i < attempts.length; i++) {
        try {
            let body = attempts[i]();
            if (body && body.length > 300) {
                addDebug("OK page loaded via attempt " + i);
                return body;
            }
        } catch (_) {}
    }

    return "";
}

function tryParseJson(value) {
    if (value === null || value === undefined) return null;

    if (safeObj(value)) return value;

    let s = safeStr(value).trim();
    if (!s) return null;

    for (let pass = 0; pass < 4; pass++) {
        try {
            let v = JSON.parse(s);
            return v;
        } catch (_) {}

        let decoded = htmlDecode(s);
        if (decoded !== s) {
            s = decoded;
            continue;
        }

        if (
            (s.charAt(0) === '"' && s.charAt(s.length - 1) === '"') ||
            (s.charAt(0) === "'" && s.charAt(s.length - 1) === "'")
        ) {
            s = s.substring(1, s.length - 1);
            continue;
        }

        let unescaped = s
            .replace(/\\"/g, '"')
            .replace(/\\'/g, "'")
            .replace(/\\\\/g, "\\");

        if (unescaped !== s) {
            s = unescaped;
            continue;
        }

        break;
    }

    return null;
}

function extractDataOptions(html) {
    let out = [];
    let re =
        /(?:data-options|data-options-json)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

    let m;
    while ((m = re.exec(html || "")) !== null && out.length < 20) {
        let raw = m[1] !== undefined ? m[1] : m[2];
        let obj = tryParseJson(raw);
        if (obj) out.push(obj);
    }

    return out;
}

function findMetadataInObject(root, depth) {
    if (!safeObj(root) || depth > MAX_JSON_DEPTH) return null;

    if (Array.isArray(root)) {
        for (let i = 0; i < root.length; i++) {
            let found = findMetadataInObject(root[i], depth + 1);
            if (found) return found;
        }
        return null;
    }

    let preferred = [
        "metadata",
        "flashvars",
        "video",
        "movie",
        "movieData",
        "data",
        "result"
    ];

    for (let i = 0; i < preferred.length; i++) {
        let k = preferred[i];
        try {
            if (root[k] !== undefined) {
                if (k === "metadata" && safeObj(root[k])) return root[k];

                let found = findMetadataInObject(root[k], depth + 1);
                if (found) return found;
            }
        } catch (_) {}
    }

    try {
        if (root.metadataUrl || root.metadataURL) {
            return root;
        }
    } catch (_) {}

    try {
        for (let key in root) {
            if (depth >= MAX_JSON_DEPTH) break;
            let value = root[key];

            if (
                /metadata|flashvar|video|movie|media|stream|playlist/i.test(
                    key
                )
            ) {
                let found = findMetadataInObject(value, depth + 1);
                if (found) return found;
            }
        }
    } catch (_) {}

    return null;
}

function extractMetadataFromHtml(html) {
    html = safeStr(html);
    if (!html) return null;

    let options = extractDataOptions(html);
    for (let i = 0; i < options.length; i++) {
        let found = findMetadataInObject(options[i], 0);
        if (found) return found;
    }

    let patterns = [
        /(?:^|["'])metadata["']?\s*:\s*(\{[\s\S]{20,200000}\})/i,
        /(?:^|["'])flashvars["']?\s*:\s*(\{[\s\S]{20,200000}\})/i,
        /(?:^|["'])video["']?\s*:\s*(\{[\s\S]{20,200000}\})/i
    ];

    for (let i = 0; i < patterns.length; i++) {
        try {
            let m = html.match(patterns[i]);
            if (m) {
                let obj = tryParseJson(m[1]);
                if (obj) {
                    let found = findMetadataInObject(obj, 0);
                    if (found) return found;
                    return obj;
                }
            }
        } catch (_) {}
    }

    // Last-resort JSON candidate scan.
    let starts = [];
    for (let i = 0; i < html.length && starts.length < 80; i++) {
        if (html.charAt(i) === "{") starts.push(i);
    }

    for (let i = 0; i < starts.length; i++) {
        let start = starts[i];
        let end = Math.min(html.length, start + 200000);
        let candidate = html.substring(start, end);

        let obj = tryParseJson(candidate);
        if (obj) {
            let found = findMetadataInObject(obj, 0);
            if (found) return found;
        }
    }

    return null;
}

function fetchMetadataUrl(meta, baseUrl) {
    if (!safeObj(meta)) return null;

    let candidates = [
        meta.metadataUrl,
        meta.metadataURL,
        meta.flashvars && meta.flashvars.metadataUrl,
        meta.flashvars && meta.flashvars.metadataURL
    ];

    for (let i = 0; i < candidates.length; i++) {
        let url = normalizeUrl(candidates[i], baseUrl);
        if (!isHttpUrl(url)) continue;

        addDebug("metadataUrl: " + url);

        let body = httpGetAuthenticated(url);
        if (!body) body = httpGet(url);

        let obj = tryParseJson(body);
        if (obj) return findMetadataInObject(obj, 0) || obj;
    }

    return null;
}

function parseMetadata(html, pageUrl) {
    let meta = extractMetadataFromHtml(html);

    if (!meta) return null;

    let fetched = fetchMetadataUrl(meta, pageUrl);
    if (fetched) return fetched;

    return meta;
}

function pushUnique(arr, value) {
    value = normalizeUrl(value);
    if (!isHttpUrl(value)) return;
    if (arr.indexOf(value) >= 0) return;
    if (arr.length >= MAX_SOURCES) return;
    arr.push(value);
}

function collectUrlsFromString(s, arr) {
    s = safeStr(s);
    if (!s) return;

    let decoded = htmlDecode(s)
        .replace(/\\\//g, "/")
        .replace(/&amp;/g, "&");

    let abs =
        /https?:\/\/[^\s"'<>\\]+/gi;

    let m;
    while ((m = abs.exec(decoded)) !== null) {
        let u = cleanUrl(m[0]);
        if (isM3u8Url(u)) pushUnique(arr, u);
    }

    let proto = /\/\/[^\s"'<>\\]+/g;
    while ((m = proto.exec(decoded)) !== null) {
        let u = "https:" + cleanUrl(m[0]);
        if (isM3u8Url(u)) pushUnique(arr, u);
    }

    if (isM3u8Url(decoded.trim())) {
        pushUnique(arr, decoded.trim());
    }
}

function collectUrlsFromObject(obj, arr, depth) {
    if (!safeObj(obj) || depth > MAX_JSON_DEPTH || arr.length >= MAX_SOURCES) {
        return;
    }

    if (typeof obj === "string") {
        collectUrlsFromString(obj, arr);
        return;
    }

    if (Array.isArray(obj)) {
        for (let i = 0; i < obj.length; i++) {
            collectUrlsFromObject(obj[i], arr, depth + 1);
            if (arr.length >= MAX_SOURCES) break;
        }
        return;
    }

    try {
        for (let key in obj) {
            let value = obj[key];

            if (
                /hls|m3u8|manifest|playlist|stream|video|file|url/i.test(key)
            ) {
                collectUrlsFromObject(value, arr, depth + 1);
            }

            if (safeObj(value)) {
                collectUrlsFromObject(value, arr, depth + 1);
            } else if (typeof value === "string") {
                collectUrlsFromString(value, arr);
            }

            if (arr.length >= MAX_SOURCES) break;
        }
    } catch (_) {}
}

function collectMp4UrlsFromString(s, arr) {
    s = safeStr(s);
    if (!s) return;

    let re = /https?:\/\/[^\s"'<>\\]+/gi;
    let m;

    while ((m = re.exec(s)) !== null) {
        let u = cleanUrl(m[0]);
        if (/\.(?:mp4|m4v|mov)(?:$|[?#])/i.test(u)) pushUnique(arr, u);
    }
}

function collectMp4UrlsFromObject(obj, arr, depth) {
    if (!safeObj(obj) || depth > MAX_JSON_DEPTH || arr.length >= MAX_SOURCES) {
        return;
    }

    if (typeof obj === "string") {
        collectMp4UrlsFromString(obj, arr);
        return;
    }

    if (Array.isArray(obj)) {
        for (let i = 0; i < obj.length; i++) {
            collectMp4UrlsFromObject(obj[i], arr, depth + 1);
        }
        return;
    }

    try {
        for (let key in obj) {
            let v = obj[key];

            if (typeof v === "string") {
                collectMp4UrlsFromString(v, arr);
            } else if (safeObj(v)) {
                collectMp4UrlsFromObject(v, arr, depth + 1);
            }

            if (arr.length >= MAX_SOURCES) break;
        }
    } catch (_) {}
}

function collectHlsUrls(meta) {
    let urls = [];

    let preferred = [
        "hlsMasterPlaylistUrl",
        "hlsManifestUrl",
        "hlsUrl",
        "hls_playlist",
        "hls",
        "hlsUrlMobile",
        "playlistUrl",
        "manifestUrl",
        "streamUrl",
        "videoUrl",
        "url",
        "file"
    ];

    function walk(obj, depth) {
        if (!safeObj(obj) || depth > MAX_JSON_DEPTH) return;

        if (Array.isArray(obj)) {
            for (let i = 0; i < obj.length; i++) {
                walk(obj[i], depth + 1);
                if (urls.length >= MAX_SOURCES) return;
            }
            return;
        }

        for (let i = 0; i < preferred.length; i++) {
            let key = preferred[i];

            try {
                if (obj[key] !== undefined) {
                    if (typeof obj[key] === "string") {
                        collectUrlsFromString(obj[key], urls);
                        if (isM3u8Url(obj[key])) pushUnique(urls, obj[key]);
                    } else {
                        collectUrlsFromObject(obj[key], urls, depth + 1);
                    }
                }
            } catch (_) {}
        }

        try {
            for (let key in obj) {
                let v = obj[key];

                if (/hls|m3u8|playlist|manifest/i.test(key)) {
                    if (typeof v === "string") {
                        collectUrlsFromString(v, urls);
                        if (isM3u8Url(v)) pushUnique(urls, v);
                    } else {
                        collectUrlsFromObject(v, urls, depth + 1);
                    }
                }

                if (urls.length >= MAX_SOURCES) return;
            }
        } catch (_) {}
    }

    walk(meta, 0);

    return urls;
}

function collectMp4Urls(meta) {
    let urls = [];
    collectMp4UrlsFromObject(meta, urls, 0);
    return urls;
}

function firstValue(obj, keys) {
    if (!safeObj(obj)) return "";

    for (let i = 0; i < keys.length; i++) {
        let k = keys[i];

        try {
            if (obj[k] !== undefined && obj[k] !== null) {
                let s = safeStr(obj[k]);
                if (s) return s;
            }
        } catch (_) {}
    }

    return "";
}

function getTitle(meta, fallback) {
    let v = firstValue(meta, [
        "title",
        "name",
        "movieTitle",
        "videoTitle",
        "caption"
    ]);

    return cleanText(v) || cleanText(fallback) || "OK.ru video";
}

function getPoster(meta) {
    return firstValue(meta, [
        "poster",
        "posterUrl",
        "thumbnail",
        "thumbnailUrl",
        "cover",
        "coverUrl",
        "image",
        "imageUrl",
        "preview"
    ]);
}

function getDuration(meta) {
    let v = firstValue(meta, [
        "duration",
        "durationMs",
        "durationSec",
        "length",
        "videoDuration"
    ]);

    let n = parseFloat(v);
    if (!isFinite(n) || n <= 0) return 0;

    // GrayJay commonly expects seconds.
    if (n > 100000) n = n / 1000;
    else if (n > 1000 && n < 100000) n = n / 1000;

    return Math.round(n);
}

function getAuthorName(meta) {
    return cleanText(
        firstValue(meta, [
            "authorName",
            "author",
            "ownerName",
            "uploader",
            "userName",
            "username"
        ])
    );
}

/*
 * Xuper-compatible fallback.
 *
 * Verified APK field names include:
 *   play_params
 *   verificationToken / verification_token
 *   playlistUrl
 *   signdata
 *
 * We only consume a playlist URL that is already present in metadata.
 * We intentionally do not fabricate a signer, token generator, or private
 * Xuper endpoint because those are implementation-specific.
 */
function xuperGetPlayParams(meta) {
    return firstValue(meta, ["play_params", "playParams"]);
}

function xuperGetVerificationToken(meta) {
    return firstValue(meta, ["verificationToken", "verification_token"]);
}

function xuperGetPlaylistUrl(meta) {
    return firstValue(meta, ["playlistUrl", "playlist_url"]);
}

function xuperGetSignature(meta) {
    return firstValue(meta, ["signdata", "signature", "sign"]);
}

function xuperResolve(meta) {
    if (!safeObj(meta)) return "";

    let direct = xuperGetPlaylistUrl(meta);
    if (isM3u8Url(direct)) return normalizeUrl(direct);

    // Some responses nest the Xuper fields.
    let containers = [
        meta.xuper,
        meta.data,
        meta.result,
        meta.auth,
        meta.player,
        meta.flashvars
    ];

    for (let i = 0; i < containers.length; i++) {
        if (!safeObj(containers[i])) continue;

        let u = xuperGetPlaylistUrl(containers[i]);
        if (isM3u8Url(u)) return normalizeUrl(u);
    }

    return "";
}

function buildImportOptions() {
    try {
        return {
            applyAuthClient: "",
            applyCookieClient: "",
            applyOtherHeaders: false,
            impersonateTarget: "chrome136"
        };
    } catch (_) {
        return null;
    }
}

function buildRequestModifier(url, headers) {
    try {
        let modifier = new RequestModifier();

        try {
            modifier.url = url;
        } catch (_) {}

        try {
            if (headers) modifier.headers = headers;
        } catch (_) {}

        try {
            modifier.importOptions = buildImportOptions();
        } catch (_) {}

        return modifier;
    } catch (_) {
        return null;
    }
}

function makeHlsSource(url, headers) {
    let modifier = buildRequestModifier(url, headers);

    try {
        if (modifier) {
            return new VideoSource(url, "application/x-mpegURL", modifier);
        }
    } catch (_) {}

    try {
        if (modifier) {
            return new VideoSource(url, "application/vnd.apple.mpegurl", modifier);
        }
    } catch (_) {}

    try {
        return new VideoSource(url, "application/x-mpegURL");
    } catch (_) {}

    try {
        return new VideoSource(url);
    } catch (_) {}

    return null;
}

function makeMp4Source(url, headers) {
    let modifier = buildRequestModifier(url, headers);

    try {
        if (modifier) {
            return new VideoSource(url, "video/mp4", modifier);
        }
    } catch (_) {}

    try {
        return new VideoSource(url, "video/mp4");
    } catch (_) {}

    try {
        return new VideoSource(url);
    } catch (_) {}

    return null;
}

function buildSourceHeaders(meta) {
    let headers = {};

    if (!safeObj(meta)) return headers;

    try {
        let referer = firstValue(meta, ["referer", "referrer"]);
        if (isHttpUrl(referer)) headers["Referer"] = referer;
    } catch (_) {}

    try {
        let ua = firstValue(meta, ["userAgent", "user_agent"]);
        if (ua) headers["User-Agent"] = ua;
    } catch (_) {}

    try {
        let cookie = firstValue(meta, ["cookie"]);
        if (cookie) headers["Cookie"] = cookie;
    } catch (_) {}

    return headers;
}

function buildVideoDetails(meta, pageUrl, fallbackTitle) {
    if (!safeObj(meta)) throw new Error("No metadata");

    let title = getTitle(meta, fallbackTitle);
    let poster = normalizeUrl(getPoster(meta), pageUrl);
    let duration = getDuration(meta);
    let authorName = getAuthorName(meta);

    let hls = [];

    // Xuper-compatible direct playlist is deliberately first.
    let xuperPlaylist = xuperResolve(meta);
    if (isM3u8Url(xuperPlaylist)) pushUnique(hls, xuperPlaylist);

    let normalHls = collectHlsUrls(meta);
    for (let i = 0; i < normalHls.length; i++) {
        pushUnique(hls, normalHls[i]);
    }

    let mp4 = collectMp4Urls(meta);
    let headers = buildSourceHeaders(meta);

    let sources = [];

    // HLS first: this is the most reliable path for GrayJay and Cast.
    for (let i = 0; i < hls.length; i++) {
        let src = makeHlsSource(hls[i], headers);
        if (src) sources.push(src);
    }

    // MP4 only as fallback.
    if (sources.length === 0) {
        for (let i = 0; i < mp4.length; i++) {
            let src = makeMp4Source(mp4[i], headers);
            if (src) sources.push(src);
        }
    }

    if (sources.length === 0) {
        throw new Error("No playable HLS/MP4 source found");
    }

    let thumbnails = [];
    if (poster && isHttpUrl(poster)) {
        try {
            thumbnails.push(new Thumbnail(poster, 0));
        } catch (_) {}
    }

    let author = null;
    if (authorName) {
        try {
            author = new PlatformAuthorLink(authorName, "");
        } catch (_) {}
    }

    let descriptor = new VideoSourceDescriptor(sources);

    try {
        return new PlatformVideoDetails({
            title: title,
            description: "",
            duration: duration,
            thumbnail: poster,
            author: author,
            videoSources: descriptor,
            thumbnails: thumbnails
        });
    } catch (_) {}

    try {
        return new PlatformVideoDetails(
            title,
            "",
            duration,
            poster,
            author,
            descriptor,
            thumbnails
        );
    } catch (e) {
        throw new Error("PlatformVideoDetails constructor failed: " + e);
    }
}

function extractSearchResults(html) {
    let results = [];
    html = safeStr(html);

    let re =
        /data-movie-id\s*=\s*["']?(\d+)["']?([\s\S]{0,5000}?)(?=data-movie-id|$)/gi;

    let m;
    while ((m = re.exec(html)) !== null && results.length < 30) {
        let id = m[1];
        let block = m[2] || "";

        let title = "";
        let poster = "";
        let duration = 0;

        try {
            let tm = block.match(
                /(?:data-title|title)\s*=\s*["']([^"']+)["']/i
            );
            if (tm) title = cleanText(tm[1]);
        } catch (_) {}

        if (!title) {
            try {
                let tm = block.match(
                    /<(?:span|div|a)[^>]*class=["'][^"']*(?:title|name)[^"']*["'][^>]*>([\s\S]{1,500}?)<\/(?:span|div|a)>/i
                );
                if (tm) title = cleanText(tm[1]);
            } catch (_) {}
        }

        try {
            let pm = block.match(
                /(?:data-options|poster|thumbnail|data-poster)\s*=\s*["']([^"']+)["']/i
            );
            if (pm) poster = normalizeUrl(pm[1]);
        } catch (_) {}

        try {
            let dm = block.match(
                /(?:duration|movie-duration)[^>]*>([^<]{1,30})</i
            );
            if (dm) {
                let text = cleanText(dm[1]);
                let parts = text.split(":");
                if (parts.length === 2) {
                    duration =
                        parseInt(parts[0], 10) * 60 +
                        parseInt(parts[1], 10);
                } else if (parts.length === 3) {
                    duration =
                        parseInt(parts[0], 10) * 3600 +
                        parseInt(parts[1], 10) * 60 +
                        parseInt(parts[2], 10);
                }
            }
        } catch (_) {}

        let url = "https://ok.ru/video/" + id;

        try {
            let details = new PlatformVideoDetails({
                title: title || "OK.ru video " + id,
                description: "",
                duration: duration,
                thumbnail: poster,
                videoSources: null
            });

            results.push({
                id: id,
                url: url,
                details: details
            });
        } catch (_) {
            // Search details are intentionally lightweight; getVideoDetails
            // performs the authoritative extraction when opened.
            results.push({
                id: id,
                url: url,
                title: title || "OK.ru video " + id,
                thumbnail: poster,
                duration: duration
            });
        }
    }

    return results;
}

function searchOk(query) {
    let url = SEARCH_URL_BASE + encodeURIComponent(safeStr(query));
    let html = httpGetAuthenticated(url);

    if (!html) html = httpGet(url);

    if (!html) throw new Error("OK.ru search returned no data");

    return extractSearchResults(html);
}

function searchSuggestions(query) {
    let results = [];

    try {
        let found = searchOk(query);
        for (let i = 0; i < found.length && results.length < 10; i++) {
            let r = found[i];
            let title = r.title || "";

            if (r.details) {
                try {
                    title = r.details.title || title;
                } catch (_) {}
            }

            if (title) results.push(title);
        }
    } catch (e) {
        addDebug("suggestions: " + e);
    }

    return results;
}

function doDetails(url) {
    resetDebug();

    let id = extractVideoId(url);
    if (!id) throw new Error("Invalid OK.ru video URL");

    let canonical =
        "https://ok.ru/video/" + id;

    addDebug("Video ID: " + id);

    let html = loadOkPage(canonical);

    if (!html) {
        throw new Error("Unable to load OK.ru video page");
    }

    // External providers are noted but not used as a source.
    if (isExternalProvider(html)) {
        addDebug("External provider reference detected");
    }

    let meta = parseMetadata(html, canonical);

    if (!meta) {
        throw new Error(
            "OK.ru metadata not found. Debug:\n" + debugText()
        );
    }

    addDebug(
        "Xuper fields: play_params=" +
        (xuperGetPlayParams(meta) ? "yes" : "no") +
        ", verificationToken=" +
        (xuperGetVerificationToken(meta) ? "yes" : "no") +
        ", playlistUrl=" +
        (xuperGetPlaylistUrl(meta) ? "yes" : "no") +
        ", signdata=" +
        (xuperGetSignature(meta) ? "yes" : "no")
    );

    let fallbackTitle = "OK.ru video " + id;

    return buildVideoDetails(meta, canonical, fallbackTitle);
}

/*
 * v24 architecture:
 * - Search/parser/results are preserved from the known-good v5 implementation.
 * - Playback keeps the v5 extraction path, with authenticated page requests
 *   using GrayJay's session when available.
 * - No real cookies or session values are embedded in the script.
 */

/* ------------------------- GrayJay bindings ------------------------- */

source.setSettings = function (settings) {
    // Kept for compatibility with GrayJay versions that expect setSettings.
};

source.enable = function () {
    return true;
};

source.getSearchCapabilities = function () {
    try {
        return new PlatformSearchCapabilities(
            true,
            true,
            false,
            false
        );
    } catch (_) {
        return {
            search: true,
            suggestions: true
        };
    }
};

source.search = function (query) {
    return searchOk(query);
};

source.searchSuggestions = function (query) {
    return searchSuggestions(query);
};

source.isContentDetailsUrl = function (url) {
    return REGEX_VIDEO_URL.test(safeStr(url));
};

source.isVideoDetailsUrl = function (url) {
    return REGEX_VIDEO_URL.test(safeStr(url));
};

source.getVideoDetails = function (url) {
    return doDetails(url);
};

source.getContentDetails = function (url) {
    return doDetails(url);
};

source.getHome = function () {
    return [];
};

source.isChannelUrl = function (url) {
    return false;
};
