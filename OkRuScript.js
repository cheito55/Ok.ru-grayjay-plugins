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
		"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
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

	// Forzamos la petición al reproductor embebido con cabeceras de navegador de escritorio imitando una sesión limpia
	const embedUrl = `${BASE_URL}/videoembed/${videoId}`;
	const resp = http.GET(embedUrl, {
		"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
		"Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
		"Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
		"Referer": `${BASE_URL}/video/${videoId}`
	}, false);

	if (!resp.isOk) {
		throw new ScriptException(`No se pudo conectar con OK.ru (HTTP ${resp.code})`);
	}

	const html = resp.body;
	const metadata = parseMetadataFromHtml(html);

	// Si el método por HTML falla por completo, generamos un enlace de respaldo directo mediante HLS/MP4 genérico del CDN de MyCDN si el ID es válido
	let videoSources = [];
	let title = "Video de OK.ru (" + videoId + ")";
	let thumbnailUrl = "";
	let duration = 0;
	let authorName = "OK.ru";
	let authorId = "unknown";

	if (metadata) {
		const movie = metadata.movie || {};
		const author = metadata.author || {};
		title = movie.title || title;
		thumbnailUrl = movie.poster || "";
		duration = Math.round(movie.duration || 0);
		authorName = author.name || authorName;
		authorId = String(author.id || authorId);
		videoSources = buildVideoSources(metadata);
	}

	// RESPALDO DE EMERGENCIA: Si OK.ru bloqueó el JSON pero el ID es válido, 
	// inyectamos la estructura base para forzar al reproductor nativo de GrayJay a intentar la carga por enlace directo del CDN.
	if (videoSources.length === 0) {
		videoSources.push(new VideoUrlSource({
			name: "sd",
			url: `https://vd.mycdn.me/?video_id=${videoId}`,
			width: 854,
			height: 480,
			container: "video/mp4",
			codec: "h264",
			bitrate: 0,
			duration: 0
		}));
	}

	return new PlatformVideoDetails({
		id: new PlatformID(PLATFORM, videoId, plugin.config.id),
		name: title,
		thumbnails: new Thumbnails([thumbnailUrl ? new Thumbnail(thumbnailUrl, 0) : null].filter(Boolean)),
		author: new PlatformAuthorLink(
			new PlatformID(PLATFORM, authorId, plugin.config.id),
			authorName,
			BASE_URL,
			""
		),
		datetime: 0,
		duration: duration,
		viewCount: 0,
		url: url,
		shareUrl: url,
		isLive: false,
		video: new VideoSourceDescriptor(videoSources)
	});
};

function parseMetadataFromHtml(html) {
	if (!html) return null;

	// Búsqueda estricta de data-options
	const dataOptionsRegex = /data-options="([^"]+)"/i;
	let match = dataOptionsRegex.exec(html);
	
	if (!match) {
		// Intentar con comillas simples
		const altRegex = /data-options='([^']+)'/i;
		match = altRegex.exec(html);
	}

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

	// Búsqueda alternativa por bloque de script interno de variables de reproductor
	const scriptMatch = /player\.setOptions\s*\(\s*(\{.+?\})\s*\)\s*;/i.exec(html);
	if (scriptMatch) {
		try {
			const opts = JSON.parse(scriptMatch[1]);
			if (opts.flashvars?.metadata) {
				return JSON.parse(decodeURIComponent(opts.flashvars.metadata));
			}
		} catch (e) {}
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
