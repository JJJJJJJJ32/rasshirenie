// ===== FunPay Auto-Confirm Extension — Background Service Worker =====

const FUNPAY_BASE = 'https://funpay.com';
const ORDERS_URL = FUNPAY_BASE + '/orders/trade';
const SUPPORT_URL = 'https://support.funpay.com/tickets/new/1';
const ALARM_NAME = 'funpay-check-orders';

// Default settings
const DEFAULT_SETTINGS = {
  threshold: 10,
  checkInterval: 30, // minutes
  autoSend: true
};

// ---------- Lifecycle ----------
chrome.runtime.onInstalled.addListener(() => {
  initSettings();
  setupAlarm();
});

chrome.runtime.onStartup.addListener(() => {
  setupAlarm();
});

async function initSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  if (!settings) {
    await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  }
  if (!await chrome.storage.local.get('collectedOrders')) {
    await chrome.storage.local.set({ collectedOrders: { clear: [], problem: [] } });
  }
}

async function setupAlarm() {
  const { settings } = await chrome.storage.local.get('settings');
  const interval = (settings && settings.checkInterval) || DEFAULT_SETTINGS.checkInterval;

  await chrome.alarms.clear(ALARM_NAME);
  chrome.alarms.create(ALARM_NAME, { delayInMinutes: interval, periodInMinutes: interval });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) {
    const { goldenKey } = await chrome.storage.local.get('goldenKey');
    if (goldenKey) {
      await checkOrders();
    }
  }
});

// ---------- Message handler ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case 'CONNECT':
          sendResponse(await handleConnect(msg.goldenKey));
          break;
        case 'VERIFY_CONNECTION':
          sendResponse(await handleVerify());
          break;
        case 'CHECK_ORDERS_NOW':
          sendResponse(await checkOrders());
          break;
        case 'SEND_TICKET':
          sendResponse(await sendTicket());
          break;
        case 'UPDATE_SETTINGS':
          await chrome.storage.local.set({ settings: msg.settings });
          await setupAlarm();
          sendResponse({ ok: true });
          break;
        case 'TICKET_SUBMITTED':
          sendResponse(await handleTicketResult(sender.tab, msg));
          break;
        default:
          sendResponse({ ok: false, error: 'Unknown message type' });
      }
    } catch (err) {
      console.error('[BG] Error:', err);
      sendResponse({ ok: false, error: err.message });
    }
  })();
  return true; // async response
});

// ---------- Connection ----------
async function handleConnect(goldenKey) {
  // Save key
  await chrome.storage.local.set({ goldenKey });

  // Set golden_key cookie for funpay.com
  await setGoldenKeyCookie(goldenKey);

  // Verify by fetching the main page
  const result = await fetchFunPayPage(FUNPAY_BASE + '/');
  if (!result.ok) {
    await chrome.storage.local.remove('goldenKey');
    return { ok: false, error: 'Неверный Golden Key или ошибка соединения' };
  }

  // Parse user info
  const userInfo = parseUserInfo(result.html);
  if (!userInfo) {
    await chrome.storage.local.remove('goldenKey');
    return { ok: false, error: 'Не удалось получить данные пользователя. Проверьте Golden Key.' };
  }

  await chrome.storage.local.set({ userInfo });
  await initSettings();
  await setupAlarm();

  return { ok: true, userInfo };
}

async function handleVerify() {
  const { goldenKey } = await chrome.storage.local.get('goldenKey');
  if (!goldenKey) return { ok: false };

  // Ensure cookie is set
  await setGoldenKeyCookie(goldenKey);

  const result = await fetchFunPayPage(FUNPAY_BASE + '/');
  if (!result.ok) return { ok: false };

  const userInfo = parseUserInfo(result.html);
  if (!userInfo) return { ok: false };

  await chrome.storage.local.set({ userInfo });
  return { ok: true, userInfo };
}

// ---------- HTTP ----------
async function setGoldenKeyCookie(goldenKey) {
  // Set the golden_key cookie via chrome.cookies API
  // This ensures the cookie is sent with fetch requests automatically
  try {
    await chrome.cookies.set({
      url: 'https://funpay.com/',
      name: 'golden_key',
      value: goldenKey,
      domain: '.funpay.com',
      path: '/',
      secure: true,
      httpOnly: false,
      sameSite: 'lax'
    });
  } catch (e) {
    console.warn('[BG] Could not set cookie via chrome.cookies API:', e);
  }
}

