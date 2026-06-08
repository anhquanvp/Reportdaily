/**
 * TNT Daily Report — Live data refresh & Telegram
 * Đọc dữ liệu từ GAS API (sheet Data TNT) và cập nhật KPI trên báo cáo.
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'tnt_daily_report_cfg';
  const DEFAULT_CFG = {
    GAS_URL: '',
    TG_BOT_TOKEN: '',
    TG_CHAT_ID: '',
  };

  let liveData = null;

  function getConfig() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved ? Object.assign({}, DEFAULT_CFG, JSON.parse(saved)) : Object.assign({}, DEFAULT_CFG);
    } catch (e) {
      return Object.assign({}, DEFAULT_CFG);
    }
  }

  function setConfig(cfg) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
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

    window.__liveData__ = data;
  }

  async function fetchDashboard(cfg) {
    const base = cfg.GAS_URL.replace(/\/$/, '');
    const url = base + (base.indexOf('?') >= 0 ? '&' : '?') + 'action=daily_dashboard&_=' + Date.now();
    const res = await fetch(url);
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || 'API trả về lỗi');
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
    setStatus('⏳ Đang đọc dữ liệu từ sheet...', '');

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
        const base = cfg.GAS_URL.replace(/\/$/, '');
        const q = 'action=telegram&text=' + encodeURIComponent(text)
          + '&token=' + encodeURIComponent(cfg.TG_BOT_TOKEN)
          + '&chat_id=' + encodeURIComponent(cfg.TG_CHAT_ID);
        const res = await fetch(base + '?' + q);
        const json = await res.json();
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

  function init() {
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
  };

  document.addEventListener('DOMContentLoaded', init);
})();
