export function installVirtualWindow(list, options = {}) {
  if (!list) return;
  list._v2Virtual?.destroy?.();

  const selector = options.selector || ':scope > *';
  const rowHeight = options.rowHeight || 76;
  const overscan = options.overscan || 8;
  const minItems = options.minItems || 80;
  const allItems = [...list.querySelectorAll(selector)];
  const items = allItems.filter((item) => item.dataset.v2FilterVisible !== '0');
  if (items.length < minItems) return;

  const top = document.createElement('li');
  const bottom = document.createElement('li');
  top.className = bottom.className = 'v2-virtual-spacer';
  top.setAttribute('aria-hidden', 'true');
  bottom.setAttribute('aria-hidden', 'true');

  let frame = 0;
  const scrollRoot = list.closest('.dashboard-card-active') || document.scrollingElement;
  const render = () => {
    frame = 0;
    const listTop = list.getBoundingClientRect().top + (scrollRoot.scrollTop || window.scrollY);
    const viewportTop = scrollRoot === document.scrollingElement ? window.scrollY : scrollRoot.scrollTop;
    const viewportHeight = scrollRoot === document.scrollingElement ? window.innerHeight : scrollRoot.clientHeight;
    const start = Math.max(0, Math.floor((viewportTop - listTop) / rowHeight) - overscan);
    const end = Math.min(items.length, Math.ceil((viewportTop - listTop + viewportHeight) / rowHeight) + overscan);
    top.style.height = `${start * rowHeight}px`;
    bottom.style.height = `${Math.max(0, (items.length - end) * rowHeight)}px`;
    list.replaceChildren(top, ...items.slice(start, end), bottom);
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(render); };
  scrollRoot.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule, { passive: true });
  list.classList.add('v2-virtual-list');
  list._v2Virtual = {
    destroy() {
      if (frame) cancelAnimationFrame(frame);
      scrollRoot.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      list.classList.remove('v2-virtual-list');
      list.replaceChildren(...allItems);
    },
  };
  render();
}

export function groupTimelineByHour(logs = []) {
  return logs.reduce((groups, log) => {
    const date = new Date(log.created_at || log.time);
    const key = Number.isNaN(date.getTime()) ? 'Sem data' : new Intl.DateTimeFormat('pt-BR', {
      dateStyle: 'medium',
      hour: '2-digit',
    }).format(date);
    const group = groups.find((item) => item.label === key);
    if (group) group.logs.push(log);
    else groups.push({ label: key, logs: [log] });
    return groups;
  }, []);
}
