(() => {
  'use strict';

  const cfg = window.APP_CONFIG || {};
  const root = document.getElementById('app');

  if (!window.supabase || !cfg.SUPABASE_URL || !cfg.SUPABASE_KEY ||
      /BURAYA/.test(cfg.SUPABASE_URL + cfg.SUPABASE_KEY)) {
    root.textContent = 'Kurulum eksik: config.js dosyasına Supabase adresi ve anahtarı yazılmalı.';
    return;
  }

  const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY);
  const PAGE = 50;
  // Oturum en fazla bu kadar açık kalır; süre dolunca şifre + doğrulama kodu yeniden istenir.
  const MAX_SESSION_MS = 7 * 24 * 60 * 60 * 1000; // 7 gün
  const LOGIN_KEY = 'sms_login_at';
  const fmt = new Intl.DateTimeFormat('tr-TR', { dateStyle: 'medium', timeStyle: 'medium' });

  let channel = null, pollTimer = null, ageTimer = null, expiring = false;

  // ---------- küçük yardımcılar (innerHTML kullanılmaz, XSS'e kapalı) ----------
  function el(tag, props = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null) n.append(kid);
    return n;
  }
  const show = (...nodes) => root.replaceChildren(...nodes);
  const card = (title, ...kids) => el('section', { class: 'card' }, el('h1', { text: title }), ...kids);

  function stopLive() {
    if (channel) { sb.removeChannel(channel); channel = null; }
    clearInterval(pollTimer); pollTimer = null;
    clearInterval(ageTimer); ageTimer = null;
  }

  function getLoginAt() {
    try { return Number(localStorage.getItem(LOGIN_KEY)) || 0; } catch { return 0; }
  }
  function setLoginAt() {
    try { localStorage.setItem(LOGIN_KEY, String(Date.now())); } catch { /* yoksay */ }
  }
  function clearLoginAt() {
    try { localStorage.removeItem(LOGIN_KEY); } catch { /* yoksay */ }
  }
  function sessionExpired() {
    const t = getLoginAt();
    return t > 0 && Date.now() - t > MAX_SESSION_MS;
  }
  async function expireSession() {
    stopLive();
    clearLoginAt();
    expiring = true;
    await sb.auth.signOut();
    expiring = false;
    renderLogin('Oturum süresi doldu (7 gün). Lütfen yeniden giriş yapın.');
  }

  async function logout() {
    stopLive();
    clearLoginAt();
    await sb.auth.signOut();
    renderLogin();
  }

  // ---------- giriş ----------
  function renderLogin(msg) {
    const email = el('input', { type: 'email', required: true, autocomplete: 'username', placeholder: 'E-posta' });
    const pass = el('input', { type: 'password', required: true, autocomplete: 'current-password', placeholder: 'Şifre' });
    const err = el('p', { class: 'err', text: msg || '' });
    const btn = el('button', { type: 'submit', text: 'Giriş yap' });
    const form = el('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        btn.disabled = true; err.textContent = '';
        const { error } = await sb.auth.signInWithPassword({ email: email.value.trim(), password: pass.value });
        btn.disabled = false;
        if (error) { err.textContent = 'E-posta veya şifre hatalı.'; return; }
        clearLoginAt(); // yeni giriş: 7 günlük süre sıfırdan başlasın
        route();
      }
    }, email, pass, btn, err);
    show(card('Ofis SMS', el('p', { class: 'muted', text: 'Devam etmek için giriş yapın.' }), form));
    email.focus();
  }

  // ---------- iki aşamalı doğrulama ----------
  function codeForm(buttonText, onSubmit) {
    const code = el('input', {
      type: 'text', inputmode: 'numeric', pattern: '[0-9]*', maxlength: '6',
      autocomplete: 'one-time-code', required: true, placeholder: '6 haneli kod'
    });
    const err = el('p', { class: 'err' });
    const btn = el('button', { type: 'submit', text: buttonText });
    const form = el('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        btn.disabled = true; err.textContent = '';
        const msg = await onSubmit(code.value.trim());
        btn.disabled = false;
        if (msg) { err.textContent = msg; code.select(); }
      }
    }, code, btn, err);
    return { form, code };
  }

  const logoutLink = () => el('p', {}, el('button', { class: 'link', text: 'Çıkış yap', onclick: logout }));

  function renderMfaVerify(factorId) {
    const { form, code } = codeForm('Doğrula', async (c) => {
      const { error } = await sb.auth.mfa.challengeAndVerify({ factorId, code: c });
      if (error) return 'Kod hatalı veya süresi dolmuş.';
      route();
      return '';
    });
    show(card('İki aşamalı doğrulama',
      el('p', { class: 'muted', text: 'Doğrulama uygulamanızdaki 6 haneli kodu girin.' }),
      form, logoutLink()));
    code.focus();
  }

  async function renderMfaEnroll() {
    show(card('İki aşamalı doğrulama', el('p', { class: 'muted', text: 'Hazırlanıyor…' })));

    // Yarım kalmış önceki kurulumları temizle
    const { data: existing } = await sb.auth.mfa.listFactors();
    for (const f of (existing?.all || [])) {
      if (f.status === 'unverified') await sb.auth.mfa.unenroll({ factorId: f.id });
    }

    const { data, error } = await sb.auth.mfa.enroll({
      factorType: 'totp', friendlyName: 'Telefon ' + Date.now()
    });
    if (error) {
      show(card('Hata', el('p', { class: 'err', text: 'Kurulum başlatılamadı: ' + error.message }), logoutLink()));
      return;
    }

    const { form, code } = codeForm('Kurulumu tamamla', async (c) => {
      const { error: e2 } = await sb.auth.mfa.challengeAndVerify({ factorId: data.id, code: c });
      if (e2) return 'Kod hatalı. Uygulamadaki güncel kodu girin.';
      route();
      return '';
    });

    show(card('İki aşamalı doğrulamayı kur',
      el('p', { class: 'muted', text: 'SMS’lerde banka ve resmi kurum kodları olabileceği için her kullanıcıda doğrulama uygulaması zorunludur. Google Authenticator, Microsoft Authenticator veya benzeri bir uygulama ile QR kodu okutun.' }),
      el('img', { class: 'qr', src: data.totp.qr_code, alt: 'Doğrulama QR kodu' }),
      el('p', { class: 'muted', text: 'QR okutamıyorsanız bu anahtarı elle girin:' }),
      el('p', { class: 'secret', text: data.totp.secret }),
      form, logoutLink()));
    code.focus();
  }

  // ---------- ana ekran ----------
  function renderApp(userEmail) {
    const state = { q: '', from: '', to: '', shown: 0, total: 0, loading: false, again: false };

    const list = el('div', { class: 'list' });
    const live = el('span', { class: 'live', title: 'Canlı bağlantı kapalı' });
    const count = el('span', { class: 'muted' });
    const moreBtn = el('button', { class: 'secondary', text: 'Daha fazla yükle', onclick: () => load(false) });
    const more = el('div', { class: 'more' }, moreBtn);
    more.hidden = true;

    let timer = null;
    const search = el('input', {
      type: 'search', placeholder: 'Ara: gönderen veya mesaj metni',
      oninput: (e) => { clearTimeout(timer); timer = setTimeout(() => { state.q = e.target.value; load(true); }, 300); }
    });
    const from = el('input', { type: 'date', onchange: (e) => { state.from = e.target.value; load(true); } });
    const to = el('input', { type: 'date', onchange: (e) => { state.to = e.target.value; load(true); } });

    show(
      el('div', { class: 'bar' },
        el('div', { class: 'who' }, el('h1', { text: 'Ofis SMS' }), live, count),
        el('div', {}, el('span', { class: 'muted', text: userEmail + ' ' }),
          el('button', { class: 'secondary', text: 'Çıkış', onclick: logout }))),
      el('div', { class: 'filters' },
        el('label', {}, 'Arama', search),
        el('label', {}, 'Başlangıç', from),
        el('label', {}, 'Bitiş', to)),
      list, more);

    function applyFilters(q) {
      const term = state.q.replace(/[,()%\\*]/g, ' ').trim();
      if (term) q = q.or(`body.ilike.%${term}%,sender.ilike.%${term}%`);
      if (state.from) q = q.gte('received_at', new Date(state.from + 'T00:00:00').toISOString());
      if (state.to) {
        const d = new Date(state.to + 'T00:00:00');
        d.setDate(d.getDate() + 1);
        q = q.lt('received_at', d.toISOString());
      }
      return q;
    }

    function row(m) {
      const text = m.body;
      const body = el('div', { class: 'body' });
      let first = null, last = 0;
      for (const mt of text.matchAll(/\b\d{4,8}\b/g)) {
        if (mt.index > last) body.append(text.slice(last, mt.index));
        body.append(el('mark', { text: mt[0] }));
        if (!first) first = mt[0];
        last = mt.index + mt[0].length;
      }
      if (last < text.length) body.append(text.slice(last));

      const meta = fmt.format(new Date(m.received_at)) + (m.sim_slot != null ? ' · SIM ' + (m.sim_slot + 1) : '');
      let copy = null;
      if (first) {
        const label = 'Kodu kopyala: ' + first;
        copy = el('button', {
          class: 'copy secondary', text: label,
          onclick: async (e) => {
            const b = e.currentTarget;
            try { await navigator.clipboard.writeText(first); b.textContent = 'Kopyalandı ✓'; }
            catch { b.textContent = 'Kopyalanamadı'; }
            setTimeout(() => { b.textContent = label; }, 1500);
          }
        });
      }
      return el('article', { class: 'msg' },
        el('div', { class: 'head' }, el('strong', { text: m.sender }), el('span', { class: 'muted', text: meta })),
        body, copy);
    }

    // reset: baştan yükle. keep: şu an görünen kadarını koruyarak yenile (canlı güncelleme).
    async function load(reset, keep = false) {
      if (state.loading) { state.again = true; return; }
      state.loading = true;
      const offset = reset ? 0 : state.shown;
      const size = reset && keep ? Math.max(state.shown, PAGE) : PAGE;

      let q = sb.from('sms_messages').select('id,sender,body,received_at,sim_slot', { count: 'exact' });
      q = applyFilters(q)
        .order('received_at', { ascending: false })
        .order('id', { ascending: false })
        .range(offset, offset + size - 1);
      const { data, count: total, error } = await q;
      state.loading = false;

      if (error) {
        if (error.code === '42501' || /JWT|aal2/i.test(error.message)) { route(); return; }
        list.replaceChildren(el('p', { class: 'err', text: 'Mesajlar alınamadı: ' + error.message }));
        return;
      }

      if (reset) list.replaceChildren();
      for (const m of data) list.append(row(m));
      state.shown = reset ? data.length : state.shown + data.length;
      state.total = total ?? state.shown;

      if (state.shown === 0) {
        const filtered = state.q || state.from || state.to;
        list.replaceChildren(el('p', { class: 'empty', text: filtered ? 'Sonuç bulunamadı.' : 'Henüz SMS yok.' }));
      }
      count.textContent = state.total + ' mesaj';
      more.hidden = state.shown >= state.total;

      if (state.again) { state.again = false; load(true, true); }
    }

    load(true);
    ageTimer = setInterval(() => { if (sessionExpired()) expireSession(); }, 60000);

    channel = sb.channel('sms-live')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'sms_messages' }, () => load(true, true))
      .subscribe((status) => {
        const on = status === 'SUBSCRIBED';
        live.className = 'live' + (on ? ' on' : '');
        live.title = on ? 'Canlı bağlantı açık' : 'Canlı bağlantı kapalı';
      });
    pollTimer = setInterval(() => load(true, true), 60000); // yedek: canlı bağlantı koparsa
  }

  // ---------- yönlendirme ----------
  async function route() {
    stopLive();
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { renderLogin(); return; }

    const { data: aal, error } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
    if (error) { renderLogin('Oturum doğrulanamadı: ' + error.message); return; }

    if (aal.currentLevel === 'aal2') {
      if (sessionExpired()) { await expireSession(); return; }
      if (!getLoginAt()) setLoginAt();
      renderApp(session.user.email || '');
      return;
    }

    if (aal.nextLevel === 'aal2') {
      const { data: f } = await sb.auth.mfa.listFactors();
      const factor = (f?.totp || [])[0];
      if (factor) { renderMfaVerify(factor.id); return; }
    }
    renderMfaEnroll();
  }

  sb.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT' && !expiring) { stopLive(); clearLoginAt(); renderLogin(); }
  });

  route();
})();
