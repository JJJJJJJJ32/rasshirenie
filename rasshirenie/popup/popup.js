// ===== FunPay Auto-Confirm Extension — Popup Logic =====

// ---------- DOM helpers ----------
function $(id) {
  return document.getElementById(id);
}

function showScreen(name) {
  ['setup-screen', 'loading-screen', 'main-screen'].forEach(s => {
    $(s).classList.add('hidden');
  });
  $(name).classList.remove('hidden');
}

function showError(msg, el) {
  const target = el || $('setup-error');
  target.textContent = msg;
  target.classList.remove('hidden');
}

function hideError(el) {
  const target = el || $('setup-error');
  target.classList.add('hidden');
}

// ---------- Init ----------
document.addEventListener('DOMContentLoaded', async () => {
  // Help modal
  $('how-to-get').addEventListener('click', () => {
    $('help-modal').classList.remove('hidden');
  });
  $('help-close').addEventListener('click', () => {
    $('help-modal').classList.add('hidden');
  });
  $('help-modal').addEventListener('click', (e) => {
    if (e.target === $('help-modal')) {
      $('help-modal').classList.add('hidden');
    }
  });

  // Connect button
  $('connect-btn').addEventListener('click', handleConnect);

  // Main screen buttons
  $('check-now-btn').addEventListener('click', handleCheckNow);
  $('send-ticket-btn').addEventListener('click', handleSendTicket);
  $('disconnect-btn').addEventListener('click', handleDisconnect);

  // Debug & Logs
  $('debug-btn').addEventListener('click', handleDebug);
  $('debug-close').addEventListener('click', () => $('debug-modal').classList.add('hidden'));
  $('debug-modal').addEventListener('click', (e) => {
    if (e.target === $('debug-modal')) $('debug-modal').classList.add('hidden');
  });
  $('logs-btn').addEventListener('click', handleLogs);
  $('logs-close').addEventListener('click', () => $('logs-modal').classList.add('hidden'));
  $('logs-modal').addEventListener('click', (e) => {
    if (e.target === $('logs-modal')) $('logs-modal').classList.add('hidden');
  });
  $('clear-logs-btn').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'CLEAR_LOGS' });
    $('logs-content').innerHTML = '<em>Логи очищены</em>';
  });
  $('reset-btn').addEventListener('click', async () => {
    await chrome.storage.local.set({ collectedOrders: { clear: [], problem: [] } });
    $('stat-clear').textContent = '0';
    $('stat-problem').textContent = '0';
    showNotification('Сброс', 'Собранные заказы очищены. Следующая проверка начнёт заново.');
  });

  // Settings change listeners
  $('threshold').addEventListener('change', saveSettings);
  $('check-interval').addEventListener('change', saveSettings);
  $('auto-send').addEventListener('change', saveSettings);

  // Check if already connected
  await checkConnection();
});

// ---------- Connection ----------
async function checkConnection() {
  const { goldenKey, userInfo } = await chrome.storage.local.get(['goldenKey', 'userInfo']);

  if (goldenKey && userInfo) {
    // Already connected — verify key is still valid
    showScreen('loading-screen');
    $('loading-text').textContent = 'Проверка подключения...';

    try {
      const resp = await chrome.runtime.sendMessage({ type: 'VERIFY_CONNECTION' });
      if (resp && resp.ok) {
        showMainScreen();
      } else {
        // Key expired — show setup
        showScreen('setup-screen');
        showError('Сессия истекла. Введите Golden Key заново.');
      }
    } catch (err) {
      showScreen('setup-screen');
    }
  } else {
    showScreen('setup-screen');
  }
}

async function handleConnect() {
  const key = $('golden-key').value.trim();
  hideError();

  if (!key) {
    showError('Введите Golden Key');
    return;
  }

  showScreen('loading-screen');
  $('loading-text').textContent = 'Подключение к FunPay...';

  try {
    const resp = await chrome.runtime.sendMessage({ type: 'CONNECT', goldenKey: key });
    if (resp && resp.ok) {
      showMainScreen();
    } else {
      showScreen('setup-screen');
      showError(resp && resp.error ? resp.error : 'Не удалось подключиться. Проверьте Golden Key.');
    }
  } catch (err) {
    showScreen('setup-screen');
    showError('Ошибка: ' + (err.message || 'неизвестная'));
  }
}

async function handleDisconnect() {
  await chrome.storage.local.remove(['goldenKey', 'userInfo', 'collectedOrders', 'ticketPayload']);
  $('golden-key').value = '';
  showScreen('setup-screen');
}

// ---------- Main screen ----------
async function showMainScreen() {
  showScreen('main-screen');
  hideError($('main-error'));

  const { userInfo, settings, collectedOrders, lastCheck } = await chrome.storage.local.get([
    'userInfo', 'settings', 'collectedOrders', 'lastCheck'
  ]);

  // User info
  if (userInfo) {
    $('username-display').textContent = userInfo.username || 'Пользователь';
  }

  // Settings
  const s = settings || {};
  $('threshold').value = s.threshold || 10;
  $('check-interval').value = s.checkInterval || 30;
  $('auto-send').checked = s.autoSend !== false;

  // Stats
  const orders = collectedOrders || { clear: [], problem: [] };
  $('stat-clear').textContent = orders.clear.length;
  $('stat-problem').textContent = orders.problem.length;

  // Last check
  if (lastCheck) {
    const d = new Date(lastCheck);
    $('last-check').classList.remove('hidden');
    $('last-check').innerHTML = `<span class="check-time">Последняя проверка:</span> ${d.toLocaleString('ru-RU')}`;
  }
}

