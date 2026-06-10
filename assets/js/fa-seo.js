(() => {
  'use strict';

  const stabilize = root => {
    const scope = root?.querySelectorAll ? root : document;
    scope.querySelectorAll('a[target="_blank"]').forEach(link => {
      const rel = new Set((link.rel || '').split(/\s+/).filter(Boolean));
      rel.add('noopener');
      rel.add('noreferrer');
      link.rel = [...rel].join(' ');
    });

    scope.querySelectorAll('img').forEach(image => {
      if (!image.hasAttribute('decoding')) image.decoding = 'async';
      if (!image.hasAttribute('loading') && !image.hasAttribute('fetchpriority') && !image.closest('header,.topbar,.hero')) image.loading = 'lazy';
      const urlSize = image.currentSrc?.match(/\/(\d+)(?:\.png)?(?:\?|$)/)?.[1] || image.src?.match(/\/(\d+)(?:\.png)?(?:\?|$)/)?.[1];
      const classSize = image.matches('.profile-av,.avatar') ? 140
        : image.matches('.av42,.av42-sq') ? 42
          : image.matches('.mini-av,.preview-row-av') ? 32
            : 0;
      const mediaWidth = image.matches('.post-collage img,.comment-media-grid img,.media-grid img,.media-tile img,.lb-img') ? 1200 : 0;
      const mediaHeight = mediaWidth ? 675 : 0;
      const coverWidth = image.matches('.cover-img') ? 1600 : 0;
      const coverHeight = coverWidth ? 600 : 0;
      const width = Number(image.dataset.seoWidth || urlSize || classSize || mediaWidth || coverWidth || 0);
      const height = Number(image.dataset.seoHeight || urlSize || classSize || mediaHeight || coverHeight || 0);
      if (width && height) {
        if (!image.hasAttribute('width')) image.width = width;
        if (!image.hasAttribute('height')) image.height = height;
      }
    });
  };

  const analyticsId = document.querySelector('meta[name="google-analytics-id"]')?.content?.trim();
  if (/^G-[A-Z0-9]+$/i.test(analyticsId || '')) {
    window.dataLayer = window.dataLayer || [];
    window.gtag = window.gtag || function gtag() { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    window.gtag('config', analyticsId, { anonymize_ip: true });
    const script = document.createElement('script');
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(analyticsId)}`;
    document.head.append(script);
  }

  stabilize(document);
  new MutationObserver(records => records.forEach(record => {
    record.addedNodes.forEach(node => {
      if (node.nodeType === 1) stabilize(node);
    });
  })).observe(document.documentElement, { childList: true, subtree: true });
})();