async function fetchFunPayPage(url) {
  try {
    const resp = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      redirect: 'follow'
    });

    if (resp.status === 0 || resp.status === 403 || resp.status === 401) {
      return { ok: false, status: resp.status };
    }

    if (resp.status >= 400) {
      return { ok: false, status: resp.status };
    }

    const html = await resp.text();

    // Check if we're still logged in
    if (html.includes('content-account-login') || html.includes('login-form')) {
      return { ok: false, status: 401 };
    }

    return { ok: true, html, status: resp.status };
  } catch (err) {
    console.error('[BG] Fetch error:', err);
    return { ok: false, error: err.message };
  }
}

// ---------- Parse user info ----------
function parseUserInfo(html) {
  try {
    // Extract username from the page
    const nameMatch = html.match(/data-user-name="([^"]+)"/);
    const idMatch = html.match(/data-user-id="(\d+)"/);

    // Alternative: parse from user-link-name div
    let username = null;
    if (nameMatch) {
      username = nameMatch[1];
    } else {
      const userDivMatch = html.match(/class="user-link-name"[^>]*>\s*(?:<[^>]*>)?\s*([^<]+)/);
      if (userDivMatch) {
        username = userDivMatch[1].trim();
      }
    }

    // Try extracting from script tags with app data
    if (!username) {
      const scriptMatch = html.match(/"name"\s*:\s*"([^"]+)"/);
      if (scriptMatch) {
        username = scriptMatch[1];
      }
    }

    const userId = idMatch ? parseInt(idMatch[1]) : null;

    if (username) {
      return { username, id: userId };
    }

    // If we can't parse the username but the page is not a login page, still return basic info
    if (!html.includes('content-account-login')) {
      return { username: 'Пользователь', id: null };
    }

    return null;
  } catch (e) {
    console.error('[BG] Parse user info error:', e);
    return null;
  }
}

// ---------- Order checking ----------
async function checkOrders() {
  const { goldenKey, settings, collectedOrders } = await chrome.storage.local.get([
    'goldenKey', 'settings', 'collectedOrders'
  ]);

  if (!goldenKey) {
    return { ok: false, error: 'Не подключено' };
  }

  // Ensure cookie is set before fetching
  await setGoldenKeyCookie(goldenKey);

  const s = settings || DEFAULT_SETTINGS;
  const orders = collectedOrders || { clear: [], problem: [] };

  // Fetch paid orders
  const result = await fetchFunPayPage(ORDERS_URL + '?state=paid');
  if (!result.ok) {
    return { ok: false, error: 'Не удалось загрузить заказы. Возможно, Golden Key истёк.' };
  }

  // Parse orders from HTML
  const paidOrders = parseOrdersList(result.html);
  const now = Date.now();
  const HOURS_24 = 24 * 60 * 60 * 1000;

  // Collect orders that are older than 24 hours
  const existingIds = new Set([
    ...orders.clear.map(o => o.id),
    ...orders.problem.map(o => o.id)
  ]);

  for (const order of paidOrders) {
    // Skip already collected
    if (existingIds.has(order.id)) continue;

    // Check if 24 hours passed
    const orderTime = order.timestamp || 0;
    if (orderTime === 0 || (now - orderTime) < HOURS_24) continue;

    // Determine if there's a problem with the buyer
    // "Problem" = the order has a dispute indicator or buyer has left negative feedback
    const hasProblem = checkOrderForProblem(order);

    if (hasProblem) {
      orders.problem.push(order);
    } else {
      orders.clear.push(order);
    }

    existingIds.add(order.id);
  }

  const lastCheck = Date.now();
  await chrome.storage.local.set({ collectedOrders: orders, lastCheck });

  // Check if threshold reached
  const total = orders.clear.length + orders.problem.length;
  let autoSendTriggered = false;

  if (s.autoSend && total >= s.threshold) {
    autoSendTriggered = true;
    // Trigger ticket sending
    sendTicket();
  }

  return {
    ok: true,
    orders,
    lastCheck,
    autoSendTriggered
  };
}

