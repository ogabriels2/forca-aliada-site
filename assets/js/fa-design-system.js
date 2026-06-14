(() => {
  'use strict';
  const page = location.pathname.split('/').pop()?.replace('.html','') || 'index';
  document.body.dataset.faPage = page;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const haptic = type => {
    if (reduce.matches || localStorage.getItem('fa_haptics') === 'off') return;
    const patterns = { light:[8],medium:[20],heavy:[40],success:[10,60,10],warning:[20,40,20],error:[40,20,40,20],soft:[5] };
    try { navigator.vibrate?.(patterns[type] || patterns.light); } catch {}
  };
  window.FAHaptics = { trigger:haptic };

  const hint = document.createElement('div');
  hint.className = 'fa-gesture-hint';
  hint.setAttribute('aria-live','polite');
  document.body.appendChild(hint);
  let hintTimer;
  window.FAGestureHint = text => {
    hint.textContent = text;
    hint.classList.add('show');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => hint.classList.remove('show'), 1150);
  };

  const reveal = 'IntersectionObserver' in window ? new IntersectionObserver(entries => entries.forEach(entry => {
    if (!entry.isIntersecting) return;
    entry.target.classList.add('is-revealed');
    reveal.unobserve(entry.target);
  }), { rootMargin:'80px 0px', threshold:.05 }) : null;
  document.querySelectorAll('.reveal,.feature-card,.stat-item,.account-card,.profile-card').forEach((node,index) => {
    node.classList.add('fa-reveal');
    node.style.setProperty('animation-delay',`${Math.min(index % 6,5) * 55}ms`);
    if (reveal) reveal.observe(node);
    else node.classList.add('is-revealed');
  });

  document.addEventListener('click', event => {
    const target = event.target.closest('.btn-secondary,.btn-ghost,.tbtn,.pa,.follow-btn,.header-pill');
    if (!target || reduce.matches) return;
    const rect = target.getBoundingClientRect();
    const size = Math.max(rect.width,rect.height);
    const ripple = document.createElement('span');
    ripple.className = 'fa-ripple';
    Object.assign(ripple.style,{width:`${size}px`,height:`${size}px`,left:`${event.clientX-rect.left-size/2}px`,top:`${event.clientY-rect.top-size/2}px`});
    target.style.position = 'relative';
    target.style.overflow = 'hidden';
    target.appendChild(ripple);
    ripple.addEventListener('animationend',() => ripple.remove(),{once:true});
  });

  const likeBurst = button => {
    const rect = button.getBoundingClientRect();
    const root = document.createElement('span');
    root.className = 'fa-like-particles';
    root.style.cssText = `left:${rect.left + rect.width / 2}px;top:${rect.top + rect.height / 2}px`;
    root.innerHTML = Array.from({length:8},(_,i)=>`<i style="--a:${i * 45}deg;--d:${34 + Math.random() * 20}px"></i>`).join('');
    document.body.appendChild(root);
    setTimeout(()=>root.remove(),650);
  };
  document.addEventListener('click', event => {
    const like = event.target.closest('.pa-like');
    if (like) setTimeout(() => { if (like.classList.contains('is-on')) likeBurst(like); }, 0);
    const save = event.target.closest('.pa-save');
    if (save) {
      save.classList.remove('popping');
      void save.offsetWidth;
      save.classList.add('popping');
      setTimeout(()=>save.classList.remove('popping'),420);
    }
    const toast = event.target.closest('.toast');
    if (toast && !event.target.closest('button,a')) {
      toast.classList.add('leaving');
      setTimeout(()=>toast.remove(),200);
    }
  }, true);

  const tabs = document.querySelector('.feed-tabs');
  if (tabs) {
    const indicator = document.createElement('span');
    indicator.className = 'tabs-indicator';
    tabs.prepend(indicator);
    const syncIndicator = () => {
      const active = tabs.querySelector('.tab.is-active,[aria-selected=true]');
      if (!active) return;
      indicator.style.width = `${active.offsetWidth}px`;
      indicator.style.transform = `translateX(${active.offsetLeft}px)`;
    };
    syncIndicator();
    new MutationObserver(syncIndicator).observe(tabs,{attributes:true,subtree:true,attributeFilter:['class','aria-selected']});
    addEventListener('resize',syncIndicator,{passive:true});
  }

  const decorateSheets = root => {
    const sheets = [...(root.matches?.('.sheet') ? [root] : []), ...(root.querySelectorAll?.('.sheet') || [])];
    sheets.forEach(sheet => {
    if (sheet.querySelector(':scope > .sheet-handle')) return;
    const handle = document.createElement('div');
    handle.className = 'sheet-handle';
    handle.setAttribute('aria-hidden','true');
    sheet.prepend(handle);
    let startY=0,currentY=0,dragging=false,startAt=0;
    handle.addEventListener('touchstart',e=>{ if(innerWidth>720)return;startY=e.touches[0].clientY;startAt=Date.now();dragging=true;sheet.style.transition='none'; },{passive:true});
    handle.addEventListener('touchmove',e=>{ if(!dragging)return;currentY=Math.max(0,e.touches[0].clientY-startY);sheet.style.transform=`translateY(${currentY}px)`; },{passive:true});
    handle.addEventListener('touchend',()=>{ if(!dragging)return;dragging=false;sheet.style.transition='';const fast=currentY/Math.max(1,Date.now()-startAt)>.65;if(fast||currentY>sheet.offsetHeight*.32){haptic('medium');sheet.closest('.backdrop')?.click();}sheet.style.transform='';currentY=0; },{passive:true});
  });
  };
  decorateSheets(document);
  new MutationObserver(records => records.forEach(record => record.addedNodes.forEach(node => node.nodeType===1 && decorateSheets(node)))).observe(document.body,{childList:true,subtree:true});

  let postPress = null;
  document.addEventListener('pointerdown', event => {
    const card = event.target.closest('.post-card');
    if (!card || event.target.closest('button,a,input,textarea,.post-media')) return;
    const x = event.clientX, y = event.clientY;
    postPress = { card, x, y, timer:setTimeout(() => {
      const menu = card.querySelector('.more-btn');
      if (menu && typeof window.openPostMenu === 'function') {
        haptic('medium');
        window.openPostMenu(menu);
        window.FAGestureHint?.('Menu do post aberto');
      }
      postPress = null;
    },520) };
  },{passive:true});
  document.addEventListener('pointermove',event=>{if(postPress&&Math.hypot(event.clientX-postPress.x,event.clientY-postPress.y)>10){clearTimeout(postPress.timer);postPress=null;}},{passive:true});
  document.addEventListener('pointerup',()=>{if(postPress){clearTimeout(postPress.timer);postPress=null;}},{passive:true});
  document.addEventListener('pointercancel',()=>{if(postPress){clearTimeout(postPress.timer);postPress=null;}},{passive:true});

  let mediaTap = { at:0, node:null };
  document.addEventListener('touchend', event => {
    const media = event.target.closest('.post-media');
    if (!media) return;
    const now = Date.now();
    if (mediaTap.node === media && now - mediaTap.at < 300) {
      const like = media.closest('.post-card')?.querySelector('.pa-like');
      if (like && !like.classList.contains('is-on')) like.click();
      if (like) likeBurst(like);
      haptic('light');
      event.preventDefault();
    }
    mediaTap = { at:now,node:media };
  },{passive:false});

  document.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const dialog = [...document.querySelectorAll('.backdrop.show [role=dialog],.story-viewer:not([hidden])')].pop();
    if (!dialog) return;
    const focusable = [...dialog.querySelectorAll('button:not([disabled]),a[href],input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])')].filter(node=>node.offsetParent!==null);
    if (!focusable.length) return;
    const first=focusable[0],last=focusable[focusable.length-1];
    if (event.shiftKey && document.activeElement===first) { event.preventDefault();last.focus(); }
    else if (!event.shiftKey && document.activeElement===last) { event.preventDefault();first.focus(); }
  });

  let lastY=scrollY;
  addEventListener('scroll',() => {
    if(page!=='index')return;
    const header=document.querySelector('header');
    header?.classList.toggle('fa-header-hidden',scrollY>lastY && scrollY>120);
    lastY=scrollY;
  },{passive:true});
  if(page==='index' && matchMedia('(pointer:fine)').matches) {
    const hero=document.querySelector('.hero'),bg=document.querySelector('.hero-bg');
    hero?.addEventListener('pointermove',e=>{const r=hero.getBoundingClientRect();bg.style.transform=`scale(1.025) translate(${(e.clientX-r.left-r.width/2)/r.width*-8}px,${(e.clientY-r.top-r.height/2)/r.height*-6}px)`;});
    hero?.addEventListener('pointerleave',()=>{bg.style.transform='';});
  }

  let edge=null;
  addEventListener('touchstart',e=>{const t=e.touches[0];edge=t&&t.clientX<24?{x:t.clientX,y:t.clientY,time:Date.now()}:null;},{passive:true});
  addEventListener('touchend',e=>{if(!edge||!e.changedTouches[0])return;const t=e.changedTouches[0],dx=t.clientX-edge.x,dy=Math.abs(t.clientY-edge.y);if(dx>innerWidth*.34&&dy<90&&Date.now()-edge.time<650){haptic('medium');history.back();}edge=null;},{passive:true});
})();
