const PLATFORM = "OkRu";
const BASE_URL = "https://ok.ru";

const REGEX_VIDEO_URL = /ok\.ru\/(?:video|videoembed|live|movie)\/(\d+)/i;

var _settings = {};

source.enable = function (conf, settings, savedState) {
	_settings = settings ?? {};
	log("[OK.ru] plugin habilitado");
};

source.disable = function () {
	log("[OK.ru] plugin deshabilitado");
};

source.getHome = function () {
	return new OkRuVideoPager([], false);
};

source.getSearchCapabilities = function () {
	return {
		types: [Type.Feed.Mixed],
		sorts: [Type.Order.Chronological],
		filters: []
	};
};

source.searchSuggestions = function (query) {
	return [];
};

source.search = function (query, type, order, filters) {
	const url = `${BASE_URL}/suggest?st.query=${encodeURIComponent(query)}`;

	const resp = http.GET(url, {
		"User-Agent": "Mozilla/5.0 (Linux; Android 10; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
		"Accept": "application/json"
	}, false);

	let items = [];
	if (resp.isOk) {
		try {
			const data = JSON.parse(resp.body);
			const suggestions = data.suggestions || data.results || [];
			suggestions.forEach((s, index) => {
				const title = typeof s === "string" ? s : (s.value || s.title);
				if (title) {
					items.push(new PlatformVideo({
						id: new PlatformID(PLATFORM, `search_${index}_${Date.now()}`, plugin.config.id),
						name: title,
						thumbnails: new Thumbnails([]),
						author: new PlatformAuthorLink(
							new PlatformID(PLATFORM, "unknown", plugin.config.id),
							"OK.ru",
							BASE_URL,
							""
						),
						datetime: 0,
						duration: 0,
						viewCount: 0,
						url: `${BASE_URL}/video/search?st.query=${encodeURIComponent(title)}`,
						isLive: false
					}));
				}
			});
		} catch (e) {}
	}

	return new OkRuVideoPager(items, false);
};

source.isContentDetailsUrl = function (url) {
	return REGEX_VIDEO_URL.test(url);
};

source.getContentDetails = function (url) {
	const match = REGEX_VIDEO_URL.exec(url);
	if (!match) {
		throw new ScriptException("URL de video de OK.ru no reconocida: " + url);
	}
	const videoId = match[1];

	// Intentamos primero atacando la versión móvil (m.ok.ru), la cual suele exponer el JSON de video de forma más accesible sin tanto script de rastreo
	const mobileUrl = `https://m.ok.ru/video/${videoId}`;
	const resp = http.GET(mobileUrl, {
		"User-Agent": "Mozilla/5.0 (Linux; Android 10; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
		"Referer": "https://m.ok.ru/"
	}, false);

	let html = "";
	if (resp.isOk) {
		html = resp.body;
	}

	// Si la versión móvil falla, recurrimos al embed clásico como respaldo
	if (!html || html.indexOf("data-options") === -1) {
		const embedUrl = `${BASE_URL}/videoembed/${videoId}`;
		const respEmbed = http.GET(embedUrl, {
			"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
			"Referer": BASE_URL
		}, false);
		if (respEmbed.isOk) {
			html = respEmbed.body;
		}
	}

	const metadata = parseMetadataFromHtml(html);
	if (!metadata) {
		throw new ScriptException("OK.ru requiere autorización o cambió los metadatos del reproductor para este video.");
	}

	const movie = metadata.movie || {};
	const author = metadata.author || {};

	const title = movie.title || "Video de OK.ru";
	const thumbnailUrl = movie.poster || "";
	const duration = Math.round(movie.duration || 0);
	const isLive = movie.type === "LIVE" || !!metadata.isLive;

	const videoSources = buildVideoSources(metadata);
	if (videoSources.length === 0) {
		throw new ScriptException("No se pudieron extraer los enlaces de video (Streams protegidos o vacíos).");
	}

	return new PlatformVideoDetails({
		id: new PlatformID(PLATFORM, videoId, plugin.config.id),
		name: title,
		thumbnails: new Thumbnails([new Thumbnail(thumbnailUrl, 0)]),
		author: new PlatformAuthorLink(
			new PlatformID(PLATFORM, String(author.id || ""), plugin.config.id),
			author.name || "OK.ru",
			author.url || BASE_URL,
			author.pic || ""
		),
		datetime: 0,
		duration: duration,
		viewCount: movie.viewsCount || movie.totalCount || 0,
		url: url,
		shareUrl: url,
		isLive: isLive,
		video: new VideoSourceDescriptor(videoSources)
	});
};

function parseMetadataFromHtml(html) {
	if (!html) return null;

	// Búsqueda exhaustiva del atributo data-options en diferentes formatos de comillas
	const regexPatterns = [
		/data-options="([^"]+)"/i,
		/data-options='([^']+)'/i,
		/\"metadata"\s*:\s*("[^"]+")/,
		/player\.setOptions\s*\(\s*(\{.+?\})\s*\)\s*;/i
	];

	for (let i = 0; i < regexPatterns.length; i++) {
		const match = regexPatterns[i].exec(html);
		if (match) {
			try {
				let rawVal = match[1];
				// Si es un string escapado JSON
				if (rawVal.startsWith('"') && rawVal.endsWith('"')) {
					rawVal = JSON.parse(rawVal);
				}
				const decoded = htmlDecode(rawVal);
				const jsonOpts = JSON.parse(decoded);
				const metadataStr = jsonOpts.flashvars?.metadata || jsonOpts.metadata || jsonOpts;
				
				if (typeof metadataStr === "string") {
					return JSON.parse(decodeURIComponent(metadataStr));
				} else if (typeof metadataStr === "object" && metadataStr.movie) {
					return metadataStr;
				}
			} catch (e) {
				// Continuar probando el siguiente patrón si falla este
			}
		}
	}
	return null;
}

function buildVideoSources(metadata) {
	const sources = [];

	if (metadata.videos && Array.isArray(metadata.videos)) {
		metadata.videos.forEach(v => {
			if (!v.url) return;
			const dims = qualityNameToDims(v.name);
			sources.push(new VideoUrlSource({
				name: v.name || "mp4",
				url: v.url,
				width: dims.width,
				height: dims.height,
				container: "video/mp4",
				codec: "h264",
				bitrate: 0,
				duration: Math.round(metadata.movie?.duration || 0)
			}));
		});
	}

	if (metadata.hlsManifestUrl) {
		sources.push(new HLSSource({
			name: "HLS",
			url: metadata.hlsManifestUrl,
			duration: Math.round(metadata.movie?.duration || 0),
			priority: true
		}));
	}

	return sources;
}

function qualityNameToDims(name) {
	switch (name) {
		case "mobile": return { width: 320, height: 240 };
		case "lowest": return { width: 426, height: 240 };
		case "low": return { width: 640, height: 360 };
		case "sd": return { width: 854, height: 480 };
		case "hd": return { width: 1280, height: 720 };
		case "full": return { width: 1920, height: 1080 };
		case "quad": return { width: 2560, height: 1440 };
		default: return { width: 0, height: 0 };
	}
}

function htmlDecode(str) {
	return str
		.replace(/&quot;/g, "\"")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&#39;/g, "'");
}

class OkRuVideoPager extends VideoPager {
	constructor(results, hasMore, context) {
		super(results, hasMore, context ?? {});
	}
	nextPage() {
		return new OkRuVideoPager([], false, this.context);
	}
}