// ---------- Parse orders from HTML ----------
function parseOrdersList(html) {
  const orders = [];

  // Use DOMParser via offscreen document or regex parsing
  // Since service workers don't have DOMParser, we use regex

  // Find all tc-item links (order entries)
  const itemRegex = /<a[^>]*class="tc-item[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  let match;

  while ((match = itemRegex.exec(html)) !== null) {
    const itemHtml = match[0] + match[1];

    // Extract order ID
    const orderIdMatch = itemHtml.match(/<div[^>]*class="tc-order"[^>]*>\s*#?\s*([^<]+)/);
    if (!orderIdMatch) continue;
    const orderId = orderIdMatch[1].trim().replace(/^#/, '');

    // Extract status classes
    const classMatch = match[0].match(/class="tc-item\s+([^"]+)"/);
    const classes = classMatch ? classMatch[1] : '';
    const isRefunded = classes.includes('warning');
    const isPaid = classes.includes('info');

    // Only collect paid orders (not refunded, not closed)
    if (!isPaid) continue;

    // Extract description
    const descMatch = itemHtml.match(/<div[^>]*class="order-desc"[^>]*>[\s\S]*?<div[^>]*>\s*([^<]+)/);
    const description = descMatch ? descMatch[1].trim() : '';

    // Extract buyer
    const buyerMatch = itemHtml.match(/<div[^>]*class="media-user-name"[^>]*>[\s\S]*?<span[^>]*>\s*([^<]+)/);
    const buyer = buyerMatch ? buyerMatch[1].trim() : '';

    // Extract buyer ID
    const buyerIdMatch = itemHtml.match(/data-href="https:\/\/funpay\.com\/users\/(\d+)/);
    const buyerId = buyerIdMatch ? buyerIdMatch[1] : '';

    // Extract price
    const priceMatch = itemHtml.match(/<div[^>]*class="tc-price"[^>]*>\s*([\d.,]+)\s*(\w+)/);
    const price = priceMatch ? parseFloat(priceMatch[1].replace(',', '.')) : 0;
    const currency = priceMatch ? priceMatch[2] : '';

    // Extract date
    const dateMatch = itemHtml.match(/<div[^>]*class="tc-date-time"[^>]*>\s*([^<]+)/);
    const dateText = dateMatch ? dateMatch[1].trim() : '';
    const timestamp = parseFunPayDate(dateText);

    // Extract subcategory
    const subcatMatch = itemHtml.match(/<div[^>]*class="text-muted"[^>]*>\s*([^<]+)/);
    const subcategory = subcatMatch ? subcatMatch[1].trim() : '';

    // Check for status indicators (dispute, claims etc.)
    const statusText = itemHtml.match(/<div[^>]*class="tc-status"[^>]*>\s*([^<]+)/);
    const status = statusText ? statusText[1].trim() : '';

    orders.push({
      id: orderId,
      description,
      buyer,
      buyerId,
      price,
      currency,
      dateText,
      timestamp,
      subcategory,
      status,
      classes
    });
  }

  return orders;
}

// ---------- Parse FunPay date ----------
function parseFunPayDate(dateText) {
  if (!dateText) return 0;

  const now = new Date();

  // "сегодня, ЧЧ:ММ" / "today, HH:MM"
  const todayMatch = dateText.match(/(?:сегодня|today|сьогодні)[,\s]+(\d{1,2}):(\d{2})/i);
  if (todayMatch) {
    const d = new Date(now);
    d.setHours(parseInt(todayMatch[1]), parseInt(todayMatch[2]), 0, 0);
    return d.getTime();
  }

  // "вчера, ЧЧ:ММ" / "yesterday, HH:MM"
  const yesterdayMatch = dateText.match(/(?:вчера|yesterday|вчора)[,\s]+(\d{1,2}):(\d{2})/i);
  if (yesterdayMatch) {
    const d = new Date(now);
    d.setDate(d.getDate() - 1);
    d.setHours(parseInt(yesterdayMatch[1]), parseInt(yesterdayMatch[2]), 0, 0);
    return d.getTime();
  }

  // "DD.MM.YYYY, HH:MM"
  const fullMatch = dateText.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})[,\s]+(\d{1,2}):(\d{2})/);
  if (fullMatch) {
    const d = new Date(
      parseInt(fullMatch[3]), // year
      parseInt(fullMatch[2]) - 1, // month (0-indexed)
      parseInt(fullMatch[1]), // day
      parseInt(fullMatch[4]), // hours
      parseInt(fullMatch[5]), // minutes
      0, 0
    );
    return d.getTime();
  }

  // "DD.MM.YY, HH:MM"
  const shortMatch = dateText.match(/(\d{1,2})\.(\d{1,2})\.(\d{2})[,\s]+(\d{1,2}):(\d{2})/);
  if (shortMatch) {
    const d = new Date(
      2000 + parseInt(shortMatch[3]),
      parseInt(shortMatch[2]) - 1,
      parseInt(shortMatch[1]),
      parseInt(shortMatch[4]),
      parseInt(shortMatch[5]),
      0, 0
    );
    return d.getTime();
  }

  // "DD.MM, HH:MM"
  const dayMonthMatch = dateText.match(/(\d{1,2})\.(\d{1,2})[,\s]+(\d{1,2}):(\d{2})/);
  if (dayMonthMatch) {
    const d = new Date(now);
    d.setMonth(parseInt(dayMonthMatch[2]) - 1);
    d.setDate(parseInt(dayMonthMatch[1]));
    d.setHours(parseInt(dayMonthMatch[3]), parseInt(dayMonthMatch[4]), 0, 0);
    return d.getTime();
  }

  return 0;
}

