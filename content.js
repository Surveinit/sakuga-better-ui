(() => {
  // --- Critical CSS injection (in case content.css misses on some routes) ---
  function ensureStyle() {
    if (document.getElementById('sb-style')) return;
    const style = document.createElement('style');
    style.id = 'sb-style';
    style.textContent = `
      :root { --thumb-size: 220px; --gap: 12px; --max-width: 1400px; }
      #sb-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(var(--thumb-size), 1fr));
        gap: var(--gap); max-width: var(--max-width); margin: 24px auto; padding: 0 12px 64px; }
      .sb-tile { position: relative; border-radius: 12px; overflow: hidden; background: #111; aspect-ratio: 16/9; }
      .sb-thumb,.sb-video { width: 100%; height: 100%; object-fit: cover; display: block; }
      #sb-toolbar { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; display: flex; gap: 8px; padding: 10px;
        border-radius: 14px; background: rgba(20,20,20,.9); box-shadow: 0 4px 18px rgba(0,0,0,.35); backdrop-filter: blur(6px); }
      #sb-toolbar button { border: 1px solid #333; background: #1c1c1c; color: #eee; padding: 8px 10px; border-radius: 10px; cursor: pointer;
        font: 12px/1 system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif; }
      #sb-toolbar button[aria-pressed="true"] { border-color: #666; background: #2a2a2a; }
      #post-list, .content, .posts, .thumbs, .post-list, #posts { display: initial; }
    `;
    document.head.appendChild(style);
  }

  // --- Selectors ---
  const SEL_THUMBS = [
    'a[href*="/post/show"] img',
    'a[href*="/posts/"] img',
    '.post-preview img',
    '#post-list .thumb img',
    '#posts .thumb img',
    '.thumb a > img',
    'ul#post-list-posts li a > img'
  ].join(', ');

  const NEXT_LINK_SEL = [
    'a.next', 'a[rel="next"]', '#paginator a.next', '.pagination a[rel="next"]',
    '.pagination a.next', '#paginator a[title*="Next"]'
  ].join(', ');

  const SB_GRID_ID = 'sb-grid';
  const SB_TOOLBAR_ID = 'sb-toolbar';
  const SB_ADDED_ATTR = 'data-sb-added';

  let grid, toolbar, cleanupEnabled = true;
  let loadingNext = false;
  let pageNextURL = null;
  let moScheduled = false;
  let lastFoundCount = 0;

  // --- DOM helpers ---
  function ensureGrid() {
    grid = document.querySelector('#' + SB_GRID_ID);
    if (!grid) {
      grid = document.createElement('div');
      grid.id = SB_GRID_ID;
      document.body.appendChild(grid);
    }
    return grid;
  }

  function ensureToolbar() {
    toolbar = document.querySelector('#' + SB_TOOLBAR_ID);
    if (toolbar) return toolbar;

    toolbar = document.createElement('div');
    toolbar.id = SB_TOOLBAR_ID;
    toolbar.innerHTML = `
      <button data-size="180">S</button>
      <button data-size="220" aria-pressed="true">M</button>
      <button data-size="280">L</button>
      <button id="sb-toggle-cleanup" title="Toggle cleanup (hide original lists)">Cleanup: ON</button>
    `;
    toolbar.style.zIndex = '2147483647';

    toolbar.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-size]');
      if (btn) {
        toolbar.querySelectorAll('button[data-size]').forEach(b => b.setAttribute('aria-pressed', 'false'));
        btn.setAttribute('aria-pressed', 'true');
        document.documentElement.style.setProperty('--thumb-size', btn.dataset.size + 'px');
        return;
      }
      if (e.target.id === 'sb-toggle-cleanup') {
        cleanupEnabled = !cleanupEnabled;
        e.target.textContent = `Cleanup: ${cleanupEnabled ? 'ON' : 'OFF'}`;
        maybeHideOriginalLists(lastFoundCount);
      }
    });
    document.body.appendChild(toolbar);
    return toolbar;
  }

  // --- Peek overlay ---
  function openPeek({ title, src, fallbackURL }) {
    // Backdrop
    const backdrop = document.createElement('div');
    backdrop.className = 'sb-peek-backdrop';

    const modal = document.createElement('div');
    modal.className = 'sb-peek';
    const header = document.createElement('div');
    header.className = 'sb-peek-header';
    header.innerHTML = `<div>${title || 'Preview'}</div>`;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'sb-peek-close';
    closeBtn.textContent = 'Close (Esc)';
    header.appendChild(closeBtn);

    const body = document.createElement('div');
    body.className = 'sb-peek-body';

    // Prefer video, else fallback to iframe of the post page
    if (src) {
      const vid = document.createElement('video');
      vid.src = src; vid.autoplay = true; vid.muted = true; vid.controls = true; vid.playsInline = true; vid.loop = false;
      body.appendChild(vid);
    } else if (fallbackURL) {
      const iframe = document.createElement('iframe');
      iframe.src = fallbackURL;
      iframe.setAttribute('loading', 'lazy');
      iframe.style.border = '0';
      body.appendChild(iframe);
    } else {
      body.innerHTML = `<div style="color:#eee;padding:16px;">No preview available.</div>`;
    }

    modal.appendChild(header);
    modal.appendChild(body);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    const close = () => { document.removeEventListener('keydown', onKey); backdrop.remove(); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    closeBtn.addEventListener('click', close);
  }

  // Try to get a video source for a post
  async function resolveMediaForLink(a, hoverVideoSrc) {
    // 1) If we already detected a preview video, use it
    if (hoverVideoSrc) return { src: hoverVideoSrc };

    // 2) Fetch the post page and look for common media locations
    try {
      const html = await fetch(a.href, { credentials: 'include' }).then(r => r.text());
      const doc = new DOMParser().parseFromString(html, 'text/html');

      // Danbooru/Moebooru patterns
      const vid = doc.querySelector('video source[src], video[src]');
      if (vid) return { src: vid.getAttribute('src') || vid.src };

      // Some boorus render the media in #image (img or video)
      const image = doc.querySelector('#image[src]');
      if (image && (/\.(webm|mp4)$/i.test(image.src) === false)) {
        // Not a video; but we can still show as image fallback
        return { img: image.src };
      }

      // Last resort: look for any source with video mime
      const anySrc = doc.querySelector('source[type*="video"], source[src*=".mp4"], source[src*=".webm"]');
      if (anySrc) return { src: anySrc.getAttribute('src') };

      // No media found
      return {};
    } catch {
      return {};
    }
  }

  // --- Collection & rendering ---
  function collectThumbNodes(root = document) {
    const nodes = [];
    root.querySelectorAll(SEL_THUMBS).forEach(img => {
      if (img.closest('#' + SB_GRID_ID)) return; // ignore our grid
      const a = img.closest('a'); if (!a) return;
      if (a.hasAttribute(SB_ADDED_ATTR)) return;
      a.setAttribute(SB_ADDED_ATTR, '1');
      nodes.push({ a, img });
    });
    return nodes;
  }

  function createTile({ a, img }) {
    const tile = document.createElement('div');
    tile.className = 'sb-tile';

    const link = a.cloneNode(true);
    link.removeAttribute(SB_ADDED_ATTR);

    // capture hover preview video if present nearby
    let hoverVideoSrc = null;
    const maybeVideo = a.parentElement?.querySelector('video, source[type="video/webm"], source[type="video/mp4"]');
    if (maybeVideo) hoverVideoSrc = maybeVideo.src || maybeVideo.getAttribute('src');
    if (!hoverVideoSrc && a.dataset?.previewVideo) hoverVideoSrc = a.dataset.previewVideo;
    if (hoverVideoSrc) link.dataset.sbHover = hoverVideoSrc;

    const thumb = link.querySelector('img') || document.createElement('img');
    thumb.className = 'sb-thumb';
    if (!thumb.src && img.src) thumb.src = img.src;

    link.innerHTML = '';
    link.appendChild(thumb);
    tile.appendChild(link);

    // Hover-to-play mini preview (unchanged)
    if (hoverVideoSrc) {
      let vid;
      tile.addEventListener('mouseenter', () => {
        if (vid) return;
        vid = document.createElement('video');
        vid.className = 'sb-video';
        vid.src = hoverVideoSrc;
        vid.muted = true; vid.loop = true; vid.playsInline = true;
        tile.appendChild(vid);
        vid.play().catch(() => {});
      });
      tile.addEventListener('mouseleave', () => {
        if (vid) { vid.pause(); vid.remove(); vid = null; }
      });
    }

    // Shift+Click => Peek overlay that auto-plays
    link.addEventListener('click', async (e) => {
      if (!e.shiftKey) return; // let normal click work
      e.preventDefault();
      const hv = link.dataset.sbHover || null;
      const media = await resolveMediaForLink(a, hv);
      // If no direct video but we got an image, show the image; else iframe the post
      if (media.src) openPeek({ title: a.title || a.href, src: media.src });
      else if (media.img) openPeek({ title: a.title || a.href, src: null, fallbackURL: a.href }); // show page if needed
      else openPeek({ title: a.title || a.href, src: null, fallbackURL: a.href });
    });

    return tile;
  }

  function maybeHideOriginalLists(foundCount = 0) {
    const shouldHide = cleanupEnabled && foundCount >= 6;
    document.querySelectorAll('#post-list, .content, .posts, .thumbs, .post-list, #posts').forEach(el => {
      if (el.id === SB_GRID_ID) return;
      el.style.display = shouldHide ? 'none' : '';
    });
  }

  function detectNextURL(root = document, baseHref = null) {
    const next = root.querySelector(NEXT_LINK_SEL);
    if (next?.href) return next.href;
    try {
      const base = new URL(baseHref || location.href);
      const page = parseInt(base.searchParams.get('page') || '1', 10);
      if (!Number.isNaN(page)) {
        base.searchParams.set('page', String(page + 1));
        return base.toString();
      }
    } catch {}
    return null;
  }

  function renderInitial() {
    ensureStyle();
    const g = ensureGrid();
    ensureToolbar();

    const nodes = collectThumbNodes(document);
    lastFoundCount = nodes.length;
    nodes.forEach(n => g.appendChild(createTile(n)));
    maybeHideOriginalLists(lastFoundCount);

    pageNextURL = detectNextURL(document, location.href);

    observePageMutations();
    setupInfiniteScroll();
  }

  function setupInfiniteScroll() {
    window.addEventListener('scroll', async () => {
      if (loadingNext || !pageNextURL) return;
      const nearBottom = window.scrollY + window.innerHeight >= document.body.scrollHeight - 1200;
      if (!nearBottom) return;

      loadingNext = true;
      try {
        const currentURL = pageNextURL;
        const html = await fetch(currentURL, { credentials: 'include' }).then(r => r.text());
        const doc = new DOMParser().parseFromString(html, 'text/html');

        const newNodes = collectThumbNodes(doc);
        newNodes.forEach(n => grid.appendChild(createTile(n)));
        if (newNodes.length) lastFoundCount += newNodes.length;

        pageNextURL = detectNextURL(doc, currentURL);
        if (!newNodes.length) pageNextURL = null;
      } catch {
        pageNextURL = null;
      } finally {
        loadingNext = false;
      }
    }, { passive: true });
  }

  function observePageMutations() {
    const mo = new MutationObserver(() => {
      if (moScheduled) return;
      moScheduled = true;
      requestAnimationFrame(() => {
        moScheduled = false;
        const nodes = collectThumbNodes(document);
        if (nodes.length) {
          lastFoundCount += nodes.length;
          nodes.forEach(n => grid.appendChild(createTile(n)));
          maybeHideOriginalLists(lastFoundCount);
        }
      });
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderInitial);
  } else {
    renderInitial();
  }
})();
