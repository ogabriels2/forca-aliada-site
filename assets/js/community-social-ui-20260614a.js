(() => {
  'use strict';

  document.body.classList.add('social-ui-v2');

  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const decorated = new WeakSet();
  const revealObserver = !reduceMotion && 'IntersectionObserver' in window
    ? new IntersectionObserver(entries => {
        entries.forEach(entry => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-visible');
          revealObserver.unobserve(entry.target);
        });
      }, { rootMargin: '90px 0px', threshold: .025 })
    : null;

  const selectors = [
    '#stories-shell',
    '#feed-list > .post-card',
    '.profile-hero',
    '.profile-about-card',
    '.profile-tab-content > *',
    '.thread-hero',
    '.comments-list > .comment-row',
  ].join(',');

  function decorate(root = document) {
    const nodes = [
      ...(root.matches?.(selectors) ? [root] : []),
      ...(root.querySelectorAll?.(selectors) || []),
    ];
    nodes.forEach((node, index) => {
      if (decorated.has(node)) return;
      decorated.add(node);
      node.classList.add('social-ui-reveal');
      node.style.setProperty('--social-delay', `${Math.min(index % 5, 4) * 42}ms`);
      if (revealObserver) revealObserver.observe(node);
      else node.classList.add('is-visible');
    });
  }

  decorate();
  new MutationObserver(records => {
    records.forEach(record => record.addedNodes.forEach(node => {
      if (node.nodeType === 1) decorate(node);
    }));
  }).observe(document.body, { childList: true, subtree: true });

  let scrollFrame = 0;
  addEventListener('scroll', () => {
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(() => {
      document.body.classList.toggle('social-scrolled', scrollY > 12);
      scrollFrame = 0;
    });
  }, { passive: true });

  const syncOpenSheet = () => {
    document.body.classList.toggle('social-sheet-open', Boolean(document.querySelector('.backdrop.show,.story-viewer:not([hidden])')));
  };
  new MutationObserver(syncOpenSheet).observe(document.body, {
    attributes: true,
    childList: true,
    subtree: true,
    attributeFilter: ['class', 'hidden'],
  });
  syncOpenSheet();
})();
