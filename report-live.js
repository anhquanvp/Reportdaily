/**
 * TNT Daily Report — Live data refresh & Telegram
 * Đọc dữ liệu từ GAS API (sheet Data TNT) và cập nhật KPI trên báo cáo.
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'tnt_daily_report_cfg';
  const AUTH_TOKEN_KEY = 'tnt_auth_token';
  const AUTH_EMAIL_KEY = 'tnt_auth_email';
  const DEFAULT_CFG = {
    GAS_URL: '',
    TG_BOT_TOKEN: '',
    TG_CHAT_ID: '',
  };

  let liveData = null;
  let authToken = null;
  let authEmail = null;

  function getBuiltinConfig() {
    const w = (typeof window !== 'undefined' && window.TNT_CONFIG) ? window.TNT_CONFIG : {};
    return {
      GAS_URL: String(w.GAS_URL || '').trim(),
      GOOGLE_CLIENT_ID: String(w.GOOGLE_CLIENT_ID || '').trim(),
      TG_BOT_TOKEN: String(w.TG_BOT_TOKEN || '').trim(),
      TG_CHAT_ID: String(w.TG_CHAT_ID || '').trim(),
    };
  }

  function getGoogleClientId() {
    return getBuiltinConfig().GOOGLE_CLIENT_ID;
  }

  function handleGoogleCredential(response) {
    clearAuthError();
    clearSession();
    history.replaceState(null, '', window.location.pathname + window.location.search);
    const cfg = getConfig();
    if (!cfg.GAS_URL) {
      const setup = document.getElementById('auth-gas-setup');
      if (setup) setup.style.display = 'block';
      showAuthError('<strong>Chưa có GAS URL.</strong> Dán Web App URL bên dưới → <em>Lưu URL</em> → đăng nhập lại.');
      return;
    }
    const cb = window.location.href.split('#')[0];
    const base = cfg.GAS_URL.replace(/\/$/, '');
    // POST form — JWT dài, không gửi qua URL GET (dễ bị cắt/lỗi)
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = base;
    form.style.display = 'none';
    [
      ['action', 'auth_jwt'],
      ['cb', cb],
      ['credential', response.credential],
    ].forEach(function (pair) {
      const inp = document.createElement('input');
      inp.type = 'hidden';
      inp.name = pair[0];
      inp.value = pair[1];
      form.appendChild(inp);
    });
    document.body.appendChild(form);
    form.submit();
  }

  function initGoogleSignIn(container) {
    const clientId = getGoogleClientId();
    if (!clientId || !container) return false;

    function tryInit() {
      if (!window.google || !window.google.accounts || !window.google.accounts.id) {
        setTimeout(tryInit, 150);
        return;
      }
      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: handleGoogleCredential,
        ux_mode: 'popup',
        auto_select: false,
      });
      window.google.accounts.id.renderButton(container, {
        type: 'standard',
        theme: 'outline',
        size: 'large',
        text: 'signin_with',
        width: 320,
      });
    }
    tryInit();
    return true;
  }

  function getConfig() {
    const builtin = getBuiltinConfig();
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      const stored = saved ? JSON.parse(saved) : {};
      return Object.assign({}, DEFAULT_CFG, builtin, stored);
    } catch (e) {
      return Object.assign({}, DEFAULT_CFG, builtin);
    }
  }

  function setConfig(cfg) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  }

  function buildGasUrl(cfg, params, extra) {
    const base = String(cfg.GAS_URL || '').replace(/\/$/, '');
    if (!base) throw new Error('Chưa cấu hình GAS URL');
    const all = Object.assign({}, params, extra || {});
    const qs = Object.keys(all).map(function (k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(String(all[k]));
    }).join('&');
    return base + (base.indexOf('?') >= 0 ? '&' : '?') + qs;
  }

  function isFetchNetworkError(err) {
    if (!err) return false;
    const msg = String(err.message || err);
    return err.name === 'TypeError' || msg.indexOf('Failed to fetch') >= 0
      || msg.indexOf('NetworkError') >= 0 || msg.indexOf('Load failed') >= 0;
  }

  /** JSONP — gọi GAS từ GitHub Pages (fetch thường bị CORS). */
  function gasJsonp(cfg, params, timeoutMs) {
    return new Promise(function (resolve, reject) {
      const cbName = 'tntGasCb_' + Date.now();
      let script = null;
      const url = buildGasUrl(cfg, params, { callback: cbName });
      const limit = timeoutMs || 300000;

      const timer = setTimeout(function () {
        cleanup();
        reject(new Error('API timeout — sheet lớn, đợi 1–3 phút rồi bấm Làm mới lại'));
      }, limit);

      function cleanup() {
        clearTimeout(timer);
        try { delete window[cbName]; } catch (e) { window[cbName] = undefined; }
        if (script && script.parentNode) script.parentNode.removeChild(script);
      }

      window[cbName] = function (data) {
        cleanup();
        resolve(data);
      };

      script = document.createElement('script');
      script.charset = 'UTF-8';
      script.src = url;
      script.onerror = function () {
        cleanup();
        reject(new Error('Failed to fetch — kiểm tra GAS URL và deploy Web App (Anyone)'));
      };
      document.head.appendChild(script);
    });
  }

  async function gasFetch(cfg, params, timeoutMs) {
    const url = buildGasUrl(cfg, params);
    const limit = timeoutMs || 120000;
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(function () { ctrl.abort(); }, limit) : null;
    try {
      const res = await fetch(url, { method: 'GET', redirect: 'follow', credentials: 'omit', signal: ctrl ? ctrl.signal : undefined });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw new Error('API timeout — sheet lớn, đợi 1–3 phút rồi bấm Làm mới lại');
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function gasRequest(cfg, params, opts) {
    const timeoutMs = (opts && opts.timeout) || 120000;
    try {
      return await gasFetch(cfg, params, timeoutMs);
    } catch (fetchErr) {
      if (!isFetchNetworkError(fetchErr)) throw fetchErr;
      return gasJsonp(cfg, params, Math.max(timeoutMs, 300000));
    }
  }

  function gasApi(cfg, params, timeoutMs) {
    return gasRequest(cfg, params, { timeout: timeoutMs || 300000 });
  }

  function fmtNum(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    return Math.round(n).toLocaleString('vi-VN');
  }

  function fmtPct(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    return (Math.round(n * 10) / 10).toLocaleString('vi-VN') + '%';
  }

  function valClass(pct, target, higherIsBetter) {
    if (!pct && pct !== 0) return 'prov-neutral';
    const gap = higherIsBetter ? target - pct : pct - target;
    if (gap <= 0) return 'prov-good';
    if (gap <= 8) return 'prov-warn';
    return 'prov-bad';
  }

  function setStatus(text, type) {
    const el = document.getElementById('live-status');
    if (!el) return;
    el.textContent = text;
    el.className = 'link-action live-status' + (type ? ' live-' + type : '');
  }

  function toast(msg, ok) {
    let t = document.getElementById('live-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'live-toast';
      t.className = 'live-toast';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.className = 'live-toast on ' + (ok ? 'ok' : 'err');
    setTimeout(function () { t.className = 'live-toast'; }, 3500);
  }

  function updateKpiCard(id, kpi, opts) {
    const card = document.getElementById(id);
    if (!card || !kpi) return;

    const valEl = card.querySelector('.kpi-value');
    const trendEl = card.querySelector('.kpi-trend');

    if (valEl) {
      valEl.textContent = opts.isCount ? fmtNum(kpi.value) : fmtPct(kpi.value);
    }

    card.classList.remove('kpi-good', 'kpi-warn', 'kpi-bad', 'kpi-neutral');
    card.classList.add('kpi-' + (kpi.status || 'neutral'));

    if (trendEl && kpi.trend && kpi.trend.text) {
      trendEl.textContent = kpi.trend.text;
      trendEl.className = 'kpi-trend ' + (kpi.trend.cls || '');
      trendEl.style.display = '';
    } else if (trendEl) {
      trendEl.style.display = 'none';
    }
  }

  function updateProvinces(provinces) {
    const grid = document.getElementById('prov-grid-live');
    if (!grid || !provinces) return;

    grid.innerHTML = provinces.map(function (p) {
      const ganCls = valClass(p.ganGiao, 95, true);
      const gtcCls = valClass(p.gtc, 80, true);
      return (
        '<div class="prov-card" data-province="' + p.name + '">' +
          '<div class="prov-head">' +
            '<span class="prov-dot"></span>' +
            '<span class="prov-name">' + p.name + '</span>' +
            '<span class="prov-badge ' + p.badgeCls + '">' + p.badge + '</span>' +
          '</div>' +
          '<div class="prov-body">' +
            '<div class="prov-row"><span class="prov-key">Sản lượng (Vol)</span><span class="prov-val">' + fmtNum(p.vol) + '</span></div>' +
            '<div class="prov-row"><span class="prov-key">% Gán giao</span><span class="prov-val ' + ganCls + '">' + fmtPct(p.ganGiao) + '</span></div>' +
            '<div class="prov-row"><span class="prov-key">% GTC Tổng</span><span class="prov-val ' + gtcCls + '">' + fmtPct(p.gtc) + '</span></div>' +
            '<div class="prov-row"><span class="prov-key">Rớt LC</span><span class="prov-val prov-warn">' + fmtNum(p.rotLC) + ' đơn</span></div>' +
          '</div>' +
        '</div>'
      );
    }).join('');
  }

  function updateAlerts(alerts) {
    const box = document.getElementById('alert-list-live');
    if (!box) return;
    if (!alerts || !alerts.length) {
      box.innerHTML = '<div class="alert-item">✅ Không có cảnh báo nghiêm trọng trong ngày.</div>';
      return;
    }
    box.innerHTML = alerts.map(function (a) {
      return '<div class="alert-item"><strong>⚠️ ' + a.title + '</strong> — ' + a.body + '</div>';
    }).join('');
  }

  function pillHtml(pct, target, higherIsBetter) {
    if (pct === null || pct === undefined || isNaN(pct)) return '—';
    const gap = higherIsBetter ? target - pct : pct - target;
    let cls = 'pill-good';
    if (gap > 5) cls = 'pill-bad';
    else if (gap > 0) cls = 'pill-warn';
    return '<span class="pill ' + cls + '">' + fmtPct(pct) + '</span>';
  }

  function getChartInstance(id) {
    const el = document.getElementById(id);
    if (!el || typeof Chart === 'undefined') return null;
    if (Chart.getChart) return Chart.getChart(el);
    return (window.__tntCharts__ && window.__tntCharts__[id]) || null;
  }

  function updateChart(id, cfg) {
    const el = document.getElementById(id);
    if (!el || typeof Chart === 'undefined') return;
    const isBar = cfg.type === 'bar';
    const existing = getChartInstance(id);
    if (existing) {
      existing.data.labels = cfg.labels;
      existing.data.datasets = cfg.datasets;
      existing.update();
      return;
    }
    const chart = new Chart(el, {
      type: cfg.type || 'line',
      data: { labels: cfg.labels, datasets: cfg.datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom', display: !isBar } },
        scales: { y: { beginAtZero: isBar, title: { display: true, text: cfg.y_label || '' } } },
      },
    });
    window.__tntCharts__ = window.__tntCharts__ || {};
    window.__tntCharts__[id] = chart;
  }

  function rotPillHtml(count) {
    if (count === null || count === undefined || isNaN(count)) return '—';
    let cls = 'pill-good';
    if (count >= 2000) cls = 'pill-bad';
    else if (count >= 500) cls = 'pill-warn';
    return '<span class="pill ' + cls + '">' + fmtNum(count) + '</span>';
  }

  function metricAnchor_(data, m) {
    return (m && m.anchorDay) ? m.anchorDay : (data.anchorDate || '');
  }

  function updateMetricPctTab(opts) {
    const sec = document.getElementById(opts.sectionId);
    if (!sec || !opts.kpi) return;
    const k = opts.kpi;
    const m = opts.metrics;
    const target = k.target || opts.defaultTarget || 0;
    const higher = opts.higherIsBetter !== false;
    const day = metricAnchor_(opts.data, m);

    const big = sec.querySelector('.big-card');
    if (big) {
      const valEl = big.querySelector('.big-value');
      const subEl = big.querySelector('.big-sub');
      const tgtEl = big.querySelector('.big-target');
      if (valEl) valEl.textContent = (k.value !== null && k.value !== undefined) ? fmtPct(k.value) : '—';
      if (subEl) subEl.textContent = opts.subtitle + day;
      if (tgtEl) {
        const gap = (k.value !== null && k.value !== undefined) ? (higher ? target - k.value : k.value - target) : null;
        if (gap !== null && gap <= 0) {
          tgtEl.textContent = '▲ Đạt mục tiêu ' + target + '%';
          tgtEl.className = 'big-target good';
        } else if (gap !== null) {
          tgtEl.textContent = '▼ ' + Math.abs(gap).toFixed(1) + ' điểm so với mục tiêu ' + target + '%';
          tgtEl.className = 'big-target ' + (gap <= 5 ? 'warn' : 'bad');
        } else {
          tgtEl.textContent = 'Mục tiêu ' + target + '%';
          tgtEl.className = 'big-target';
        }
      }
      big.className = 'big-card big-' + (k.status || 'neutral');
    }

    if (m && m.provinces && opts.tbodyId) {
      const tbody = document.getElementById(opts.tbodyId);
      if (tbody) {
        tbody.innerHTML = m.provinces.map(function (p) {
          const val = p[opts.valueField];
          return '<tr><td class="province-name">' + p.name + '</td>'
            + '<td class="num">' + fmtNum(p.vol) + '</td>'
            + '<td class="num">' + pillHtml(val, target, higher) + '</td></tr>';
        }).join('');
      }
    }

    if (m && m.trend7d && m.trend7d.length && opts.chartId) {
      updateChart(opts.chartId, {
        labels: m.trend7d.map(function (d) { return d.label; }),
        datasets: [
          {
            label: opts.chartLabel,
            data: m.trend7d.map(function (d) { return d.value; }),
            borderColor: opts.chartColor || '#FF6C0A',
            backgroundColor: opts.chartFill || 'rgba(255,108,10,0.1)',
            borderWidth: 3,
            fill: true,
            tension: 0.3,
            pointRadius: 5,
            pointBackgroundColor: opts.chartColor || '#FF6C0A',
          },
          {
            label: 'Mục tiêu ' + target + '%',
            data: m.trend7d.map(function () { return target; }),
            borderColor: '#94A3B8',
            borderDash: [5, 5],
            borderWidth: 2,
            pointRadius: 0,
            fill: false,
          },
        ],
        y_label: '%',
      });
    }
  }

  function updateMetricGanGiao(data) {
    updateMetricPctTab({
      data: data,
      sectionId: 'metric-gan_giao',
      kpi: data.kpis && data.kpis.ganGiao,
      metrics: data.metrics && data.metrics.ganGiao,
      defaultTarget: 95,
      subtitle: 'Tỷ lệ đơn được gán shipper / Volume · ngày ',
      tbodyId: 'gan-prov-tbody',
      valueField: 'gan',
      chartId: 'chart_gan_giao',
      chartLabel: '% Gán giao',
    });
  }

  function updateMetricGtc(data) {
    updateMetricPctTab({
      data: data,
      sectionId: 'metric-gtc',
      kpi: data.kpis && data.kpis.gtc,
      metrics: data.metrics && data.metrics.gtc,
      defaultTarget: 80,
      subtitle: 'Số đơn Giao Thành Công / Volume · ngày ',
      tbodyId: 'gtc-prov-tbody',
      valueField: 'gtc',
      chartId: 'chart_gtc',
      chartLabel: '% GTC',
    });
  }

  function updateMetricOdr(data) {
    updateMetricPctTab({
      data: data,
      sectionId: 'metric-odr',
      kpi: data.kpis && data.kpis.odr,
      metrics: data.metrics && data.metrics.odr,
      defaultTarget: 95,
      subtitle: 'ODR TTS — Giao đúng hạn · ngày ',
      tbodyId: 'odr-prov-tbody',
      valueField: 'odr',
      chartId: 'chart_odr',
      chartLabel: 'ODR TTS',
    });
  }

  function updateMetricFd(data) {
    const sec = document.getElementById('metric-fd');
    if (!sec || !data.kpis) return;
    const k = data.kpis.fd;
    const m = data.metrics && data.metrics.fd;
    const target = k.target || 5;

    const big = sec.querySelector('.big-card');
    if (big) {
      const valEl = big.querySelector('.big-value');
      const subEl = big.querySelector('.big-sub');
      const tgtEl = big.querySelector('.big-target');
      if (valEl) valEl.textContent = (k.value !== null && k.value !== undefined) ? fmtPct(k.value) : '—';
      if (subEl) subEl.textContent = 'Tỷ lệ %Return trung bình các BC ngày ' + metricAnchor_(data, m);
      if (tgtEl) {
        const gap = (k.value !== null && k.value !== undefined) ? (k.value - target) : null;
        if (gap !== null && gap <= 0) {
          tgtEl.textContent = '▲ ' + Math.abs(gap).toFixed(1) + ' điểm so với mục tiêu ' + target + '%';
          tgtEl.className = 'big-target good';
        } else if (gap !== null) {
          tgtEl.textContent = '▼ ' + gap.toFixed(1) + ' điểm so với mục tiêu ' + target + '%';
          tgtEl.className = 'big-target ' + (gap <= 3 ? 'warn' : 'bad');
        } else {
          tgtEl.textContent = 'Mục tiêu ' + target + '%';
          tgtEl.className = 'big-target';
        }
      }
      big.className = 'big-card big-' + (k.status || 'neutral');
    }

    if (m && m.provinces) {
      const tbody = document.getElementById('fd-prov-tbody') || sec.querySelector('.metric-grid table tbody');
      if (tbody) {
        tbody.innerHTML = m.provinces.map(function (p) {
          return '<tr><td class="province-name">' + p.name + '</td>'
            + '<td class="num">' + fmtNum(p.vol) + '</td>'
            + '<td class="num">' + pillHtml(p.fd, target, false) + '</td></tr>';
        }).join('');
      }
    }

    if (m && m.trend7d && m.trend7d.length) {
      updateChart('chart_fd', {
        labels: m.trend7d.map(function (d) { return d.label; }),
        datasets: [
          {
            label: 'FD — %Return',
            data: m.trend7d.map(function (d) { return d.value; }),
            borderColor: '#EF4444',
            backgroundColor: 'rgba(239,68,68,0.1)',
            borderWidth: 3,
            fill: true,
            tension: 0.3,
            pointRadius: 5,
            pointBackgroundColor: '#EF4444',
          },
          {
            label: 'Mục tiêu ' + target + '%',
            data: m.trend7d.map(function () { return target; }),
            borderColor: '#94A3B8',
            borderDash: [5, 5],
            borderWidth: 2,
            pointRadius: 0,
            fill: false,
          },
        ],
        y_label: '%',
      });
    }
  }

  function updateMetricRotLc(data) {
    const sec = document.getElementById('metric-rot_lc');
    if (!sec || !data.kpis) return;
    const k = data.kpis.rotLC;
    const m = data.metrics && data.metrics.rotLc;

    const big = sec.querySelector('.big-card');
    if (big) {
      const valEl = big.querySelector('.big-value');
      const subEl = big.querySelector('.big-sub');
      if (valEl) valEl.textContent = (k.value !== null && k.value !== undefined) ? fmtNum(k.value) : '—';
      if (subEl) subEl.textContent = 'Số đơn không lấy được trong ngày ' + metricAnchor_(data, m) + ' (Volume − vol_ltc)';
      big.className = 'big-card big-' + (k.status || 'neutral');
    }

    if (m && m.provinces) {
      const tbody = document.getElementById('rot-lc-prov-tbody') || sec.querySelector('.metric-grid table tbody');
      if (tbody) {
        tbody.innerHTML = m.provinces.map(function (p) {
          return '<tr><td class="province-name">' + p.name + '</td>'
            + '<td class="num">' + fmtNum(p.vol) + '</td>'
            + '<td class="num">' + rotPillHtml(p.rot) + '</td></tr>';
        }).join('');
      }
    }

    if (m && m.trend7d && m.trend7d.length) {
      updateChart('chart_rot_lc', {
        labels: m.trend7d.map(function (d) { return d.label; }),
        datasets: [
          {
            label: 'Rớt LC — Đơn lấy không thành công',
            data: m.trend7d.map(function (d) { return d.value; }),
            borderColor: '#F59E0B',
            backgroundColor: 'rgba(245,158,11,0.1)',
            borderWidth: 3,
            fill: true,
            tension: 0.3,
            pointRadius: 5,
            pointBackgroundColor: '#F59E0B',
          },
        ],
        y_label: 'đơn',
      });
    }
  }

  function updateMetricOpr(data) {
    const sec = document.getElementById('metric-opr');
    if (!sec || !data.kpis) return;
    const k = data.kpis.opr;
    const m = data.metrics && data.metrics.opr;
    const target = k.target || 95;

    const big = sec.querySelector('.big-card');
    if (big) {
      const valEl = big.querySelector('.big-value');
      const subEl = big.querySelector('.big-sub');
      const tgtEl = big.querySelector('.big-target');
      if (valEl) valEl.textContent = (k.value !== null && k.value !== undefined) ? fmtPct(k.value) : '—';
      if (subEl) subEl.textContent = 'OPR TTS — Lấy đúng hạn · ngày ' + metricAnchor_(data, m);
      if (tgtEl) {
        const gap = (k.value !== null && k.value !== undefined) ? (target - k.value) : null;
        if (gap !== null && gap <= 0) {
          tgtEl.textContent = '▲ Đạt mục tiêu ' + target + '%';
          tgtEl.className = 'big-target good';
        } else if (gap !== null) {
          tgtEl.textContent = '▼ ' + gap.toFixed(1) + ' điểm so với mục tiêu ' + target + '%';
          tgtEl.className = 'big-target ' + (gap <= 5 ? 'warn' : 'bad');
        } else {
          tgtEl.textContent = 'Mục tiêu ' + target + '%';
          tgtEl.className = 'big-target';
        }
      }
      big.className = 'big-card big-' + (k.status || 'neutral');
    }

    if (m && m.provinces) {
      const tbody = document.getElementById('opr-prov-tbody') || sec.querySelector('.metric-grid table tbody');
      if (tbody) {
        tbody.innerHTML = m.provinces.map(function (p) {
          return '<tr><td class="province-name">' + p.name + '</td>'
            + '<td class="num">' + fmtNum(p.vol) + '</td>'
            + '<td class="num">' + pillHtml(p.opr, target, true) + '</td></tr>';
        }).join('');
      }
    }

    if (m && m.trend7d && m.trend7d.length) {
      const labels = m.trend7d.map(function (d) { return d.label; });
      const values = m.trend7d.map(function (d) { return d.value; });
      updateChart('chart_opr', {
        labels: labels,
        datasets: [
          {
            label: 'OPR TTS — Lấy đúng hạn',
            data: values,
            borderColor: '#FF6C0A',
            backgroundColor: 'rgba(255,108,10,0.1)',
            borderWidth: 3,
            fill: true,
            tension: 0.3,
            pointRadius: 5,
            pointBackgroundColor: '#FF6C0A',
          },
          {
            label: 'Mục tiêu ' + target + '%',
            data: values.map(function () { return target; }),
            borderColor: '#94A3B8',
            borderDash: [5, 5],
            borderWidth: 2,
            pointRadius: 0,
            fill: false,
          },
        ],
        y_label: '%',
      });
    }
  }

  function applyDashboard(data) {
    liveData = data;

    const heroDate = document.getElementById('hero-date');
    if (heroDate) heroDate.textContent = data.anchorDate;

    const genTime = document.getElementById('gen-time');
    if (genTime) genTime.textContent = 'Cập nhật lúc ' + data.generatedAt;

    const k = data.kpis;
    updateKpiCard('kpi-gan-giao', k.ganGiao, {});
    updateKpiCard('kpi-gtc', k.gtc, {});
    updateKpiCard('kpi-odr', k.odr, {});
    updateKpiCard('kpi-opr', k.opr, {});
    updateKpiCard('kpi-fd', k.fd, {});
    updateKpiCard('kpi-rot-lc', k.rotLC, { isCount: true });

    updateProvinces(data.provinces);
    updateAlerts(data.alerts);
    updateMetricGanGiao(data);
    updateMetricGtc(data);
    updateMetricOdr(data);
    updateMetricOpr(data);
    updateMetricFd(data);
    updateMetricRotLc(data);

    window.__liveData__ = data;
  }

  function getAuthToken() {
    return authToken || localStorage.getItem(AUTH_TOKEN_KEY) || '';
  }

  function showAuthError(msg) {
    const el = document.getElementById('tnt-auth-err');
    if (!el) return;
    el.style.display = 'block';
    el.innerHTML = msg;
  }

  function clearAuthError() {
    const el = document.getElementById('tnt-auth-err');
    if (el) { el.style.display = 'none'; el.innerHTML = ''; }
  }

  function lockReport() {
    document.body.classList.add('tnt-locked');
    const bar = document.getElementById('tnt-session-bar');
    if (bar) bar.classList.remove('on');
  }

  function unlockReport(email) {
    authEmail = email;
    document.body.classList.remove('tnt-locked');
    const bar = document.getElementById('tnt-session-bar');
    const emailEl = document.getElementById('tnt-user-email');
    if (bar) bar.classList.add('on');
    if (emailEl) emailEl.textContent = email;
    clearAuthError();
  }

  function saveSession(token, email) {
    authToken = token;
    authEmail = email;
    localStorage.setItem(AUTH_TOKEN_KEY, token);
    localStorage.setItem(AUTH_EMAIL_KEY, email);
  }

  function clearSession() {
    authToken = null;
    authEmail = null;
    localStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(AUTH_EMAIL_KEY);
  }

  async function verifyToken(cfg, token) {
    return gasRequest(cfg, { action: 'verify', auth_token: token }, { timeout: 30000 });
  }

  function saveAuthGasUrl() {
    const inp = document.getElementById('auth-gas-url');
    const url = inp ? inp.value.trim() : '';
    if (!url || url.indexOf('script.google.com') < 0) {
      showAuthError('Nhập đúng URL Web App (script.google.com/macros/s/.../exec)');
      return false;
    }
    const cfg = getConfig();
    cfg.GAS_URL = url;
    setConfig(cfg);
    const setup = document.getElementById('auth-gas-setup');
    if (setup) setup.style.display = 'none';
    clearAuthError();
    return true;
  }

  function login() {
    clearAuthError();
    const cfg = getConfig();
    if (!cfg.GAS_URL) {
      const setup = document.getElementById('auth-gas-setup');
      if (setup) setup.style.display = 'block';
      showAuthError('<strong>Chưa có URL API.</strong> Dán GAS Web App URL vào ô bên dưới, bấm <em>Lưu URL</em>, rồi đăng nhập lại.');
      return;
    }
    if (getGoogleClientId() && window.google && window.google.accounts && window.google.accounts.id) {
      window.google.accounts.id.initialize({
        client_id: getGoogleClientId(),
        callback: handleGoogleCredential,
        ux_mode: 'popup',
      });
      window.google.accounts.id.prompt();
      return;
    }
    showAuthError('<strong>Thiếu GOOGLE_CLIENT_ID</strong> trong <code>TNT_CONFIG</code> trên trang báo cáo.');
  }

  function logout() {
    clearSession();
    lockReport();
    window.location.hash = '';
    window.location.reload();
  }

  function parseAuthHash() {
    const hash = window.location.hash.slice(1);
    if (!hash) return null;
    const p = new URLSearchParams(hash);
    if (p.get('tnt_deny')) {
      return { deny: p.get('tnt_deny') };
    }
    if (p.get('tnt_ok') && p.get('tnt_tok')) {
      return { ok: p.get('tnt_ok'), token: p.get('tnt_tok') };
    }
    return null;
  }

  async function ensureAuth() {
    const cfg = getConfig();
    if (!cfg.GAS_URL) {
      lockReport();
      showAuthError('Báo cáo chưa được cấu hình GAS URL. Vui lòng liên hệ quản trị.');
      return false;
    }

    const fromHash = parseAuthHash();
    if (fromHash && fromHash.deny) {
      history.replaceState(null, '', window.location.pathname + window.location.search);
      clearSession();
      lockReport();
      if (fromHash.deny === 'no_email') {
        showAuthError('<strong>Không xác thực được email Google.</strong><br>Admin cần cấu hình <code>GOOGLE_CLIENT_ID</code> trong GAS và deploy <strong>New version</strong>. Sau đó bấm <em>Đăng nhập Google</em> lại.');
      } else {
        showAuthError('Bạn chưa được cấp quyền, hãy liên hệ admin');
      }
      return false;
    }

    if (fromHash && fromHash.ok && fromHash.token) {
      history.replaceState(null, '', window.location.pathname + window.location.search);
      saveSession(fromHash.token, fromHash.ok);
      unlockReport(fromHash.ok);
      return true;
    }

    const saved = localStorage.getItem(AUTH_TOKEN_KEY);
    const savedEmail = localStorage.getItem(AUTH_EMAIL_KEY);
    if (saved) {
      try {
        const v = await verifyToken(cfg, saved);
        if (v.ok && v.auth) {
          saveSession(saved, v.email || savedEmail);
          unlockReport(v.email || savedEmail);
          return true;
        }
      } catch (e) { /* fall through */ }
      clearSession();
    }

    lockReport();
    return false;
  }

  async function fetchDashboard(cfg) {
    const json = await gasRequest(cfg, {
      action: 'daily_dashboard',
      auth_token: getAuthToken(),
      _: Date.now(),
    }, { timeout: 300000 });
    if (!json.ok) {
      if (json.auth === false) {
        clearSession();
        lockReport();
        showAuthError(json.error || 'Phiên hết hạn — đăng nhập lại');
      }
      throw new Error(json.error || 'API trả về lỗi');
    }
    return json.data;
  }

  async function refreshData() {
    const cfg = getConfig();
    if (!cfg.GAS_URL) {
      setStatus('⚠️ Chưa cấu hình GAS URL', 'warn');
      openSettings();
      return;
    }

    const btn = document.getElementById('btn-refresh');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Đang tải...'; }
    setStatus('⏳ Đang đọc sheet (1–3 phút nếu lần đầu)...', '');

    try {
      const data = await fetchDashboard(cfg);
      applyDashboard(data);
      setStatus('✅ Dữ liệu mới — ' + data.generatedAt, 'ok');
      toast('Đã cập nhật dữ liệu từ Google Sheet', true);
    } catch (err) {
      setStatus('❌ ' + err.message, 'err');
      toast('Lỗi: ' + err.message, false);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '🔄 Làm mới dữ liệu'; }
    }
  }

  function buildTelegramMessage(data) {
    const d = data || liveData || window.__liveData__;
    if (!d) return '';

    const k = d.kpis;
    let msg = '📊 <b>BÁO CÁO VẬN HÀNH TNT</b>\n';
    msg += '📅 Ngày: <b>' + d.anchorDate + '</b>\n';
    msg += '⏰ ' + d.generatedAt + '\n\n';

    msg += '🎯 <b>CHỈ SỐ TỔNG QUAN</b>\n';
    msg += '• % Gán giao: <b>' + fmtPct(k.ganGiao.value) + '</b> (MT ' + k.ganGiao.target + '%)\n';
    msg += '• % GTC: <b>' + fmtPct(k.gtc.value) + '</b> (MT ' + k.gtc.target + '%)\n';
    msg += '• ODR TTS: <b>' + fmtPct(k.odr.value) + '</b> (MT ' + k.odr.target + '%)\n';
    msg += '• OPR TTS: <b>' + (k.opr.value ? fmtPct(k.opr.value) : '—') + '</b>\n';
    msg += '• FD %Return: <b>' + fmtPct(k.fd.value) + '</b> (MT ≤' + k.fd.target + '%)\n';
    msg += '• Rớt LC: <b>' + fmtNum(k.rotLC.value) + ' đơn</b>\n';
    msg += '• Tồn đọng: <b>' + fmtNum(k.aging.total) + '</b> (' + k.aging.over10 + ' đơn >10 ngày)\n';
    msg += '• Chưa gán >48h: <b>' + fmtNum(k.h48.over48) + '</b> / ' + fmtNum(k.h48.total) + '\n\n';

    if (d.alerts && d.alerts.length) {
      msg += '🚨 <b>CẢNH BÁO</b>\n';
      d.alerts.forEach(function (a) {
        msg += '⚠️ ' + a.title + '\n';
      });
      msg += '\n';
    }

    msg += '📍 <b>6 TỈNH</b>\n';
    (d.provinces || []).forEach(function (p) {
      msg += '• ' + p.name + ': Gán ' + fmtPct(p.ganGiao) + ' | GTC ' + fmtPct(p.gtc) + ' | Rớt ' + fmtNum(p.rotLC) + '\n';
    });

    msg += '\n<i>— Dashboard TNT · GHN</i>';
    return msg;
  }

  function openTelegramModal() {
    const data = liveData || window.__liveData__;
    if (!data) {
      toast('Hãy làm mới dữ liệu trước khi gửi Telegram', false);
      return;
    }
    document.getElementById('tg-message').value = buildTelegramMessage(data);
    document.getElementById('tg-modal').classList.add('show');
  }

  function closeTelegramModal() {
    document.getElementById('tg-modal').classList.remove('show');
  }

  async function sendTelegram() {
    const cfg = getConfig();
    const text = document.getElementById('tg-message').value.trim();
    if (!text) return;

    const btn = document.getElementById('btn-send-tg');
    btn.disabled = true;
    btn.textContent = '⏳ Đang gửi...';

    try {
      if (cfg.GAS_URL) {
        const json = await gasApi(cfg, {
          action: 'telegram',
          auth_token: getAuthToken(),
          text: text,
          token: cfg.TG_BOT_TOKEN,
          chat_id: cfg.TG_CHAT_ID,
        });
        if (json.ok || json.success) {
          toast('✅ Đã gửi Telegram thành công', true);
          closeTelegramModal();
          return;
        }
      }

      if (cfg.TG_BOT_TOKEN && cfg.TG_CHAT_ID) {
        const res = await fetch('https://api.telegram.org/bot' + cfg.TG_BOT_TOKEN + '/sendMessage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: cfg.TG_CHAT_ID, text: text, parse_mode: 'HTML' }),
        });
        const json = await res.json();
        if (json.ok) {
          toast('✅ Đã gửi Telegram thành công', true);
          closeTelegramModal();
        } else {
          throw new Error(json.description || 'Telegram error');
        }
      } else {
        throw new Error('Chưa cấu hình Bot Token / Chat ID');
      }
    } catch (err) {
      toast('❌ ' + err.message, false);
    } finally {
      btn.disabled = false;
      btn.textContent = '📨 Gửi ngay';
    }
  }

  function openSettings() {
    const cfg = getConfig();
    document.getElementById('cfg-gas-url').value = cfg.GAS_URL || '';
    document.getElementById('cfg-tg-token').value = cfg.TG_BOT_TOKEN || '';
    document.getElementById('cfg-tg-chat').value = cfg.TG_CHAT_ID || '';
    document.getElementById('settings-modal').classList.add('show');
  }

  function closeSettings() {
    document.getElementById('settings-modal').classList.remove('show');
  }

  function saveSettings() {
    const cfg = {
      GAS_URL: document.getElementById('cfg-gas-url').value.trim(),
      TG_BOT_TOKEN: document.getElementById('cfg-tg-token').value.trim(),
      TG_CHAT_ID: document.getElementById('cfg-tg-chat').value.trim(),
    };
    setConfig(cfg);
    closeSettings();
    toast('Đã lưu cấu hình', true);
    if (cfg.GAS_URL) refreshData();
  }

  function setupAuthUI() {
    const loginBtn = document.getElementById('btn-google-login');
    const gsiWrap = document.getElementById('google-signin-wrap');
    const saveGasBtn = document.getElementById('btn-save-gas-auth');
    const gasInp = document.getElementById('auth-gas-url');
    const cfg = getConfig();

    if (gasInp && cfg.GAS_URL) gasInp.value = cfg.GAS_URL;

    if (!cfg.GAS_URL) {
      const setup = document.getElementById('auth-gas-setup');
      if (setup) setup.style.display = 'block';
      showAuthError('<strong>Lần đầu cấu hình:</strong> Dán GAS Web App URL bên dưới → <em>Lưu URL</em> → <em>Đăng nhập Google</em>.');
    }

    if (initGoogleSignIn(gsiWrap)) {
      if (loginBtn) loginBtn.style.display = 'none';
    } else if (loginBtn) {
      if (gsiWrap) gsiWrap.style.display = 'none';
      loginBtn.addEventListener('click', login);
    }
    if (saveGasBtn) {
      saveGasBtn.addEventListener('click', function () {
        if (saveAuthGasUrl()) toast('Đã lưu URL API — bấm Đăng nhập Google', true);
      });
    }
    if (gasInp) {
      gasInp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          if (saveAuthGasUrl()) login();
        }
      });
    }

    const logoutBtn = document.querySelector('#tnt-session-bar .btn-logout');
    if (logoutBtn) logoutBtn.addEventListener('click', logout);
  }

  async function init() {
    setupAuthUI();
    const authed = await ensureAuth();
    if (!authed) return;

    const cfg = getConfig();
    if (cfg.GAS_URL) {
      setTimeout(refreshData, 500);
    } else {
      setStatus('⚙️ Bấm Cài đặt để kết nối Google Sheet', 'warn');
    }
  }

  window.TNTReport = {
    refreshData: refreshData,
    openSettings: openSettings,
    closeSettings: closeSettings,
    saveSettings: saveSettings,
    openTelegramModal: openTelegramModal,
    closeTelegramModal: closeTelegramModal,
    sendTelegram: sendTelegram,
    buildTelegramMessage: buildTelegramMessage,
    getConfig: getConfig,
    login: login,
    logout: logout,
    saveAuthGasUrl: saveAuthGasUrl,
  };

  document.addEventListener('DOMContentLoaded', init);
})();
