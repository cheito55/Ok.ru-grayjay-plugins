const PLATFORM = "OkRu";
const BASE_URL = "https://ok.ru";

// Reemplaza esta URL con la que te asigne Vercel al desplegar tu proyecto
const BRIDGE_API_URL = "https://TU-PROYECTO.vercel.app/api/okru";

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
	const resp = http.GET(url, { "Accept": "application/json" }, false);

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

	// Consultamos a nuestro servidor en Vercel para que extraiga los enlaces limpios
	const resp = http.GET(`${BRIDGE_API_URL}?id=${videoId}`, {
		"Accept": "application/json"
	}, false);

	if (!resp.isOk) {
		throw new ScriptException(`Error al conectar con el puente (HTTP ${resp.code})`);
	}

	let data;
	try {
		data = JSON.parse(resp.body);
	} catch (e) {
		throw new ScriptException("No se pudo parsear la respuesta del servidor puente.");
	}

	if (data.error) {
		throw new ScriptException("Error del servidor: " + data.error);
	}

	const videoSources = [];

	(data.videos || []).forEach(v => {
		if (!v.url) return;
		const dims = qualityNameToDims(v.name);
		videoSources.push(new VideoUrlSource({
			name: v.name || "mp4",
			url: v.url,
			width: dims.width,
			height: dims.height,
			container: "video/mp4",
			codec: "h264",
			bitrate: 0,
			duration: Math.round(data.duration || 0)
		}));
	});

	if (data.hlsManifestUrl) {
		videoSources.push(new HLSSource({
			name: "HLS",
			url: data.hlsManifestUrl,
			duration: Math.round(data.duration || 0),
			priority: true
		}));
	}

	if (videoSources.length === 0) {
		throw new ScriptException("No se encontraron fuentes de video reproducibles.");
	}

	return new PlatformVideoDetails({
		id: new PlatformID(PLATFORM, videoId, plugin.config.id),
		name: data.title || "Video de OK.ru",
		thumbnails: new Thumbnails([data.poster ? new Thumbnail(data.poster, 0) : null].filter(Boolean)),
		author: new PlatformAuthorLink(
			new PlatformID(PLATFORM, "unknown", plugin.config.id),
			"OK.ru",
			BASE_URL,
			""
		),
		datetime: 0,
		duration: Math.round(data.duration || 0),
		viewCount: 0,
		url: url,
		shareUrl: url,
		isLive: false,
		video: new VideoSourceDescriptor(videoSources)
	});
};

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

class OkRuVideoPager extends VideoPager {
	constructor(results, hasMore, context) {
		super(results, hasMore, context ?? {});
	}
	nextPage() {
		return new OkRuVideoPager([], false, this.context);
	}
}
