const PLATFORM = "OkRu";
const BASE_URL = "https://ok.ru";

const REGEX_VIDEO_URL = /ok\.ru\/(?:video|videoembed|live)\/(\d+)/i;
const REGEX_DATA_OPTIONS = /data-module="OKVideo"[^>]*data-options="([^"]+)"/i;

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
	// Usamos la ruta alternativa de búsqueda compatible con web móvil
	const url = `${BASE_URL}/dk?cmd=videoSearch&st.query=${encodeURIComponent(query)}&_aid=videoSearch`;

	const resp = http.GET(url, {
		"User-Agent": "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
		"Accept": "text/html,application/xhtml+xml,xml"
	}, false);
	
	if (!resp.isOk) {
		throw new ScriptException(`Búsqueda falló (HTTP ${resp.code}) para "${query}"`);
	}

	const parser = new DOMParser();
	const doc = parser.parseFromString(resp.body, "text/html");
	const items = [];

	// Extraer resultados parseando el HTML de la busqueda de OK.ru
	const videoCards = doc.querySelectorAll(".video-card, .c-v-card");
	if (videoCards) {
		for (let i = 0; i < videoCards.length; i++) {
			const card = videoCards[i];
			const linkElem = card.querySelector("a.video-card_link, a");
			if (!linkElem) continue;
			
			const href = linkElem.getAttribute("href") || "";
			const match = REGEX_VIDEO_URL.exec(href);
			if (!match) continue;

			const videoId = match[1];
			const titleElem = card.querySelector(".video-card_n, .video-card-title");
			const title = titleElem ? titleElem.textContent.trim() : "Video de OK.ru";
			
			const imgElem = card.querySelector("img");
			const thumbnail = imgElem ? (imgElem.getAttribute("src") || imgElem.getAttribute("data-src") || "") : "";

			items.push(new PlatformVideo({
				id: new PlatformID(PLATFORM, String(videoId), plugin.config.id),
				name: title,
				thumbnails: new Thumbnails([new Thumbnail(thumbnail, 0)]),
				author: new PlatformAuthorLink(
					new PlatformID(PLATFORM, "unknown", plugin.config.id),
					"OK.ru",
					BASE_URL,
					""
				),
				datetime: 0,
				duration: 0,
				viewCount: 0,
				url: `${BASE_URL}/video/${videoId}`,
				isLive: false
			}));
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

	// Forzar la URL de incrustación (embed) que es mucho más estable para extraer streams sin bloqueos de sesión completos
	const embedUrl = `${BASE_URL}/videoembed/${videoId}`;
	
	const resp = http.GET(embedUrl, {
		"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
		"Referer": BASE_URL
	}, false);

	if (!resp.isOk) {
		throw new ScriptException(`No se pudo cargar la página del video (HTTP ${resp.code})`);
	}

	let metadata = parseOkRuMetadata(resp.body);
	
	// Si falla en el embed, intentamos con la URL original
	if (!metadata) {
		const respFull = http.GET(url, {
			"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
		}, false);
		if (respFull.isOk) {
			metadata = parseOkRuMetadata(respFull.body);
		}
	}

	if (!metadata) {
		throw new ScriptException("No se pudo extraer la metadata del video de OK.ru. Estructura cambiada.");
	}

	const movie = metadata.movie || {};
	const author = metadata.author || {};

	const title = movie.title || "Video de OK.ru";
	const thumbnailUrl = movie.poster || "";
	const duration = Math.round(movie.duration || 0);
	const isLive = movie.type === "LIVE" || !!metadata.isLive;

	const videoSources = buildVideoSources(metadata);
	if (videoSources.length === 0) {
		throw new ScriptException("No se encontraron URLs de video reproducibles.");
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

function parseOkRuMetadata(html) {
	let optionsMatch = REGEX_DATA_OPTIONS.exec(html);
	if (!optionsMatch) {
		// Búsqueda alternativa de JSON incrustado en variable de reproductor si data-options no está presente
		const altMatch = /\"metadata"\s*:\s*("[^"]+")/.exec(html);
		if (altMatch) {
			try {
				return JSON.parse(JSON.parse(altMatch[1]));
			} catch (e) { }
		}
		return null;
	}

	const decodedOptions = htmlDecode(optionsMatch[1]);
	let options;
	try {
		options = JSON.parse(decodedOptions);
	} catch (e) {
		return null;
	}

	const flashvars = options.flashvars || options;
	if (!flashvars || !flashvars.metadata) {
		return null;
	}

	let metadataStr = flashvars.metadata;
	try {
		metadataStr = decodeURIComponent(metadataStr);
	} catch (e) { }

	try {
		return JSON.parse(metadataStr);
	} catch (e) {
		return null;
	}
}

function buildVideoSources(metadata) {
	const sources = [];

	(metadata.videos || []).forEach(v => {
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
