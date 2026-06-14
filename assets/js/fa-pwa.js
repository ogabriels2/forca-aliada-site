(() => {
  const script = document.currentScript;
  const app = script?.dataset?.faApp || 'main';
  const config = {
    main: {
      name: 'Força Aliada',
      title: 'Leve a Força Aliada com você',
      body: 'Abra o portal em uma janela própria e acesse tudo mais rápido.'
    },
    community: {
      name: 'FA Community',
      title: 'Instale a FA Community',
      body: 'Acesse o feed, perfis, conversas e notificações como um app.'
    },
    staff: {
      name: 'FA Staff',
      title: 'Instale a FA Staff',
      body: 'Abra o centro de comando e acompanhe a operação com mais agilidade.'
    }
  }[app] || null;

  if (!config || new URLSearchParams(location.search).has('preview')) return;

  const key = `fa_pwa_install_prompt_seen_${app}_v1`;
  const installedKey = `fa_pwa_installed_${app}_v1`;
  const sessionCountKey = `fa_pwa_session_count_${app}_v1`;
  const sessionMarkerKey = `fa_pwa_session_marked_${app}_v1`;
  const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  let deferredPrompt = null;
  let promptNode = null;
  if (!sessionStorage.getItem(sessionMarkerKey)) {
    sessionStorage.setItem(sessionMarkerKey, '1');
    localStorage.setItem(sessionCountKey, String(Number(localStorage.getItem(sessionCountKey) || 0) + 1));
  }
  const isEligibleSession = () => Number(localStorage.getItem(sessionCountKey) || 0) >= 3;

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('service-worker.js', { scope: './' }).catch(() => {}));
  }

  if (isStandalone) {
    localStorage.setItem(installedKey, '1');
    return;
  }

  const closePrompt = () => {
    promptNode?.remove();
    promptNode = null;
  };

  const styles = `
    .fa-install-card{position:fixed;right:18px;bottom:18px;z-index:2147482000;width:min(390px,calc(100vw - 24px));display:grid;grid-template-columns:44px minmax(0,1fr) auto;gap:12px;align-items:center;padding:13px;border:1px solid rgba(255,255,255,.13);border-radius:18px;background:rgba(8,16,29,.96);color:#eef3ff;box-shadow:0 22px 70px rgba(0,0,0,.38);backdrop-filter:blur(22px) saturate(150%);font-family:Outfit,Inter,system-ui,sans-serif;animation:faInstallIn .35s cubic-bezier(.2,.8,.2,1)}
    .fa-install-card img{width:44px;height:44px;border-radius:12px}
    .fa-install-copy{min-width:0}.fa-install-copy strong{display:block;font-size:13px;line-height:1.2}.fa-install-copy span{display:block;margin-top:3px;color:#a8bacc;font-size:11px;line-height:1.35}
    .fa-install-actions{display:flex;align-items:center;gap:5px}.fa-install-actions button{border:0;border-radius:10px;padding:9px 11px;font:750 11px/1 Outfit,Inter,system-ui,sans-serif;cursor:pointer}
    .fa-install-yes{background:#4e8fff;color:#fff}.fa-install-no{width:32px;height:32px;padding:0!important;background:rgba(255,255,255,.07);color:#a8bacc;font-size:16px!important}
    .fa-install-help{grid-column:2/-1;display:none;margin-top:1px;padding:9px 10px;border-radius:10px;background:rgba(78,143,255,.1);color:#c9dbef;font-size:11px;line-height:1.45}
    .fa-install-help.show{display:block}
    @keyframes faInstallIn{from{opacity:0;transform:translateY(12px) scale(.98)}to{opacity:1;transform:none}}
    @media(max-width:620px){.fa-install-card{left:12px;right:12px;bottom:78px;width:auto}.fa-install-card{grid-template-columns:40px minmax(0,1fr) auto}.fa-install-card img{width:40px;height:40px}}
  `;

  const showPrompt = () => {
    if (!isEligibleSession() || promptNode || localStorage.getItem(key) || localStorage.getItem(installedKey)) return;
    localStorage.setItem(key, new Date().toISOString());
    if (!document.getElementById('fa-install-style')) {
      const style = document.createElement('style');
      style.id = 'fa-install-style';
      style.textContent = styles;
      document.head.appendChild(style);
    }
    promptNode = document.createElement('aside');
    promptNode.className = 'fa-install-card';
    promptNode.setAttribute('aria-label', `Instalar ${config.name}`);
    promptNode.innerHTML = `
      <img src="assets/images/app-icons/icon-192.png" alt="">
      <div class="fa-install-copy"><strong>${config.title}</strong><span>${config.body}</span></div>
      <div class="fa-install-actions">
        <button type="button" class="fa-install-yes">${isIos ? 'Como instalar' : 'Instalar'}</button>
        <button type="button" class="fa-install-no" aria-label="Não mostrar novamente">×</button>
      </div>
      <div class="fa-install-help">No Safari, toque em <strong>Compartilhar</strong> e depois em <strong>Adicionar à Tela de Início</strong>.</div>
    `;
    document.body.appendChild(promptNode);
    promptNode.querySelector('.fa-install-no')?.addEventListener('click', closePrompt);
    promptNode.querySelector('.fa-install-yes')?.addEventListener('click', async () => {
      if (isIos || !deferredPrompt) {
        promptNode.querySelector('.fa-install-help')?.classList.add('show');
        return;
      }
      await deferredPrompt.prompt();
      await deferredPrompt.userChoice.catch(() => null);
      deferredPrompt = null;
      closePrompt();
    });
  };

  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    deferredPrompt = event;
    setTimeout(showPrompt, 10000);
  });

  window.addEventListener('appinstalled', () => {
    localStorage.setItem(installedKey, '1');
    closePrompt();
  });

  if (isIos) setTimeout(showPrompt, 12000);
})();
