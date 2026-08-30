const PLATFORM = "OkRu";
const BASE_URL = "https://ok.ru";

const REGEX_VIDEO_URL = /ok\.ru\/(?:video|videoembed|live)\/(\d+)/i;

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
	// Utilizamos el endpoint JSON alternativo o de sugerencias si el buscador web principal rechaza la conexión
	const url = `${BASE_URL}/suggest?st.query=${encodeURIComponent(query)}`;

	const resp = http.GET(url, {
		"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
		"Accept": "application/json"
	}, false);

	let items = [];
	if (resp.isOk) {
		try {
			const data = JSON.parse(resp.body);
			// Si la estructura de sugerencias trae elementos, los convertimos
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
		} catch (e) {
			// Si falla el parseo de sugerencias, devolvemos vacío de forma controlada sin romper la app
		}
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

	// Petición al reproductor embebido que contiene la metadata en crudo
	const embedUrl = `${BASE_URL}/videoembed/${videoId}`;
	const resp = http.GET(embedUrl, {
		"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
		"Referer": BASE_URL
	}, false);

	if (!resp.isOk) {
		throw new ScriptException(`No se pudo conectar con OK.ru (HTTP ${resp.code})`);
	}

	const html = resp.body;
	const metadata = parseMetadataFromHtml(html);

	if (!metadata) {
		throw new ScriptException("OK.ru protege este contenido o cambió el formato del reproductor.");
	}

	const movie = metadata.movie || {};
	const author = metadata.author || {};

	const title = movie.title || "Video de OK.ru";
	const thumbnailUrl = movie.poster || "";
	const duration = Math.round(movie.duration || 0);
	const isLive = movie.type === "LIVE" || !!metadata.isLive;

	const videoSources = buildVideoSources(metadata);
	if (videoSources.length === 0) {
		throw new ScriptException("El video no cuenta con fuentes de reproducción abiertas.");
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
	// Método 1: Buscar el bloque data-options estándar
	const dataOptionsRegex = /data-options="([^"]+)"/i;
	const match = dataOptionsRegex.exec(html);
	if (match) {
		try {
			const decoded = htmlDecode(match[1]);
			const jsonOpts = JSON.parse(decoded);
			const metadataStr = jsonOpts.flashvars?.metadata || jsonOpts.metadata;
			if (metadataStr) {
				return JSON.parse(decodeURIComponent(metadataStr));
			}
		} catch (e) {}
	}

	// Método 2: Buscar variables incrustadas directamente en scripts de la página (otkPlayerVars / binf)
	const scriptRegex = /(\{.*ansamble.*\}|dwrap\.context\.player.*?\})/i;
	// Patrón alternativo genérico para extraer JSON incrustado de videos en OK.ru
	const altJsonRegex = /player\.setOptions\s*\(\s*(\{.+?\})\s*\)\s*;/i;
	const altMatch = altJsonRegex.exec(html);
	if (altMatch) {
		try {
			const opts = JSON.parse(altMatch[1]);
			if (opts.flashvars?.metadata) {
				return JSON.parse(decodeURIComponent(opts.flashvars.metadata));
			}
		} catch (e) {}
	}

	return null;
}

function buildVideoSources(metadata) {
	const sources = [];

	// Extraer videos en formato progresivo (MP4)
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

	// Añadir soporte HLS si está disponible
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