async function saveSettings() {
  const settings = {
    threshold: parseInt($('threshold').value) || 10,
    checkInterval: parseInt($('check-interval').value) || 30,
    autoSend: $('auto-send').checked
  };
  await chrome.storage.local.set({ settings });

  // Notify background to reschedule alarm
  chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', settings });
}

// ---------- Actions ----------
async function handleCheckNow() {
  $('check-now-btn').disabled = true;
  $('check-now-btn').textContent = 'Проверка...';
  hideError($('main-error'));

  try {
    const resp = await chrome.runtime.sendMessage({ type: 'CHECK_ORDERS_NOW' });
    if (resp && resp.ok) {
      // Update stats
      const orders = resp.orders || { clear: [], problem: [] };
      $('stat-clear').textContent = orders.clear.length;
      $('stat-problem').textContent = orders.problem.length;

      if (resp.lastCheck) {
        const d = new Date(resp.lastCheck);
        $('last-check').classList.remove('hidden');
        $('last-check').innerHTML = `<span class="check-time">Последняя проверка:</span> ${d.toLocaleString('ru-RU')}`;
      }

      // Auto-send if threshold reached
      if (resp.autoSendTriggered) {
        showNotification('Лимит достигнут', 'Заявка автоматически отправляется в техподдержку...');
      } else {
        const total = orders.clear.length + orders.problem.length;
        showNotification('Проверка завершена', `Собрано заказов: ${total}`);
      }
    } else {
      showError(resp && resp.error || 'Ошибка при проверке', $('main-error'));
    }
  } catch (err) {
    showError('Ошибка: ' + (err.message || 'неизвестная'), $('main-error'));
  } finally {
    $('check-now-btn').disabled = false;
    $('check-now-btn').textContent = 'Проверить сейчас';
  }
}

async function handleSendTicket() {
  const { collectedOrders } = await chrome.storage.local.get('collectedOrders');
  const orders = collectedOrders || { clear: [], problem: [] };
  const total = orders.clear.length + orders.problem.length;

  if (total === 0) {
    showError('Нет собранных заказов для отправки', $('main-error'));
    return;
  }

  $('send-ticket-btn').disabled = true;
  $('send-ticket-btn').textContent = 'Отправка...';

  try {
    const resp = await chrome.runtime.sendMessage({ type: 'SEND_TICKET' });
    if (resp && resp.ok) {
      showNotification('Заявка отправлена', 'Заявка в техподдержку успешно создана');
      // Clear collected orders after sending
      $('stat-clear').textContent = '0';
      $('stat-problem').textContent = '0';
    } else {
      showError(resp && resp.error || 'Ошибка при отправке', $('main-error'));
    }
  } catch (err) {
    showError('Ошибка: ' + (err.message || 'неизвестная'), $('main-error'));
  } finally {
    $('send-ticket-btn').disabled = false;
    $('send-ticket-btn').textContent = 'Отправить заявку';
  }
}

function showNotification(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    title: title,
    message: message
  });
}

// ---------- Logs ----------
async function handleLogs() {
  const resp = await chrome.runtime.sendMessage({ type: 'GET_LOGS' });
  const content = $('logs-content');
  if (!resp || !resp.logs || resp.logs.length === 0) {
    content.innerHTML = '<em>Логов нет</em>';
  } else {
    content.innerHTML = resp.logs.map(entry => {
      const d = new Date(entry.time);
      const timeStr = d.toLocaleTimeString('ru-RU');
      const dataStr = entry.data ? `<div class="log-data">${entry.data}</div>` : '';
      return `<div class="log-entry">
        <span class="log-time">[${timeStr}]</span>
        <span class="log-level-${entry.level}">${entry.level}</span>
        ${entry.message}
        ${dataStr}
      </div>`;
    }).join('');
    // Scroll to bottom
    content.scrollTop = content.scrollHeight;
  }
  $('logs-modal').classList.remove('hidden');
}

// ---------- Debug ----------
async function handleDebug() {
  const content = $('debug-content');
  content.textContent = 'Загрузка...';
  $('debug-modal').classList.remove('hidden');

  const resp = await chrome.runtime.sendMessage({ type: 'GET_RAW_ORDERS' });
  if (!resp || !resp.ok) {
    content.innerHTML = `<em style="color:#e74c3c">Ошибка: ${resp ? resp.error : 'нет ответа'}</em>`;
    return;
  }

  let html = `<div style="margin-bottom:10px;color:#e8b339;">
    Всего заказов: ${resp.totalOrders} | След. страница: ${resp.nextPageId || 'нет'}
  </div>`;

  if (resp.orders.length === 0) {
    html += '<em>Заказы не найдены. Возможно, Golden Key истёк или нет оплаченных заказов.</em>';
  } else {
    for (const o of resp.orders) {
      const ageStr = o.ageHours !== null ? `${o.ageHours}ч` : 'неизвестно';
      const passClass = o.passes24h ? 'debug-pass' : 'debug-fail';
      const passStr = o.passes24h ? '✓ 24ч+' : `✗ ${ageStr}`;
      html += `<div class="debug-order">
        <span class="debug-id">#${o.id}</span> | ${o.buyer} | ${o.desc}
        <span class="${passClass}">${passStr}</span><br>
        дата: "${o.dateText}" | ts: ${o.timestamp} | класс: ${o.classes} | статус: ${o.status}
      </div>`;
    }
  }

  content.innerHTML = html;
}