// ---------- Check if order has a problem ----------
function checkOrderForProblem(order) {
  // "Problem" indicators:
  // 1. The order has a dispute/claim marker
  // 2. The status text indicates an issue
  // 3. There are any warning badges

  const problemKeywords = [
    'спор', 'dispute', 'претензия', 'claim',
    'жалоба', 'complaint', 'возврат', 'refund',
    'арбитраж', 'arbitration', 'проблема', 'problem'
  ];

  const statusLower = (order.status || '').toLowerCase();
  const hasProblemKeyword = problemKeywords.some(kw => statusLower.includes(kw));

  // Check for dispute badges in classes
  const hasDisputeClass = order.classes && (
    order.classes.includes('dispute') ||
    order.classes.includes('warning') ||
    order.classes.includes('danger')
  );

  return hasProblemKeyword || hasDisputeClass;
}

// ---------- Send support ticket ----------
async function sendTicket() {
  const { collectedOrders, userInfo } = await chrome.storage.local.get([
    'collectedOrders', 'userInfo'
  ]);

  const orders = collectedOrders || { clear: [], problem: [] };
  const total = orders.clear.length + orders.problem.length;

  if (total === 0) {
    return { ok: false, error: 'Нет заказов для отправки' };
  }

  // Build the ticket payload
  const payload = buildTicketPayload(userInfo, orders);

  // Store payload for the content script to pick up
  const ticketId = 'fp-' + Date.now() + '-' + Math.random().toString(36).substr(2, 8);
  payload.id = ticketId;
  payload.createdAt = Date.now();
  payload.status = 'pending';

  await chrome.storage.local.set({ ticketPayload: payload });

  // Open the support form in a new tab — the content script will auto-fill it
  const supportUrl = SUPPORT_URL + '?fp-ar=' + encodeURIComponent(ticketId);
  await chrome.tabs.create({ url: supportUrl });

  return { ok: true, ticketId };
}

function buildTicketPayload(userInfo, orders) {
  const nick = userInfo ? userInfo.username : '';
  const firstClear = orders.clear.length > 0 ? '#' + orders.clear[0].id : '';
  const firstProblem = orders.problem.length > 0 ? '#' + orders.problem[0].id : (firstClear || '');

  const clearList = orders.clear.map(o => '#' + o.id).join(' ');
  const problemList = orders.problem.length > 0
    ? orders.problem.map(o => '#' + o.id).join(' ')
    : 'нет';

  // Build detailed info for each order
  const clearDetails = orders.clear.map(o =>
    `#${o.id} — ${o.description} (покупатель: ${o.buyer}, дата: ${o.dateText}, сумма: ${o.price} ${o.currency})`
  ).join('\n');

  const problemDetails = orders.problem.map(o =>
    `#${o.id} — ${o.description} (покупатель: ${o.buyer}, дата: ${o.dateText}, сумма: ${o.price} ${o.currency})`
  ).join('\n');

  const bodyHtml =
    `<p>Покупатель забыл подтвердить заказ (без проблем):</p>` +
    `<p>${clearList || 'нет'}</p>` +
    (clearDetails ? `<p><em>${clearDetails}</em></p>` : '') +
    `<p><br></p>` +
    `<p>Заказы с проблемами (прошло 24 часа):</p>` +
    `<p>${problemList}</p>` +
    (problemDetails ? `<p><em>${problemDetails}</em></p>` : '');

  return {
    nick,
    firstNum: firstClear || firstProblem,
    clearOrders: orders.clear.map(o => ({ num: o.id })),
    problemOrders: orders.problem.map(o => ({ num: o.id })),
    total: orders.clear.length + orders.problem.length,
    bodyHtml,
    previewText: `Покупатель забыл подтвердить: ${clearList || 'нет'}\n\nС проблемами: ${problemList}`
  };
}

// ---------- Handle ticket result from content script ----------
async function handleTicketResult(tab, msg) {
  if (msg.success) {
    // Clear collected orders on success
    await chrome.storage.local.set({
      collectedOrders: { clear: [], problem: [] },
      ticketPayload: null
    });

    // Close the support tab
    if (tab && tab.id) {
      chrome.tabs.remove(tab.id).catch(() => {});
    }

    // Show notification
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title: 'Заявка отправлена',
      message: 'Заявка в техподдержку FunPay успешно создана.'
    });

    return { ok: true };
  } else {
    await chrome.storage.local.set({
      ticketPayload: { ...(await chrome.storage.local.get('ticketPayload')).ticketPayload, status: 'error', error: msg.error }
    });

    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title: 'Ошибка отправки',
      message: msg.error || 'Не удалось отправить заявку. Попробуйте вручную.'
    });

    return { ok: false, error: msg.error };
  }
}
