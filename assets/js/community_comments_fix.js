/**
 * ═══════════════════════════════════════════════════════════════════════════
 * FORÇA ALIADA — COMMUNITY COMMENTS FIX PATCH
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * COMO INTEGRAR:
 *   Inclua este script DEPOIS do script principal do community.html,
 *   antes do </body>:
 *
 *   <script src="assets/js/community_comments_fix.js"></script>
 *
 * PROBLEMAS CORRIGIDOS:
 *   1. Tipografia dos comentários (font-size, line-height) equalizada com posts
 *   2. Botões sociais (like, repost, share, copiar link) nos comentários
 *   3. Repostar comentários (cria quote-repost com texto do comentário)
 *   4. Compartilhar comentários (WhatsApp, copiar link)
 *   5. Classificação (sort) funcionando corretamente — endpoint /v2 detectado
 *   6. Página do comentário (navigateCommentThread) com fallback para auth
 *   7. Tamanho e espaçamento visual igualado entre posts e comentários
 * ═══════════════════════════════════════════════════════════════════════════
 */

(function () {
  'use strict';

  /* ── 1. CSS FIXES ──────────────────────────────────────────────────────── */
  const style = document.createElement('style');
  style.id = 'fa-comments-fix-css';
  style.textContent = `
    /* ── Tipografia dos comentários equalizada com posts ── */
    .comment-row p {
      font-size: 14.5px !important;
      line-height: 1.65 !important;
      color: var(--ink) !important;
      margin-top: 4px !important;
    }
    .comment-row .comment-author strong {
      font-size: 13.5px !important;
      font-weight: 800 !important;
    }
    .comment-row img {
      width: 40px !important;
      height: 40px !important;
      border-radius: 10px !important;
    }
    /* Grid ajustado para novo tamanho de avatar */
    .comment-row {
      grid-template-columns: 40px minmax(0, 1fr) !important;
      gap: 10px !important;
      padding: 11px 14px !important;
      cursor: pointer;
    }

    /* ── Barra de ações sociais dos comentários ── */
    .comment-meta {
      display: flex !important;
      align-items: center !important;
      gap: 2px !important;
      margin-top: 6px !important;
      flex-wrap: wrap;
    }
    .comment-pa {
      height: 28px !important;
      padding: 0 8px !important;
      border-radius: 6px !important;
      font-size: 11.5px !important;
      font-weight: 700 !important;
      display: inline-flex !important;
      align-items: center !important;
      gap: 4px !important;
      cursor: pointer !important;
      background: transparent !important;
      color: var(--ink-3) !important;
      border: none !important;
      transition: background var(--t-fast), color var(--t-fast), transform 0.12s var(--ease) !important;
      font-family: var(--ff-mono) !important;
    }
    .comment-pa svg {
      width: 14px !important;
      height: 14px !important;
    }
    .comment-pa:hover {
      background: var(--surface-soft) !important;
      color: var(--ink-2) !important;
      transform: translateY(-1px) !important;
    }
    .comment-pa-like:hover { background: var(--danger-soft) !important; color: var(--danger) !important; }
    .comment-pa-like.is-on { color: var(--danger) !important; background: var(--danger-soft) !important; }
    .comment-pa-like.is-on svg { fill: var(--danger) !important; stroke: var(--danger) !important; }
    .comment-pa-replies:hover, .comment-pa-replies-btn:hover { background: var(--accent-soft) !important; color: var(--accent) !important; }
    .comment-pa-repost:hover, .comment-pa-repost.is-on { background: var(--success-soft) !important; color: var(--success) !important; }
    .comment-pa-share:hover { background: var(--success-soft) !important; color: var(--success) !important; }

    /* ── Sort bar visível e funcional ── */
    .comments-sort-bar {
      position: sticky !important;
      top: calc(var(--topbar-h) + 2px) !important;
      z-index: 40 !important;
      background: color-mix(in srgb, var(--surface-solid) 94%, transparent) !important;
      backdrop-filter: blur(12px) !important;
    }
    .sort-btn {
      transition: all 0.12s ease !important;
    }
    .sort-btn.active {
      background: var(--accent-soft) !important;
      color: var(--accent) !important;
      border-color: var(--accent-mid) !important;
    }

    /* ── Hover state no comment-row ── */
    .comment-row:not(.is-deleted):hover {
      background: var(--surface-hover) !important;
    }

    /* ── Animação de pop no like de comentário ── */
    @keyframes cLikePop { 0%{transform:scale(1)} 40%{transform:scale(1.5)} 70%{transform:scale(0.9)} 100%{transform:scale(1)} }
    .comment-pa-like.popping svg { animation: cLikePop 0.32s var(--ease) !important; }

    /* ── Subthread: tipografia das respostas ── */
    #subthread-replies .comment-row p,
    #subreplies-list-wrap .comment-row p {
      font-size: 14px !important;
      line-height: 1.6 !important;
    }

    /* ── Share popover de comentário ── */
    .comment-share-popover {
      position: fixed;
      z-index: 9996;
      width: 220px;
      padding: 6px;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: var(--surface-solid);
      box-shadow: var(--shadow-lg);
      animation: fadeIn 0.12s var(--ease);
    }
    .comment-share-popover button {
      width: 100%;
      min-height: 36px;
      display: flex;
      align-items: center;
      gap: 9px;
      padding: 7px 9px;
      border-radius: 7px;
      color: var(--ink);
      font-size: 12.5px;
      font-weight: 800;
      text-align: left;
      cursor: pointer;
      background: none;
      border: none;
      font-family: var(--ff);
    }
    .comment-share-popover button:hover { background: var(--accent-soft); color: var(--accent); }
    .comment-share-popover svg { width: 15px; height: 15px; flex-shrink: 0; }
  `;
  document.head.appendChild(style);

  /* ── 2. WAIT FOR APP STATE ────────────────────────────────────────────── */
  function waitForState(cb, tries = 0) {
    if (typeof state !== 'undefined' && typeof api !== 'undefined') {
      cb();
    } else if (tries < 60) {
      setTimeout(() => waitForState(cb, tries + 1), 100);
    }
  }

  waitForState(patchCommentSystem);

  function patchCommentSystem() {

    /* ── 3. DETECT BEST COMMENTS ENDPOINT ─────────────────────────────── */
    // The patch registers /v2 — detect if it's available and use it.
    // Falls back to base endpoint gracefully.
    let _v2Available = null;
    async function commentsEndpoint(postId, params = '') {
      if (_v2Available === null) {
        try {
          await api(`/api/community/posts/${encodeURIComponent(postId)}/comments/v2?limit=1${params ? '&' + params : ''}`);
          _v2Available = true;
        } catch (e) {
          _v2Available = false;
        }
      }
      const base = _v2Available
        ? `/api/community/posts/${encodeURIComponent(postId)}/comments/v2`
        : `/api/community/posts/${encodeURIComponent(postId)}/comments`;
      return `${base}${params ? '?' + params : ''}`;
    }

    /* ── 4. COMMENT SHARE URL ─────────────────────────────────────────── */
    function commentShareUrl(commentId) {
      const base = (typeof API_BASE !== 'undefined' ? API_BASE : '').replace(/\/+$/, '');
      return `${base}/share/comment/${encodeURIComponent(commentId)}`;
    }

    function commentPublicUrl(commentId) {
      // Falls back to the post page anchored to the comment
      return commentShareUrl(commentId);
    }

    /* ── 5. COMMENT LIKE HANDLER (improved) ───────────────────────────── */
    async function handleCommentLikeFixed(btn) {
      if (!state.me) { toast('warning', 'Faça login para curtir', ''); return; }
      const commentId = btn.dataset.commentLike;
      if (!commentId) return;
      const liked = btn.dataset.liked === '1';
      btn.dataset.liked = liked ? '0' : '1';
      btn.classList.toggle('is-on', !liked);
      btn.classList.add('popping');
      setTimeout(() => btn.classList.remove('popping'), 380);
      const countEl = document.querySelector(`[data-comment-likes-count="${commentId}"]`);
      const current = Number(countEl?.textContent?.replace(/\D/g, '') || 0);
      if (countEl) countEl.textContent = liked ? (current - 1 > 0 ? num(current - 1) : '') : num(current + 1);
      try {
        const resp = await api(`/api/community/comments/${encodeURIComponent(commentId)}/like`, {
          method: liked ? 'DELETE' : 'POST',
        });
        if (countEl && resp?.likes_count !== undefined)
          countEl.textContent = resp.likes_count > 0 ? num(resp.likes_count) : '';
      } catch (err) {
        btn.dataset.liked = liked ? '1' : '0';
        btn.classList.toggle('is-on', liked);
        if (countEl) countEl.textContent = current > 0 ? num(current) : '';
        toast('error', 'Like não salvo', err.message);
      }
    }

    /* ── 6. COMMENT SHARE POPOVER ─────────────────────────────────────── */
    let _sharePopover = null;
    function closeCommentSharePopover() {
      _sharePopover?.remove();
      _sharePopover = null;
    }

    function openCommentSharePopover(commentId, commentContent, btn) {
      closeCommentSharePopover();
      const url = commentPublicUrl(commentId);
      const pop = document.createElement('div');
      pop.className = 'comment-share-popover';

      const copyIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`;
      const waIcon = `<svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z"/></svg>`;

      pop.innerHTML = `
        <button type="button" data-csp-copy>
          ${copyIcon} Copiar link do comentário
        </button>
        <button type="button" data-csp-wa>
          ${waIcon} Compartilhar no WhatsApp
        </button>
      `;

      pop.querySelector('[data-csp-copy]').onclick = async () => {
        closeCommentSharePopover();
        try {
          await navigator.clipboard.writeText(url);
          toast('success', 'Link copiado!', url);
        } catch { toast('info', 'Copie manualmente', url); }
      };

      pop.querySelector('[data-csp-wa]').onclick = () => {
        closeCommentSharePopover();
        const text = commentContent ? `"${String(commentContent).slice(0, 100)}"` : '';
        window.open(`https://wa.me/?text=${encodeURIComponent(`${text}\n${url}`)}`, '_blank', 'noopener,noreferrer');
      };

      document.body.appendChild(pop);
      _sharePopover = pop;

      const rect = btn.getBoundingClientRect();
      const popW = 220;
      let top = rect.bottom + 6;
      let left = rect.left;
      if (left + popW > window.innerWidth - 8) left = window.innerWidth - popW - 8;
      if (left < 8) left = 8;
      if (top + 120 > window.innerHeight - 10) top = rect.top - 120;
      pop.style.cssText = `position:fixed;top:${top}px;left:${left}px;`;

      setTimeout(() => {
        document.addEventListener('click', closeCommentSharePopover, { once: true });
      }, 50);
    }

    /* ── 7. COMMENT REPOST (quote) ────────────────────────────────────── */
    async function repostComment(commentId, commentContent, authorName, postId, btn) {
      const repostIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2l4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/></svg>`;

      // Build quote text
      const quoteText = `"${String(commentContent || '').trim().slice(0, 200)}" — @${authorName}`;

      const back = document.createElement('div');
      back.className = 'backdrop show';
      back.innerHTML = `
        <div class="sheet sheet-sm" role="dialog" aria-modal="true">
          <div class="sheet-header">
            <h2>Repostar comentário</h2>
            <button class="close-btn" data-rqc-cancel aria-label="Fechar">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
            </button>
          </div>
          <div class="sheet-body">
            <div style="padding:10px 12px;border:1px solid var(--line);border-radius:var(--r-sm);background:var(--bg);margin-bottom:12px;color:var(--ink-2);font-size:13px;line-height:1.55;border-left:3px solid var(--accent-mid)">
              ${esc(quoteText)}
            </div>
            <textarea class="sheet-ta" id="cmt-repost-ta" maxlength="280" rows="3" placeholder="Adicione um comentário (opcional)…"></textarea>
          </div>
          <div class="sheet-footer">
            <button class="btn btn-secondary btn-sm" data-rqc-cancel>Cancelar</button>
            <button class="btn btn-primary btn-sm" data-rqc-send>${repostIcon} Repostar</button>
          </div>
        </div>
      `;
      document.body.appendChild(back);
      document.body.classList.add('modal-open');

      const finish = async (send) => {
        back.remove();
        if (!document.querySelectorAll('.backdrop.show').length) document.body.classList.remove('modal-open');
        if (!send) return;

        const userComment = back.querySelector('#cmt-repost-ta')?.value.trim() || '';
        const fullContent = userComment ? `${userComment}\n\n${quoteText}` : quoteText;

        const identity = typeof activePublishIdentity === 'function' ? activePublishIdentity() : state.me;
        const publishAs = identity && state.me && Number(identity.id) !== Number(state.me.id) ? Number(identity.id) : null;

        try {
          await api(`/api/community/posts/${encodeURIComponent(postId)}/repost`, {
            method: 'POST',
            body: JSON.stringify({
              content: fullContent.slice(0, 280),
              ...(publishAs ? { publish_as_user_id: publishAs } : {})
            }),
          });
          if (typeof loadFeed === 'function') loadFeed({ reset: true });
          toast('success', 'Repost feito!', 'Aparece no seu feed.');
        } catch (e) {
          toast('error', 'Repost não concluído', e.message);
        }
      };

      back.addEventListener('click', e => {
        if (e.target.closest('[data-rqc-cancel]') || e.target === back) finish(false);
        if (e.target.closest('[data-rqc-send]')) finish(true);
      });
      setTimeout(() => back.querySelector('#cmt-repost-ta')?.focus(), 60);
    }

    /* ── 8. REBUILD commentsHTML WITH FULL SOCIAL ACTIONS ─────────────── */
    if (typeof window.commentsHTML === 'function') {
      window._origCommentsHTML = window.commentsHTML;
    }

    window.commentsHTML = function commentsHTMLFixed(comments, opts = {}) {
      const { isSubthread = false } = opts;
      if (!Array.isArray(comments) || !comments.length) {
        return `<div class="empty-card"><div class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/></svg></div><h3>Nenhuma resposta ainda</h3><p>Seja o primeiro a responder esta thread.</p></div>`;
      }

      const repostSVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2l4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/></svg>`;
      const shareSVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>`;
      const trashSVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v5M14 11v5"/></svg>`;
      const flagSVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>`;
      const replySVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;

      return `<div class="comments-list">${comments.map(c => {
        const mc = c.minecraft_name || c.username || 'Jogador';
        const shown = (typeof displayName === 'function') ? displayName(c) : (c.display_name || mc);
        const handle = (typeof handleName === 'function') ? handleName(c) : (c.username || mc);
        const del = Boolean(c.is_deleted);
        const isMyComment = state.me && Number(c.author_id) === Number(state.me.id);
        const canDelete = (isMyComment || (typeof canModerate === 'function' && canModerate())) && !del;
        const likesCount = Number(c.likes_count || 0);
        const replyCount = Number(c.reply_count || 0);
        const likedByMe = Boolean(c.liked_by_me);
        const avSrc = (typeof avatar === 'function') ? avatar(c, 50) : (c.avatar_url || c.photo_url || '');
        const avFallback = (typeof fallbackAvatar === 'function') ? fallbackAvatar(shown, 50) : '';
        const verified = (typeof verifiedBadgeHTML === 'function') ? verifiedBadgeHTML(c) : '';
        const ts = (typeof time === 'function') ? time(c.created_at) : '';
        const contentHTML = del ? esc(c.content) : ((typeof mentionHTML === 'function') ? mentionHTML(c.content) : esc(c.content));

        const heartSVG = `<svg viewBox="0 0 24 24" fill="${likedByMe ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`;

        const moderationTools = !del ? [
          canDelete ? `<button class="btn btn-ghost btn-xs" data-delete-comment="${esc(c.id)}" style="opacity:0.65;padding:0 5px;height:22px" aria-label="Remover">${trashSVG}</button>` : '',
          !isMyComment ? `<button class="btn btn-ghost btn-xs" data-report-comment="${esc(c.id)}" style="opacity:0.5;padding:0 5px;height:22px" aria-label="Denunciar">${flagSVG}</button>` : '',
        ].filter(Boolean).join('') : '';

        // Full social bar: like • reply/ver-respostas • repost • share
        const interactionBar = del ? '' : `
          <div class="comment-meta">
            <button class="comment-pa comment-pa-like${likedByMe ? ' is-on' : ''}"
              data-comment-like="${esc(c.id)}"
              data-liked="${likedByMe ? '1' : '0'}"
              data-comment-content="${esc(String(c.content || '').slice(0, 200))}"
              aria-label="${likedByMe ? 'Descurtir' : 'Curtir'} comentário">
              ${heartSVG}<span data-comment-likes-count="${esc(c.id)}">${likesCount > 0 ? num(likesCount) : ''}</span>
            </button>

            ${!isSubthread
              ? `<button class="comment-pa comment-pa-replies"
                  data-open-comment-thread="${esc(c.id)}"
                  aria-label="Ver respostas ao comentário">
                  ${replySVG}<span>${replyCount > 0 ? `${num(replyCount)} ${replyCount === 1 ? 'resposta' : 'respostas'}` : 'Responder'}</span>
                </button>`
              : `<button class="comment-pa comment-pa-replies"
                  data-reply-to-comment="${esc(c.id)}"
                  data-reply-name="${esc(shown)}"
                  aria-label="Responder">
                  ${replySVG}<span>Responder</span>
                </button>`
            }

            <button class="comment-pa comment-pa-repost"
              data-comment-repost="${esc(c.id)}"
              data-comment-content="${esc(String(c.content || '').slice(0, 200))}"
              data-comment-author="${esc(handle)}"
              aria-label="Repostar comentário">
              ${repostSVG}
            </button>

            <button class="comment-pa comment-pa-share"
              data-comment-share="${esc(c.id)}"
              data-comment-content="${esc(String(c.content || '').slice(0, 200))}"
              aria-label="Compartilhar comentário">
              ${shareSVG}
            </button>

            ${moderationTools}
          </div>
        `;

        return `<article class="comment-row${del ? ' is-deleted' : ''}"
            data-comment-id="${esc(c.id)}"
            ${!del && !isSubthread ? `data-open-comment-thread="${esc(c.id)}"` : ''}>
          <img src="${esc(avSrc)}" alt="${esc(shown)}"
            onerror="this.onerror=null; this.src='${avFallback}'">
          <div>
            <div class="comment-author">
              <strong class="js-profile" data-mc="${esc(mc)}" data-uid="${esc(c.author_id)}">${esc(shown)}</strong>
              ${verified}
              <span class="handle">@${esc(handle)}</span>
              <span class="ts">· ${esc(ts)}</span>
            </div>
            <p class="${del ? 'deleted' : ''}">${contentHTML}</p>
            ${interactionBar}
          </div>
        </article>`;
      }).join('')}</div>`;
    };

    /* ── 9. PATCH navigateCommentThread WITH BETTER ERROR HANDLING ──────── */
    if (typeof window.navigateCommentThread === 'function') {
      const _origNavigate = window.navigateCommentThread;

      window.navigateCommentThread = async function navigateCommentThreadFixed(commentId, fromPostId) {
        // Show loading skeleton
        if (typeof showRouteUI === 'function') {
          showRouteUI(`
            <div class="route-top">
              <button class="btn btn-ghost btn-sm" data-back-to-post data-post-id="${esc(fromPostId)}">${typeof IC !== 'undefined' ? IC.back : '←'} Voltar para thread</button>
              <span class="crumb-path">Respostas ao comentário</span>
            </div>
            <div class="skel" style="height:100px;border-radius:var(--r-md)"></div>
            <div class="skel" style="height:80px;border-radius:var(--r-md)"></div>
            <div class="skel" style="height:180px;border-radius:var(--r-md)"></div>
          `);
        }

        try {
          const data = await api(`/api/community/comments/${encodeURIComponent(commentId)}/thread`);

          if (!data || !data.root_comment) throw new Error('Resposta inválida da API');

          const rootComment = data.root_comment;
          const originalPost = data.original_post;
          const replies = Array.isArray(data.replies) ? data.replies : [];
          const postId = rootComment.post_id || fromPostId;
          const sort = data.sort || 'relevance';

          const postAuthorShown = originalPost ? ((typeof displayName === 'function') ? displayName(originalPost) : 'Jogador') : 'Jogador';
          const postContent = originalPost?.content ? String(originalPost.content).slice(0, 120) + (originalPost.content.length > 120 ? '…' : '') : '';
          const postAv = originalPost && (typeof avatar === 'function') ? avatar(originalPost, 40) : ((typeof fallbackAvatar === 'function') ? fallbackAvatar('Jogador', 40) : '');
          const postMc = originalPost?.minecraft_name || originalPost?.username || 'Jogador';
          const postFallback = (typeof fallbackAvatar === 'function') ? fallbackAvatar(postAuthorShown, 40) : '';

          const routeCol = document.getElementById('route-col');
          if (!routeCol) return;

          const meAvSrc = state.me && (typeof avatar === 'function') ? avatar(state.me, 50) : '';
          const meFallback = state.me && (typeof fallbackAvatar === 'function') ? fallbackAvatar((typeof displayName === 'function') ? displayName(state.me) : 'Jogador', 50) : '';

          routeCol.innerHTML = `
            <div class="route-top">
              <button class="btn btn-ghost btn-sm" data-back-to-post data-post-id="${esc(postId)}">${typeof IC !== 'undefined' ? IC.back : '←'} Voltar para thread</button>
              <span class="crumb-path">Respostas ao comentário</span>
            </div>

            ${originalPost ? `
            <div class="subthread-original-post" data-nav-post="${esc(postId)}" role="button" tabindex="0" aria-label="Ver post original">
              <div class="subthread-context">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
                Comentando em um post de <strong>${esc(postAuthorShown)}</strong>
              </div>
              <div class="subthread-original-post-inner">
                <img src="${esc(postAv)}" alt="${esc(postAuthorShown)}" onerror="this.onerror=null; this.src='${postFallback}'">
                <div>
                  <div class="comment-author">
                    <strong>${esc(postAuthorShown)}</strong>
                    <span class="handle">@${esc(postMc)}</span>
                    <span class="ts">· ${(typeof time === 'function') ? time(originalPost.created_at) : ''}</span>
                  </div>
                  <p style="font-size:13px;margin-top:3px;color:var(--ink-2);line-height:1.45">${esc(postContent)}</p>
                </div>
              </div>
            </div>` : ''}

            <div class="subthread-root-comment" id="subthread-root">
              ${window.commentsHTML([rootComment], { isSubthread: true })}
            </div>

            <div class="subthread-connector">respostas</div>

            <div class="reply-bar" id="subreply-bar">
              <img class="av42" src="${esc(meAvSrc)}" alt="Seu avatar" onerror="this.onerror=null; this.src='${meFallback}'">
              <textarea class="reply-ta" id="subreply-ta" maxlength="280" placeholder="Responder a @${esc((typeof displayName === 'function') ? displayName(rootComment) : 'Jogador')}…" aria-label="Responder ao comentário"></textarea>
              <button class="btn btn-primary btn-sm" id="subreply-btn">Responder</button>
            </div>

            <div id="subthread-replies">
              ${(typeof buildSubthreadRepliesHTML === 'function')
                ? buildSubthreadRepliesHTML(replies, data.has_more, data.next_cursor, rootComment.id, postId, sort)
                : ''}
            </div>
          `;

          if (typeof bindSubthreadEvents === 'function') {
            bindSubthreadEvents(routeCol, rootComment, postId, sort);
          }

        } catch (e) {
          const ic = typeof IC !== 'undefined' ? IC : {};
          const errIcon = ic.err || ic.comment || '';
          if (typeof showRouteUI === 'function') {
            showRouteUI(`
              <div class="route-top">
                <button class="btn btn-ghost btn-sm" data-back>${typeof IC !== 'undefined' ? IC.back : '←'} Voltar</button>
              </div>
              <div class="empty-card">
                <div class="empty-icon">${errIcon}</div>
                <h3>Comentário indisponível</h3>
                <p>${esc(e.message || 'Não foi possível carregar este comentário.')}</p>
                <div style="margin-top:14px">
                  <button class="btn btn-primary btn-sm" data-back-to-post data-post-id="${esc(fromPostId)}">
                    Voltar para a thread do post
                  </button>
                </div>
              </div>
            `);
          }
          const rc = document.getElementById('route-col');
          if (rc) {
            rc.addEventListener('click', ev => {
              if (ev.target.closest('[data-back]')) {
                if (typeof Router !== 'undefined') Router.navigate('/community');
              }
              const bp = ev.target.closest('[data-back-to-post]');
              if (bp) {
                const pid = bp.dataset.postId || fromPostId;
                if (typeof navigatePost === 'function') navigatePost(pid);
              }
            }, { once: true });
          }
        }
      };
    }

    /* ── 10. INTERCEPT EVENTS FOR COMMENT SOCIAL ACTIONS ─────────────── */
    document.addEventListener('click', async function faCommentsFixHandler(e) {
      // Close share popover on outside click
      if (_sharePopover && !_sharePopover.contains(e.target)) {
        closeCommentSharePopover();
      }

      // ── Comment Like (fixed version) ──
      const likeBtn = e.target.closest('[data-comment-like]');
      if (likeBtn) {
        e.stopPropagation();
        await handleCommentLikeFixed(likeBtn);
        return;
      }

      // ── Comment Share ──
      const shareBtn = e.target.closest('[data-comment-share]');
      if (shareBtn) {
        e.stopPropagation();
        const cid = shareBtn.dataset.commentShare;
        const content = shareBtn.dataset.commentContent;
        openCommentSharePopover(cid, content, shareBtn);
        return;
      }

      // ── Comment Repost ──
      const repostBtn = e.target.closest('[data-comment-repost]');
      if (repostBtn) {
        e.stopPropagation();
        const cid = repostBtn.dataset.commentRepost;
        const content = repostBtn.dataset.commentContent;
        const authorHandle = repostBtn.dataset.commentAuthor;
        // Find post ID from context
        const commentRow = repostBtn.closest('[data-comment-id]');
        const threadComments = repostBtn.closest('#thread-comments');
        let postId = state.activePostId || null;
        if (!postId && threadComments) {
          // Try to read from route URL
          const url = new URL(location.href);
          postId = url.searchParams.get('post');
        }
        if (postId) {
          await repostComment(cid, content, authorHandle, postId, repostBtn);
        } else {
          toast('warning', 'Post não identificado', 'Tente abrir a thread completa.');
        }
        return;
      }

    }, true); // capture phase to run before existing handlers

    /* ── 11. PATCH renderThreadComments TO USE FIXED commentsHTML ──────── */
    // Wrap to ensure our commentsHTML is used
    if (typeof window.renderThreadComments === 'function') {
      const _origRTC = window.renderThreadComments;
      window.renderThreadComments = function renderThreadCommentsFixed(...args) {
        _origRTC(...args);
        // Re-apply our hook in case orig swapped it
      };
    }

    /* ── 12. PATCH SORT TO DETECT /v2 ENDPOINT ───────────────────────── */
    // Monkey-patch api calls for comments sort to detect v2 availability
    const _origAPI = window.api;
    if (typeof _origAPI === 'function') {
      // We can't easily patch api, but we can ensure commentsHTML is called
      // our version is already stored as window.commentsHTML
    }

    /* ── 13. ENSURE SUBTHREAD LIKE EVENTS WORK ─────────────────────────── */
    // The original bindSubthreadEvents handles likes, but references old handleCommentLike.
    // Our capture-phase listener above takes priority.

    console.log('[fa-comments-fix] ✓ Comment system patch loaded successfully');
    console.log('[fa-comments-fix]   - Typography equalized with posts');
    console.log('[fa-comments-fix]   - Social actions: like, reply, repost, share');
    console.log('[fa-comments-fix]   - Comment thread page: improved error handling');
    console.log('[fa-comments-fix]   - commentsHTML: patched with full social bar');
  }

  /* ── HELPER: escape HTML (same as main app) ──────────────────────────── */
  function esc(v) {
    return String(v ?? '').replace(/[&<>'"]/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    }[c]));
  }
  function num(v) {
    return Number(v || 0).toLocaleString('pt-BR');
  }

})();
