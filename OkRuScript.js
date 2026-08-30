const PLATFORM = "OkRu";
const BASE_URL = "https://ok.ru";

const REGEX_VIDEO_URL =
	/ok\.ru\/(?:video|videoembed|live|movie)\/(\d+)/i;

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


/* ============================================================
 * BUSQUEDA
 * ============================================================ */

source.search = function (query, type, order, filters) {

	const url =
		`${BASE_URL}/video/search?st.query=${encodeURIComponent(query)}`;

	const resp = http.GET(url, {
		"Accept": "text/html"
	}, false);

	const items = [];

	if (!resp || !resp.isOk || !resp.body) {
		log("[OK.ru] error HTTP en búsqueda");
		return new OkRuVideoPager([], false);
	}

	try {

		const html = resp.body;

		/*
		 * Buscamos enlaces reales /video/XXXXXXXX
		 */

		const regex =
			/(?:href|data-href)=["']([^"']*\/video\/(\d+)[^"']*)["']/gi;

		const seen = {};

		let match;

		while ((match = regex.exec(html)) !== null) {

			const videoId = match[2];

			if (!videoId || seen[videoId]) {
				continue;
			}

			seen[videoId] = true;

			let videoUrl = match[1];

			videoUrl = htmlDecode(videoUrl);

			if (videoUrl.indexOf("http") !== 0) {

				if (videoUrl.charAt(0) !== "/") {
					videoUrl = "/" + videoUrl;
				}

				videoUrl = BASE_URL + videoUrl;
			}

			items.push(
				new PlatformVideo({
					id: new PlatformID(
						PLATFORM,
						videoId,
						plugin.config.id
					),

					name:
						"Video de OK.ru (" +
						videoId +
						")",

					thumbnails:
						new Thumbnails([]),

					author:
						new PlatformAuthorLink(
							new PlatformID(
								PLATFORM,
								"unknown",
								plugin.config.id
							),

							"OK.ru",

							BASE_URL,

							""
						),

					datetime: 0,

					duration: 0,

					viewCount: 0,

					url: videoUrl,

					isLive: false
				})
			);
		}

		log(
			"[OK.ru] resultados encontrados: " +
			items.length
		);

	} catch (e) {

		log(
			"[OK.ru] error parseando búsqueda: " +
			e
		);
	}

	return new OkRuVideoPager(
		items,
		false
	);
};


/* ============================================================
 * DETECCION DE URL
 * ============================================================ */

source.isContentDetailsUrl = function (url) {
	return REGEX_VIDEO_URL.test(url);
};


/* ============================================================
 * DETALLES DEL VIDEO
 * ============================================================ */

source.getContentDetails = function (url) {

	const match =
		REGEX_VIDEO_URL.exec(url);

	if (!match) {
		throw new ScriptException(
			"URL de video de OK.ru no reconocida: " +
			url
		);
	}

	const videoId = match[1];

	log(
		"[OK.ru] obteniendo video: " +
		videoId
	);


	/*
	 * Primero obtenemos la página real.
	 */

	const resp = http.GET(url, {
		"Accept":
			"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
	}, false);

	if (!resp || !resp.isOk || !resp.body) {

		throw new ScriptException(
			"[OK.ru] No se pudo obtener la página"
		);
	}

	const html = resp.body;


	/*
	 * ------------------------------------------------------------
	 * METADATA DIRECTA
	 * ------------------------------------------------------------
	 */

	let metadata =
		parseMetadataFromHtml(html);


	/*
	 * ------------------------------------------------------------
	 * METADATA URL
	 * ------------------------------------------------------------
	 */

	if (!metadata) {

		const metadataUrl =
			parseMetadataUrlFromHtml(html);

		if (metadataUrl) {

			log(
				"[OK.ru] metadataUrl encontrada"
			);

			metadata =
				requestMetadata(
					metadataUrl
				);
		}
	}


	if (!metadata) {

		throw new ScriptException(
			"[OK.ru] No se pudo obtener metadata de reproducción"
		);
	}


	/*
	 * ------------------------------------------------------------
	 * STREAMS
	 * ------------------------------------------------------------
	 */

	const sources =
		buildVideoSources(metadata);


	if (sources.length === 0) {

		throw new ScriptException(
			"[OK.ru] No se encontraron streams reproducibles"
		);
	}


	const title =
		getTitle(metadata) ||
		"Video de OK.ru (" +
		videoId +
		")";


	const duration =
		getDuration(metadata);


	return new PlatformVideoDetails({

		id:
			new PlatformID(
				PLATFORM,
				videoId,
				plugin.config.id
			),

		name:
			title,

		thumbnails:
			new Thumbnails([]),

		author:
			new PlatformAuthorLink(
				new PlatformID(
					PLATFORM,
					"unknown",
					plugin.config.id
				),

				"OK.ru",

				BASE_URL,

				""
			),

		datetime: 0,

		duration:
			duration,

		viewCount: 0,

		url: url,

		shareUrl: url,

		isLive:
			!!metadata.liveDashManifestUrl,

		video:
			new VideoSourceDescriptor(
				sources
			)
	});
};


