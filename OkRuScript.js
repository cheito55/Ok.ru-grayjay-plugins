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
	const proxyUrl = `https://corsproxy.io/?` + encodeURIComponent(url);

	const resp = http.GET(proxyUrl, {
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

	const videoSources = [
		new VideoUrlSource({
			name: "hd",
			url: `https://vd.mycdn.me/?video_id=${videoId}`,
			width: 1280,
			height: 720,
			container: "video/mp4",
			codec: "h264",
			bitrate: 0,
			duration: 0
		}),
		new VideoUrlSource({
			name: "sd",
			url: `https://vd.mycdn.me/?video_id=${videoId}`,
			width: 854,
			height: 480,
			container: "video/mp4",
			codec: "h264",
			bitrate: 0,
			duration: 0
		})
	];

	return new PlatformVideoDetails({
		id: new PlatformID(PLATFORM, videoId, plugin.config.id),
		name: "Video de OK.ru (" + videoId + ")",
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
