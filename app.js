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
  // Basit çizgi ikonlar (Feather, MIT). Sabit metinlerden DOM düğümü üretilir, kullanıcı verisi girmez.
  const ICONS = {
    user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>'
  };
  function icon(name) {
    const svg = new DOMParser().parseFromString(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true">' + ICONS[name] + '</svg>',
      'image/svg+xml').documentElement;
    return document.importNode(svg, true);
  }
  const show = (...nodes) => root.replaceChildren(...nodes);
  const card = (title, ...kids) => el('section', { class: 'card' }, el('h1', { text: title }), ...kids);

  function stopLive() {
    document.querySelectorAll('.modal-back').forEach((n) => n.remove());
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
    const today = new Date().toLocaleDateString('sv-SE'); // yerel saatle YYYY-AA-GG
    const state = { q: '', from: today, to: today, shown: 0, total: 0, loading: false, again: false };

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
    const from = el('input', { type: 'date', value: today, onchange: (e) => { state.from = e.target.value; load(true); } });
    const to = el('input', { type: 'date', value: today, onchange: (e) => { state.to = e.target.value; load(true); } });
    const phone = el('span', { class: 'phone' });
    let devices = [];
    let scanTimer = null;
    const scanMsg = el('span', { class: 'muted' });
    const scanBtn = el('button', {
      class: 'secondary small', hidden: true, title: 'Telefondaki son SMS’leri sorgula', onclick: () => startScan()
    }, 'Telefonu tara');
    const scanRow = el('div', { class: 'scanrow' }, scanBtn, scanMsg);
    let isAdmin = false;
    const gear = el('button', {
      class: 'secondary icon', title: 'Kullanıcı yönetimi', 'aria-label': 'Kullanıcı yönetimi',
      hidden: true, onclick: () => openAdmin(userEmail)
    }, icon('settings'));
    const account = el('button', {
      class: 'secondary icon', title: 'Hesabım', 'aria-label': 'Hesabım',
      onclick: () => openAccount(userEmail, isAdmin)
    }, icon('user'));
    const logoutBtn = el('button', {
      class: 'secondary icon', title: 'Çıkış yap', 'aria-label': 'Çıkış yap', onclick: logout
    }, icon('logout'));

    show(
      el('div', { class: 'bar' },
        el('div', { class: 'who-col' },
          el('div', { class: 'who' }, el('h1', { text: 'Ofis SMS' }), live, count),
          phone, scanRow),
        el('div', { class: 'tools' }, account, gear, logoutBtn)),
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
        list.replaceChildren(el('p', { class: 'empty', text: filtered ? 'Bu filtreyle SMS yok. Tarihleri silerek tüm mesajları görebilirsiniz.' : 'Henüz SMS yok.' }));
      }
      count.textContent = state.total + ' mesaj';
      more.hidden = state.shown >= state.total;

      if (state.again) { state.again = false; load(true, true); }
    }

    // Telefonun son görülme zamanı (device_status SQL'i kurulmadıysa sessizce gizlenir)
    async function loadPhone() {
      const { data, error } = await sb.rpc('device_status');
      if (error || !data || !data.length) { devices = []; scanBtn.hidden = true; phone.textContent = ''; phone.className = 'phone'; return; }
      devices = data;
      scanBtn.hidden = !('scan_requested_at' in data[0]); // 03-tarama.sql kurulmadıysa gizli
      const now = Date.now();
      let allOn = true;
      const txt = data.map((d) => {
        if (!d.last_seen) { allOn = false; return d.id + ': hiç bağlanmadı'; }
        const min = Math.max(0, Math.round((now - new Date(d.last_seen).getTime()) / 60000));
        const stamp = ' (son sinyal ' + fmt.format(new Date(d.last_seen)) + ')';
        const bat = (d.battery_pct === null || d.battery_pct === undefined) ? ''
          : ' · pil %' + d.battery_pct + (d.charging ? ' (şarjda)' : '');
        if (min <= 20) return d.id + ': çevrimiçi' + stamp + bat;
        allOn = false;
        const ago = min < 60 ? min + ' dk' : min < 1440 ? Math.floor(min / 60) + ' sa' : Math.floor(min / 1440) + ' gün';
        return d.id + ': ' + ago + ' önce görüldü' + stamp + bat;
      }).join(' · ');
      phone.className = 'phone ' + (allOn ? 'on' : 'off');
      phone.textContent = 'Telefon ' + txt;
      phone.title = allOn ? '' : 'Telefon kapalı, internetsiz ya da uygulama durmuş olabilir; SMS’ler gecikebilir.';
    }

    function scanPending() {
      return devices.filter((d) => d.scan_requested_at && (!d.scan_done_at || new Date(d.scan_done_at) < new Date(d.scan_requested_at)));
    }

    async function startScan() {
      scanBtn.disabled = true;
      scanMsg.textContent = 'İstek gönderiliyor…';
      for (const d of devices) {
        const { error } = await sb.rpc('request_scan', { p_device_id: d.id });
        if (error) { scanMsg.textContent = 'İstek gönderilemedi: ' + error.message; scanBtn.disabled = false; return; }
      }
      scanMsg.textContent = 'İstek gönderildi, telefonun yanıtı bekleniyor (en geç 1-2 dakika)…';
      const t0 = Date.now();
      clearInterval(scanTimer);
      scanTimer = setInterval(async () => {
        if (!document.body.contains(scanBtn)) { clearInterval(scanTimer); return; }
        await loadPhone();
        if (!scanPending().length) {
          clearInterval(scanTimer);
          scanBtn.disabled = false;
          scanMsg.textContent = 'Tarama tamamlandı: ' + devices.map((d) => d.scan_note).filter(Boolean).join(' · ');
          load(true, true);
        } else if (Date.now() - t0 > 3 * 60 * 1000) {
          clearInterval(scanTimer);
          scanBtn.disabled = false;
          scanMsg.textContent = 'Telefon yanıt vermedi (kapalı, internetsiz ya da uygulama durmuş olabilir). İstek bekliyor, telefon açılınca otomatik taranır.';
        }
      }, 5000);
    }

    load(true);
    loadPhone();
    // Yönetici değilse (ya da sunucu fonksiyonu kurulu değilse) simge gizli kalır
    callAdmin({ action: 'me' }).then((r) => { if (r.data && r.data.admin) { isAdmin = true; gear.hidden = false; } });
    ageTimer = setInterval(() => { if (sessionExpired()) expireSession(); }, 60000);

    channel = sb.channel('sms-live')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'sms_messages' }, () => load(true, true))
      .subscribe((status) => {
        const on = status === 'SUBSCRIBED';
        live.className = 'live' + (on ? ' on' : '');
        live.title = on ? 'Canlı bağlantı açık' : 'Canlı bağlantı kapalı';
      });
    pollTimer = setInterval(() => { load(true, true); loadPhone(); }, 60000); // yedek: canlı bağlantı koparsa
  }

  // ---------- kullanıcı yönetimi (yalnızca yönetici) ----------
  async function callAdmin(body) {
    const { data, error } = await sb.functions.invoke('kullanici-yonet', { body });
    if (error) {
      let msg = error.message;
      try { const j = await error.context.json(); if (j && j.error) msg = j.error; } catch { /* yoksay */ }
      return { error: msg };
    }
    if (data && data.error) return { error: data.error };
    return { data };
  }

  function genPassword() {
    const A = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    const r = new Uint32Array(16);
    crypto.getRandomValues(r);
    return Array.from(r, (n) => A[n % A.length]).join('');
  }

  async function openAccount(selfEmail, admin) {
    const back = el('div', { class: 'modal-back' });
    const close = () => { back.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    back.addEventListener('click', (e) => { if (e.target === back) close(); });

    const body = el('div', {}, el('p', { class: 'muted', text: 'Yükleniyor…' }));
    back.append(el('div', { class: 'modal', role: 'dialog', 'aria-label': 'Hesabım' },
      el('div', { class: 'head' }, el('h2', { text: 'Hesabım' }),
        el('button', { class: 'secondary', text: 'Kapat', onclick: close })),
      body));
    document.body.append(back);

    const { data } = await sb.auth.getUser();
    const u = (data && data.user) || {};
    const when = (v) => (v ? fmt.format(new Date(v)) : '-');
    const start = getLoginAt();
    const row = (k, v) => el('div', { class: 'kv' }, el('span', { class: 'k', text: k }), el('span', { class: 'v', text: v }));
    body.replaceChildren(
      row('E-posta', u.email || selfEmail),
      row('Yetki', admin ? 'Yönetici' : 'Kullanıcı'),
      row('İki aşamalı doğrulama', 'Etkin (bu oturumda doğrulandı)'),
      row('Son giriş', when(u.last_sign_in_at)),
      row('Hesap oluşturulma', when(u.created_at)),
      row('Oturum başlangıcı', start ? when(start) : '-'),
      row('Oturum bitişi', start ? when(start + MAX_SESSION_MS) : '-'),
      el('p', { class: 'muted', text: 'Oturum süresi dolunca şifre ve doğrulama kodu yeniden istenir.' }));
  }

  function openAdmin(selfEmail) {
    const back = el('div', { class: 'modal-back' });
    const close = () => { back.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    back.addEventListener('click', (e) => { if (e.target === back) close(); });

    const list = el('div', {}, el('p', { class: 'muted', text: 'Yükleniyor…' }));
    const msg = el('p', { class: 'err' });
    const result = el('div');
    const email = el('input', { type: 'email', required: true, placeholder: 'E-posta', autocomplete: 'off' });
    const pass = el('input', { type: 'text', required: true, minlength: '12', placeholder: 'Geçici şifre (en az 12 karakter)', autocomplete: 'off' });
    const gen = el('button', { type: 'button', class: 'secondary', text: 'Şifre üret', onclick: () => { pass.value = genPassword(); } });
    const add = el('button', { type: 'submit', text: 'Kullanıcı ekle' });

    async function refresh() {
      const r = await callAdmin({ action: 'list' });
      if (r.error) { list.replaceChildren(el('p', { class: 'err', text: 'Liste alınamadı: ' + r.error })); return; }
      const users = r.data.users || [];
      list.replaceChildren(...users.map((u) => {
        const isSelf = (u.email || '').toLowerCase() === (selfEmail || '').toLowerCase();
        const last = u.last_sign_in_at ? 'son giriş ' + fmt.format(new Date(u.last_sign_in_at)) : 'henüz giriş yapmadı';
        return el('div', { class: 'urow' },
          el('div', {},
            el('div', { class: 'mail', text: u.email + (isSelf ? ' (siz)' : '') }),
            el('div', { class: 'muted', text: last })),
          el('div', {},
            el('span', {
              class: 'pill ' + (u.muaf ? 'wait' : (u.mfa ? 'ok' : 'wait')),
              text: u.muaf ? 'Authenticator kapalı' : (u.mfa ? 'Authenticator kurulu' : 'Authenticator bekliyor')
            }),
            isSelf ? null : ' ',
            isSelf ? null : el('button', {
              class: 'secondary', text: u.muaf ? 'Authenticator aç' : 'Authenticator kapat',
              onclick: async (e) => {
                const kapat = !u.muaf;
                if (kapat && !confirm(u.email + ' için Authenticator kodu istenmesin mi? Bu kullanıcı yalnızca e-posta ve şifreyle girecek.')) return;
                e.currentTarget.disabled = true;
                const d = await callAdmin({ action: 'mfa_muaf', id: u.id, value: kapat });
                if (d.error) { msg.textContent = d.error; e.currentTarget.disabled = false; return; }
                msg.textContent = '';
                refresh();
              }
            }),
            isSelf ? null : ' ',
            isSelf ? null : el('button', {
              class: 'secondary danger', text: 'Sil',
              onclick: async (e) => {
                if (!confirm(u.email + ' kullanıcısı silinsin mi? Bu işlem geri alınamaz.')) return;
                e.currentTarget.disabled = true;
                const d = await callAdmin({ action: 'delete', id: u.id });
                if (d.error) { msg.textContent = d.error; e.currentTarget.disabled = false; return; }
                msg.textContent = '';
                refresh();
              }
            })));
      }));
    }

    const form = el('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        add.disabled = true; msg.textContent = ''; result.replaceChildren();
        const em = email.value.trim(), pw = pass.value;
        const r = await callAdmin({ action: 'create', email: em, password: pw });
        add.disabled = false;
        if (r.error) { msg.textContent = r.error; return; }
        const info = 'Ofis SMS giriş bilgileri\nAdres: ' + location.origin + '\nE-posta: ' + em + '\nGeçici şifre: ' + pw;
        result.replaceChildren(el('div', { class: 'created' },
          el('strong', { text: 'Kullanıcı oluşturuldu.' }),
          el('p', { class: 'muted', text: 'Şifre bir daha gösterilmez, şimdi kopyalayın. Kullanıcı ilk girişte Authenticator kuracak; bunu hemen birlikte yapın.' }),
          el('pre', { text: info }),
          el('button', {
            type: 'button', class: 'secondary', text: 'Bilgileri kopyala',
            onclick: async (ev) => {
              const b = ev.currentTarget;
              try { await navigator.clipboard.writeText(info); b.textContent = 'Kopyalandı ✓'; }
              catch { b.textContent = 'Kopyalanamadı, elle seçin'; }
            }
          })));
        email.value = ''; pass.value = '';
        refresh();
      }
    }, email, el('div', { class: 'row' }, pass, gen), add);

    back.append(el('div', { class: 'modal', role: 'dialog', 'aria-label': 'Kullanıcı yönetimi' },
      el('div', { class: 'head' }, el('h2', { text: 'Kullanıcı yönetimi' }),
        el('button', { class: 'secondary', text: 'Kapat', onclick: close })),
      el('h3', { text: 'Kullanıcılar' }), list,
      el('h3', { text: 'Yeni kullanıcı ekle' }), form, msg, result));
    document.body.append(back);
    refresh();
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

    // Yönetici bu kullanıcı için Authenticator'ı kapattıysa ikinci adımı atla
    const { data: muaf } = await sb.rpc('mfa_muaf_mi');
    if (muaf === true) {
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
