(() => {
  'use strict';

  document.body.classList.add('social-refinement-v3');

  function safeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function compactDiscoveryMarkup() {
    const trends = [...document.querySelectorAll('#trending-list .trend-item')]
      .slice(0, 3)
      .map(item => `<span>${safeText(item.querySelector('.hashtag')?.textContent || item.textContent)}</span>`)
      .join('');
    const serverCopy = safeText(document.querySelector('#server-live-pill-copy')?.textContent) || 'Verificando servidor';
    const serverDetail = safeText(document.querySelector('#server-live-copy')?.textContent) || 'O estado ao vivo está sendo atualizado.';

    return `
      <article class="compact-tool-card compact-tool-server">
        <small>Pulso ao vivo</small>
        <strong><i></i>${serverCopy}</strong>
        <p>${serverDetail}</p>
        <button type="button" data-compact-server>Ver estado</button>
      </article>
      <article class="compact-tool-card">
        <small>Descobrir</small>
        <strong>Encontre pessoas e conversas</strong>
        <button type="button" data-open-search-page>Abrir busca</button>
      </article>
      <article class="compact-tool-card compact-tool-trends">
        <small>Em alta</small>
        <strong>${trends || '<span>Conversas da comunidade</span>'}</strong>
        <button type="button" data-filter="trending">Ver assuntos</button>
      </article>`;
  }

  function syncCompactDiscovery() {
    const stories = document.querySelector('#stories-shell');
    if (!stories) return;
    let shell = document.querySelector('#compact-social-discovery');
    if (!shell) {
      shell = document.createElement('section');
      shell.id = 'compact-social-discovery';
      shell.className = 'compact-social-discovery';
      shell.setAttribute('aria-label', 'Descobrir na comunidade');
    }
    if (stories.nextElementSibling !== shell) stories.insertAdjacentElement('afterend', shell);
    shell.innerHTML = compactDiscoveryMarkup();
  }

  document.addEventListener('click', event => {
    const serverButton = event.target.closest('[data-compact-server]');
    if (serverButton) {
      const card = serverButton.closest('.compact-tool-server');
      card?.classList.toggle('is-expanded');
      serverButton.textContent = card?.classList.contains('is-expanded') ? 'Recolher' : 'Ver estado';
    }
  });

  function openProfileCover(url, label) {
    document.querySelector('.profile-cover-viewer')?.remove();
    const viewer = document.createElement('div');
    viewer.className = 'profile-cover-viewer';
    viewer.setAttribute('role', 'dialog');
    viewer.setAttribute('aria-modal', 'true');
    viewer.setAttribute('aria-label', label);
    viewer.innerHTML = `<button type="button" aria-label="Fechar capa">×</button><img src="${url}" alt="${label}">`;
    viewer.addEventListener('click', event => {
      if (event.target === viewer || event.target.closest('button')) viewer.remove();
    });
    document.body.appendChild(viewer);
    viewer.querySelector('button')?.focus();
  }

  document.addEventListener('click', event => {
    const cover = event.target.closest('.profile-cover[data-lb-open]');
    if (!cover) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    openProfileCover(cover.dataset.lbUrl, cover.getAttribute('aria-label') || 'Capa completa');
  }, true);

  document.addEventListener('keydown', event => {
    const cover = event.target.closest?.('.profile-cover[data-lb-open]');
    if (cover && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      cover.click();
    }
    if (event.key === 'Escape') document.querySelector('.profile-cover-viewer')?.remove();
  });

  addEventListener('pointerdown', event => {
    document.body.dataset.inputMode = event.pointerType === 'mouse' ? 'mouse' : 'touch';
  }, { passive: true });

  const compactObserver = new MutationObserver(records => {
    if (records.some(record => [...record.addedNodes].some(node =>
      node.nodeType === 1 && (node.matches?.('#stories-shell,#trending-list,#server-live-pill-copy') || node.querySelector?.('#stories-shell,#trending-list,#server-live-pill-copy'))
    ))) syncCompactDiscovery();
  });
  compactObserver.observe(document.body, { childList: true, subtree: true });

  syncCompactDiscovery();
  setTimeout(syncCompactDiscovery, 1200);
  setTimeout(syncCompactDiscovery, 5000);
})();
