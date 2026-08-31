var source = {};

source.getHome = function() {
    return new VideoPager([], false);
};

source.search = function(query, type, order, filters) {
    const searchUrl = `https://ok.ru/search?st.mode=Video&st.query=${encodeURIComponent(query)}`;
    const resp = http.GET(searchUrl, {});
    
    if (!resp.isOk) return new VideoPager([], false);

    const dom = domParser.parseFromString(resp.body);
    let videos = [];
    const videoElements = dom.querySelectorAll('.video-card'); 
    
    for (let i = 0; i < videoElements.length; i++) {
        const node = videoElements[i];
        
        const linkNode = node.querySelector('a.video-card_lk');
        if (!linkNode) continue; 
        
        const href = linkNode.getAttribute('href');
        const videoId = href.split('/').pop();
        const videoUrl = "https://ok.ru/video/" + videoId;
        
        const titleNode = node.querySelector('.video-card_n');
        const title = titleNode ? titleNode.text.trim() : "Video";
        
        const imgNode = node.querySelector('img.photo_img');
        const thumbUrl = imgNode ? imgNode.getAttribute('src') : "";
        
        const authorNode = node.querySelector('.video-card_info_c > a, .ucard-v_info > a');
        const authorName = authorNode ? authorNode.text.trim() : "Desconocido";
        
        videos.push(new PlatformVideo({
            id: videoId,
            name: title,
            thumbnails: new Thumbnails([new Thumbnail(thumbUrl, 0)]),
            author: new PlatformAuthorLink(new PlatformID("OkRu", videoUrl, "Plugin"), authorName, "", ""),
            url: videoUrl,
            isLive: false
        }));
    }
    
    return new VideoPager(videos, false);
};

source.isChannelUrl = function(url) {
    return url.includes("ok.ru/profile/") || url.includes("ok.ru/group/");
};

source.getChannel = function(url) {
    throw new ScriptException("Canales no implementados");
};

source.isVideoDetailsUrl = function(url) {
    return url.includes("ok.ru/video/") || url.includes("ok.ru/videoembed/");
};

source.getVideoDetails = function(url) {
    const videoId = url.split('/').pop();
    const embedUrl = `https://ok.ru/videoembed/${videoId}`;
    
    const resp = http.GET(embedUrl, {});
    const html = resp.body;

    const optionsRegex = /data-options="([^"]+)"/;
    const match = html.match(optionsRegex);

    if (!match || match.length < 2) {
        throw new ScriptException("No se encontraron opciones de video en OK.ru");
    }

    const decodedOptions = match[1].replace(/&quot;/g, '"');
    const optionsData = JSON.parse(decodedOptions);
    const metadata = JSON.parse(optionsData.flashvars.metadata);

    let videoSources = [];
    if (metadata.videos && metadata.videos.length > 0) {
        metadata.videos.forEach(vid => {
            let quality = vid.name;
            videoSources.push(new VideoUrlSource({
                width: quality === 'hd' ? 1280 : (quality === 'sd' ? 854 : 640),
                height: quality === 'hd' ? 720 : (quality === 'sd' ? 480 : 360),
                container: "video/mp4",
                codec: "h264",
                name: quality.toUpperCase(),
                bitrate: 0,
                duration: metadata.movie.duration || 0,
                url: vid.url
            }));
        });
    }

    return new PlatformVideoDetails({
        id: videoId,
        name: metadata.movie.title,
        thumbnails: new Thumbnails([new Thumbnail(metadata.movie.poster, 0)]),
        author: new PlatformAuthorLink(new PlatformID("OkRu", "", "Plugin"), metadata.author.name, "", ""),
        datetime: 0,
        duration: metadata.movie.duration || 0,
        viewCount: metadata.movie.views || 0,
        isLive: false,
        description: metadata.movie.title,
        video: new VideoSourceDescriptor(videoSources)
    });
};

plugin.setSource(source);