/* ============================================================
 * EXTRAER METADATA
 * ============================================================ */

function parseMetadataFromHtml(html) {

	if (!html) {
		return null;
	}


	const patterns = [
		/data-options="([^"]+)"/i,
		/data-options='([^']+)'/i
	];


	let match = null;


	for (let i = 0; i < patterns.length; i++) {

		match =
			patterns[i].exec(html);

		if (match) {
			break;
		}
	}


	if (!match) {

		log(
			"[OK.ru] no se encontró data-options"
		);

		return null;
	}


	try {

		const decoded =
			htmlDecode(match[1]);


		const options =
			JSON.parse(decoded);


		if (
			options.flashvars &&
			options.flashvars.metadata
		) {

			const metadataText =
				safeDecode(
					options.flashvars.metadata
				);


			return JSON.parse(
				htmlDecode(metadataText)
			);
		}


		/*
		 * Algunos formatos pueden colocar metadata
		 * directamente en el objeto.
		 */

		if (options.metadata) {

			const metadataText =
				safeDecode(
					options.metadata
				);

			return JSON.parse(
				htmlDecode(metadataText)
			);
		}

	} catch (e) {

		log(
			"[OK.ru] error parseando metadata: " +
			e
		);
	}


	return null;
}


/* ============================================================
 * EXTRAER METADATA URL
 * ============================================================ */

function parseMetadataUrlFromHtml(html) {

	if (!html) {
		return null;
	}


	const patterns = [
		/data-options="([^"]+)"/i,
		/data-options='([^']+)'/i
	];


	let match = null;


	for (let i = 0; i < patterns.length; i++) {

		match =
			patterns[i].exec(html);

		if (match) {
			break;
		}
	}


	if (!match) {
		return null;
	}


	try {

		const decoded =
			htmlDecode(match[1]);


		const options =
			JSON.parse(decoded);


		if (
			options.flashvars &&
			options.flashvars.metadataUrl
		) {

			return safeDecode(
				options.flashvars.metadataUrl
			);
		}


		if (options.metadataUrl) {

			return safeDecode(
				options.metadataUrl
			);
		}

	} catch (e) {

		log(
			"[OK.ru] error leyendo metadataUrl: " +
			e
		);
	}


	return null;
}


/* ============================================================
 * OBTENER METADATA DESDE metadataUrl
 * ============================================================ */

function requestMetadata(metadataUrl) {

	if (!metadataUrl) {
		return null;
	}


	try {

		/*
		 * OK.ru utiliza POST para metadataUrl.
		 *
		 * Se mantiene la llamada simple para conservar
		 * compatibilidad con el paquete Http del plugin.
		 */

		const resp =
			http.POST(
				metadataUrl,
				{},
				"",
				false
			);


		if (
			!resp ||
			!resp.isOk ||
			!resp.body
		) {

			log(
				"[OK.ru] metadataUrl no respondió"
			);

			return null;
		}


		const body =
			htmlDecode(
				safeDecode(resp.body)
			);


		return JSON.parse(body);

	} catch (e) {

		log(
			"[OK.ru] error en metadataUrl: " +
			e
		);

		return null;
	}
}


/* ============================================================
 * CREAR SOURCES
 * ============================================================ */

function buildVideoSources(metadata) {

	const sources = [];


	if (!metadata) {
		return sources;
	}


	const duration =
		getDuration(metadata);


	/*
	 * ------------------------------------------------------------
	 * MP4
	 * ------------------------------------------------------------
	 */

	if (
		metadata.videos &&
		Array.isArray(metadata.videos)
	) {

		metadata.videos.forEach(
			function (video) {

				if (
					!video ||
					!video.url
				) {
					return;
				}


				const quality =
					video.name ||
					"mp4";


				const dimensions =
					qualityNameToDims(
						quality
					);


				log(
					"[OK.ru] MP4 " +
					quality
				);


				sources.push(
					new VideoUrlSource({

						name:
							quality,

						url:
							video.url,

						width:
							dimensions.width,

						height:
							dimensions.height,

						container:
							"video/mp4",

						codec:
							"h264",

						bitrate:
							Number(
								video.bitrate || 0
							),

						duration:
							duration
					})
				);
			}
		);
	}


	/*
	 * ------------------------------------------------------------
	 * HLS
	 * ------------------------------------------------------------
	 */

	let hlsUrl = null;


	if (
		metadata.hlsMasterPlaylistUrl
	) {

		hlsUrl =
			metadata.hlsMasterPlaylistUrl;

	} else if (
		metadata.hlsManifestUrl
	) {

		hlsUrl =
			metadata.hlsManifestUrl;
	}


	if (hlsUrl) {

		hlsUrl =
			safeDecode(hlsUrl);


		log(
			"[OK.ru] HLS encontrado"
		);


		sources.push(
			new HLSSource({

				name:
					"HLS",

				url:
					hlsUrl,

				duration:
					duration,

				priority:
					true
			})
		);
	}


	return sources;
}


/* ============================================================
 * TITULO
 * ============================================================ */

function getTitle(metadata) {

	if (!metadata) {
		return "";
	}


	if (
		metadata.movie &&
		typeof metadata.movie === "object"
	) {

		if (metadata.movie.title) {
			return metadata.movie.title;
		}

		if (metadata.movie.name) {
			return metadata.movie.name;
		}
	}


	return (
		metadata.title ||
		metadata.name ||
		""
	);
}


/* ============================================================
 * DURACION
 * ============================================================ */

function getDuration(metadata) {

	if (!metadata) {
		return 0;
	}


	if (
		metadata.movie &&
		typeof metadata.movie === "object" &&
		metadata.movie.duration
	) {

		return Math.round(
			Number(
				metadata.movie.duration
			)
		);
	}


	if (metadata.duration) {

		return Math.round(
			Number(
				metadata.duration
			)
		);
	}


	return 0;
}


/* ============================================================
 * RESOLUCION
 * ============================================================ */

function qualityNameToDims(name) {

	switch (name) {

		case "mobile":
			return {
				width: 320,
				height: 240
			};

		case "lowest":
			return {
				width: 426,
				height: 240
			};

		case "low":
			return {
				width: 640,
				height: 360
			};

		case "sd":
			return {
				width: 854,
				height: 480
			};

		case "hd":
			return {
				width: 1280,
				height: 720
			};

		case "full":
			return {
				width: 1920,
				height: 1080
			};

		case "quad":
			return {
				width: 2560,
				height: 1440
			};

		default:
			return {
				width: 0,
				height: 0
			};
	}
}


/* ============================================================
 * HTML DECODE
 * ============================================================ */

function htmlDecode(str) {

	if (!str) {
		return "";
	}


	return str
		.replace(/&quot;/g, "\"")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&#39;/g, "'");
}


/* ============================================================
 * URL DECODE
 * ============================================================ */

function safeDecode(value) {

	if (!value) {
		return value;
	}


	try {

		return decodeURIComponent(
			value
		);

	} catch (e) {

		return value;
	}
}


/* ============================================================
 * PAGER
 * ============================================================ */

class OkRuVideoPager extends VideoPager {

	constructor(
		results,
		hasMore,
		context
	) {

		super(
			results,
			hasMore,
			context ?? {}
		);
	}


	nextPage() {

		return new OkRuVideoPager(
			[],
			false,
			this.context
		);
	}
}
