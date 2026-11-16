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

// In-memory log buffer (also persisted to storage for inspection)
const MAX_LOGS = 200;
let logBuffer = [];

async function loadLogs() {
  const data = await chrome.storage.local.get('fpLogs');
  logBuffer = Array.isArray(data.fpLogs) ? data.fpLogs : [];
}

async function fpLog(level, message, data) {
  const entry = {
    time: Date.now(),
    level,
    message,
    data: data ? JSON.stringify(data) : undefined
  };
  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOGS) {
    logBuffer = logBuffer.slice(-MAX_LOGS);
  }
  await chrome.storage.local.set({ fpLogs: logBuffer });
  console.log(`[FP-AR ${level}] ${message}`, data || '');
}

// Load logs on startup
loadLogs();

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
        case 'GET_LOGS':
          sendResponse({ ok: true, logs: logBuffer });
          break;
        case 'CLEAR_LOGS':
          logBuffer = [];
          await chrome.storage.local.set({ fpLogs: [] });
          sendResponse({ ok: true });
          break;
        case 'GET_RAW_ORDERS':
          sendResponse(await getRawOrdersDebug());
          break;
        case 'RESET_COLLECTED':
          await chrome.storage.local.set({ collectedOrders: { clear: [], problem: [] } });
          sendResponse({ ok: true });
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

  await fpLog('INFO', 'checkOrders started');

  // Fetch paid orders — first page
  let allPaidOrders = [];
  let nextContinueId = null;
  let pageCount = 0;
  const MAX_PAGES = 10; // Safety limit

  do {
    const url = nextContinueId
      ? ORDERS_URL + '?state=paid'
      : ORDERS_URL + '?state=paid';
    const result = await fetchFunPayPage(url);

    if (!result.ok) {
      await fpLog('ERROR', 'Failed to fetch orders page', { status: result.status });
      return { ok: false, error: 'Не удалось загрузить заказы. Возможно, Golden Key истёк.' };
    }

    const parsed = parseOrdersListWithPagination(result.html);
    allPaidOrders = allPaidOrders.concat(parsed.orders);
    nextContinueId = parsed.nextOrderId;
    pageCount++;

    await fpLog('INFO', `Parsed page ${pageCount}`, {
      found: parsed.orders.length,
      totalSoFar: allPaidOrders.length,
      nextContinueId: nextContinueId
    });

    // If there's a next page, fetch it via POST with continue parameter
    if (nextContinueId && pageCount < MAX_PAGES) {
      const nextResult = await fetchFunPayPagePost(ORDERS_URL + '?state=paid', nextContinueId);
      if (!nextResult.ok) break;
      const nextParsed = parseOrdersListWithPagination(nextResult.html);
      allPaidOrders = allPaidOrders.concat(nextParsed.orders);
      nextContinueId = nextParsed.nextOrderId;
      pageCount++;
      await fpLog('INFO', `Parsed page ${pageCount} (via continue)`, {
        found: nextParsed.orders.length,
        totalSoFar: allPaidOrders.length,
        nextContinueId: nextContinueId
      });
      // Small delay between page fetches
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } while (nextContinueId && pageCount < MAX_PAGES);

  const paidOrders = allPaidOrders;
  const now = Date.now();
  const HOURS_24 = 24 * 60 * 60 * 1000;

  await fpLog('INFO', 'Total paid orders found', { count: paidOrders.length });

  // Log each order's date and whether it passes 24h filter
  for (const o of paidOrders) {
    const ageHours = o.timestamp ? Math.round((now - o.timestamp) / (60 * 60 * 1000)) : 'unknown';
    await fpLog('DEBUG', `Order #${o.id}`, {
      dateText: o.dateText,
      timestamp: o.timestamp,
      ageHours,
      passes24h: o.timestamp && (now - o.timestamp) >= HOURS_24,
      buyer: o.buyer,
      desc: o.description
    });
  }

  // Collect orders that are older than 24 hours
  const existingIds = new Set([
    ...orders.clear.map(o => o.id),
    ...orders.problem.map(o => o.id)
  ]);

  // Filter to only orders that are 24h+ old and not yet collected
  const newOrdersToCheck = paidOrders.filter(order => {
    if (existingIds.has(order.id)) return false;
    const orderTime = order.timestamp || 0;
    if (orderTime === 0 || (now - orderTime) < HOURS_24) return false;
    return true;
  });

  await fpLog('INFO', 'Orders passing 24h filter', {
    newCandidates: newOrdersToCheck.length,
    alreadyCollected: existingIds.size
  });

  // Process each new order — fetch its individual page to check for problems
  for (const order of newOrdersToCheck) {
    const orderDetails = await fetchOrderDetails(order.id);
    const hasProblem = checkOrderForProblem(order, orderDetails);

    await fpLog('INFO', `Order #${order.id} classified`, {
      hasProblem,
      problemSignals: order.problemSignals,
      chatMsgCount: orderDetails.chatMessages ? orderDetails.chatMessages.length : 0,
      chatMessages: orderDetails.chatMessages.slice(0, 10), // log first 10 messages for debugging
      hasDispute: orderDetails.hasDispute,
      isRefundRequested: orderDetails.isRefundRequested
    });

    if (hasProblem) {
      orders.problem.push({ ...order, ...orderDetails });
    } else {
      orders.clear.push(order);
    }

    existingIds.add(order.id);

    // Wait 2 seconds between order page requests to avoid flood protection
    await new Promise(resolve => setTimeout(resolve, 2000));
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

// ---------- Parse orders from HTML (with pagination support) ----------
function parseOrdersListWithPagination(html) {
  const orders = parseOrdersList(html);

  // Extract next page continue ID (for pagination)
  // FunPay embeds: <input type="hidden" name="continue" value="ORDER_ID">
  let nextOrderId = null;
  const continueMatch = html.match(/<input[^>]*type="hidden"[^>]*name="continue"[^>]*value="([^"]+)"/);
  if (continueMatch) {
    nextOrderId = continueMatch[1];
  }

  return { orders, nextOrderId };
}

// ---------- POST fetch for paginated order list ----------
async function fetchFunPayPagePost(url, continueId) {
  try {
    const formData = new FormData();
    formData.append('continue', continueId);

    const resp = await fetch(url, {
      method: 'POST',
      body: formData,
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
    if (html.includes('content-account-login') || html.includes('login-form')) {
      return { ok: false, status: 401 };
    }

    return { ok: true, html, status: resp.status };
  } catch (err) {
    console.error('[BG] POST fetch error:', err);
    return { ok: false, error: err.message };
  }
}

// ---------- Debug: get raw orders info ----------
async function getRawOrdersDebug() {
  const { goldenKey } = await chrome.storage.local.get('goldenKey');
  if (!goldenKey) return { ok: false, error: 'Не подключено' };

  await setGoldenKeyCookie(goldenKey);

  const result = await fetchFunPayPage(ORDERS_URL + '?state=paid');
  if (!result.ok) return { ok: false, error: 'Fetch failed' };

  const parsed = parseOrdersListWithPagination(result.html);
  const now = Date.now();
  const HOURS_24 = 24 * 60 * 60 * 1000;

  // Build debug summary for each order
  const debugOrders = parsed.orders.map(o => ({
    id: o.id,
    buyer: o.buyer,
    desc: o.description,
    dateText: o.dateText,
    timestamp: o.timestamp,
    ageHours: o.timestamp ? Math.round((now - o.timestamp) / (60 * 60 * 1000)) : null,
    passes24h: o.timestamp ? (now - o.timestamp) >= HOURS_24 : false,
    classes: o.classes,
    status: o.status,
    price: o.price,
    currency: o.currency
  }));

  return {
    ok: true,
    totalOrders: debugOrders.length,
    nextPageId: parsed.nextOrderId,
    orders: debugOrders
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

  // "14 ноября, 20:00" / "14 листопада, 20:00" / "14 November, 20:00"
  const monthNames = {
    // Russian (genitive case used by FunPay)
    'января': 0, 'февраля': 1, 'марта': 2, 'апреля': 3, 'мая': 4, 'июня': 5,
    'июля': 6, 'августа': 7, 'сентября': 8, 'октября': 9, 'ноября': 10, 'декабря': 11,
    // Ukrainian
    'січня': 0, 'лютого': 1, 'березня': 2, 'квітня': 3, 'травня': 4, 'червня': 5,
    'липня': 6, 'серпня': 7, 'вересня': 8, 'жовтня': 9, 'листопада': 10, 'грудня': 11,
    // English full
    'january': 0, 'february': 1, 'march': 2, 'april': 3, 'may': 4, 'june': 5,
    'july': 6, 'august': 7, 'september': 8, 'october': 9, 'november': 10, 'december': 11,
    // English short
    'jan': 0, 'feb': 1, 'mar': 2, 'apr': 3, 'may': 4, 'jun': 5,
    'jul': 6, 'aug': 7, 'sep': 8, 'sept': 8, 'oct': 9, 'nov': 10, 'dec': 11
  };

  const namedMonthMatch = dateText.match(/(\d{1,2})[,\s]+([a-zA-Zа-яА-ЯёЁїЇіІєЄ]+)[,\s]+(\d{1,2}):(\d{2})/i);
  if (namedMonthMatch) {
    const monthName = namedMonthMatch[2].toLowerCase().trim();
    if (monthNames[monthName] !== undefined) {
      const day = parseInt(namedMonthMatch[1]);
      const month = monthNames[monthName];
      const hours = parseInt(namedMonthMatch[3]);
      const minutes = parseInt(namedMonthMatch[4]);

      const d = new Date(now);
      d.setMonth(month);
      d.setDate(day);
      d.setHours(hours, minutes, 0, 0);

      // If this date is in the future (e.g., we parsed November but it's January next year),
      // subtract one year
      if (d.getTime() > now.getTime()) {
        d.setFullYear(d.getFullYear() - 1);
      }

      return d.getTime();
    }
  }

  return 0;
}

// ---------- Fetch individual order details ----------
async function fetchOrderDetails(orderId) {
  // Fetch the order page: funpay.com/orders/<id>/
  // This page contains: order status, chat messages, dispute info
  const result = await fetchFunPayPage(FUNPAY_BASE + '/orders/' + orderId + '/');
  if (!result.ok) {
    return { hasChat: false, hasDispute: false, chatMessages: [], problemSignals: [] };
  }

  const html = result.html;
  const details = {
    hasChat: false,
    hasDispute: false,
    isRefundRequested: false,
    chatMessages: [],
    problemSignals: []
  };

  // 1. Check if there's a chat with messages
  // FunPay order page has chat container: .chat-list or .order-chat
  const chatMsgRegex = /<div[^>]*class="[^"]*chat-message[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
  let chatMatch;
  while ((chatMatch = chatMsgRegex.exec(html)) !== null) {
    const msgText = chatMatch[1].replace(/<[^>]+>/g, '').trim();
    if (msgText) {
      details.chatMessages.push(msgText);
      details.hasChat = true;
    }
  }

  // Alternative: check .msg-item or .trade-chat-message
  if (!details.hasChat) {
    const altMsgRegex = /<div[^>]*class="[^"]*(?:msg-item|trade-chat-message|message-text)[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
    while ((chatMatch = altMsgRegex.exec(html)) !== null) {
      const msgText = chatMatch[1].replace(/<[^>]+>/g, '').trim();
      if (msgText) {
        details.chatMessages.push(msgText);
        details.hasChat = true;
      }
    }
  }

  // 1b. System messages from FunPay (not in regular chat)
  // These are shown as grey/info blocks, e.g.:
  // "Покупатель запросил отмену заказа и возврат средств."
  const systemMsgRegex = /<div[^>]*class="[^"]*(?:system-message|order-system-message|info-message|system)[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
  while ((chatMatch = systemMsgRegex.exec(html)) !== null) {
    const msgText = chatMatch[1].replace(/<[^>]+>/g, '').trim();
    if (msgText) {
      details.chatMessages.push('[SYSTEM] ' + msgText);
      details.hasChat = true;
    }
  }

  // Also try to catch any message with "запросил отмену" / "запросил возврат" / "Refund requested"
  const refundSystemRegex = /<[^>]*>([\s\S]*?(?:запросил(?:\s+отмену|\s+возврат)|запрошен\s+возврат|Refund\s+requested|Order\s+cancellation)[\s\S]*?)<\/[^>]*>/gi;
  while ((chatMatch = refundSystemRegex.exec(html)) !== null) {
    const msgText = chatMatch[1].replace(/<[^>]+>/g, '').trim();
    if (msgText && msgText.length < 500 && !details.chatMessages.includes('[SYSTEM] ' + msgText)) {
      details.chatMessages.push('[SYSTEM] ' + msgText);
      details.hasChat = true;
    }
  }

  // 2. (removed review check — not used)

  // 3. Check for ACTIVE dispute/arbitration on the order page
  // Only flag as dispute if the page shows an OPEN/ACTIVE dispute, not just buttons/links.
  // Real dispute phrases:
  //   "Открыт спор", "Спор открыт", "Открыт арбитраж", "Арбитраж открыт",
  //   "Dispute opened", "Dispute is open", "Arbitration opened",
  //   "рассматривается спор", "идёт арбитраж"
  const activeDisputePatterns = [
    /открыт\s+(?:спор|арбитраж)/i,
    /(?:спор|арбитраж)\s+открыт/i,
    /(?:спор|арбитраж)\s+(?:открылся|начался|ид[ёе]т|в\s+процессе)/i,
    /рассматривается\s+(?:спор|арбитраж)/i,
    /dispute\s+(?:opened?|is\s+open|in\s+progress|pending)/i,
    /arbitration\s+(?:opened?|is\s+open|in\s+progress|pending)/i,
    /claim\s+(?:opened?|submitted|in\s+progress)/i
  ];

  for (const pattern of activeDisputePatterns) {
    if (pattern.test(html)) {
      details.hasDispute = true;
      details.problemSignals.push(`active_dispute`);
      break;
    }
  }

  // 4. Check for ACTIVE refund request (not just "возврат" word anywhere on page)
  // Real refund phrases:
  //   "Запрошен возврат", "Возврат запрошен", "Возврат одобрен", "Refund requested",
  //   "Refund approved", "Refund in progress", "Отмена заказа подтверждена",
  //   "Покупатель запросил отмену заказа и возврат средств"
  const activeRefundPatterns = [
    /запросил\s+(?:отмену|возврат)/i,
    /запрошен\s+(?:возврат|отмена)/i,
    /(?:запрошен|запрашивается|одобрен|в\s+процессе)\s+(?:возврат|отмена)/i,
    /(?:возврат|отмена)\s+(?:запрошен[ао]?|запрашивается|одобрен[ао]?|в\s+процессе)/i,
    /refund\s+(?:requested|approved|in\s+progress|pending)/i,
    /order\s+cancelled/i,
    /cancellation\s+requested/i,
    /отмена\s+заказа\s+подтверждена/i,
    /покупатель\s+запросил/i
  ];

  for (const pattern of activeRefundPatterns) {
    if (pattern.test(html)) {
      details.isRefundRequested = true;
      details.problemSignals.push('refund_requested');
      break;
    }
  }

  // 5. Check for "unread messages" indicator — buyer wrote but seller hasn't responded
  const unreadMatch = html.match(/class="[^"]*unread[^"]*"/);
  if (unreadMatch) {
    details.problemSignals.push('unread_messages');
  }

  return details;
}

// ---------- Check if order has a problem ----------
function checkOrderForProblem(order, details) {
  // A "problem" order is one where:
  // 1. There's a dispute or arbitration open on FunPay
  // 2. The buyer has requested a refund
  // 3. The chat contains complaint/dispute messages from the buyer
  // 4. There are unread messages from the buyer (they wrote something after the order)

  const problemSignals = [];

  // Check dispute/arbitration
  if (details.hasDispute) {
    problemSignals.push('dispute_open');
  }

  // Check refund request
  if (details.isRefundRequested) {
    problemSignals.push('refund_requested');
  }

  // Check chat for complaint messages from buyer
  // Problem keywords in chat messages
  const complaintKeywords = [
    // === Русский — отмена / возврат (все формы) ===
    'отмени', 'отмена', 'отмените', 'отменить', 'отменяй', 'отмени заказ',
    'отмени сделку', 'отмени сделк', 'отменить заказ', 'отменить сделку',
    'верни', 'верните', 'вернуть', 'возврат', 'возмещение', 'возместить',
    'верни деньги', 'верните деньги', 'вернуть деньги', 'верни рубл',
    'верни копей', 'отдай деньги', 'отдайте деньги',
    'расторгнуть', 'расторгни', 'аннулировать', 'аннулируй', 'аннулируйте',
    'откат', 'откатить', 'откатите', 'отмена заказа', 'отмена сделки',
    'давай отменяй', 'отменяй заказ', 'давай возврат',
    // === Русский — не получил товар / нет данных ===
    'где акк', 'где аккаунт', 'где товар', 'где предмет', 'где ключ',
    'где данные', 'где логин', 'где пароль', 'где ник', 'где ссылка',
    'где моя', 'где мой', 'где мои', 'где покупать', 'где покупка',
    'нет акка', 'нет аккаунта', 'нет товара', 'нет ключа', 'нет данных',
    'нет логина', 'нет пароля', 'нет ника', 'нет ссылки', 'нет ничего',
    'нет предмета', 'нет доступа', 'нет файла', 'нет архива',
    'ни акка', 'ни аккаунта', 'ни пароля', 'ни логина', 'ни ника',
    'ни данных', 'ни ключа', 'ни ссылки', 'ни файла',
    'не пришёл', 'не пришел', 'не пришло', 'не пришли', 'не пришли данные',
    'не дали', 'не отдали', 'не выдали', 'не выдал', 'не отправил',
    'не получил', 'не получила', 'не получили', 'не получено',
    'не получилось', 'не досталось', 'не достался',
    'не доставлен', 'не доставлено', 'не пришёл товар', 'не пришёл акк',
    'сам акк', 'сам аккаунт', 'сам товар', 'сам ключ', 'сам предмет',
    'собственно акк', 'собственно аккаунт', 'собственно товар',
    'когда будет', 'когда дашь', 'когда дадите', 'когда пришлёте',
    'когда пришлете', 'когда отправите', 'когда выдадите',
    'жду', 'жду акк', 'жду аккаунт', 'жду товар', 'жду ключ',
    'долго', 'долго жду', 'сколько можно', 'когда уже',
    // === Русский — претензии к товару / качеству ===
    'не работает', 'не подошёл', 'не подошел', 'не подходит', 'не тот', 'не то',
    'не тот товар', 'не тот аккаунт', 'не та учетка', 'не та учётка',
    'не та почта', 'не тот сервер', 'не тот регион', 'не тот уровень',
    'не тот ранг', 'не тот ранг', 'не тот статус',
    'несоответствие', 'несоответствует', 'некачественный', 'некачественно',
    'брак', 'брадик', 'бред', 'бредик', 'бредятина',
    'дерьмо', 'говно', 'хлам', 'фуфло', 'туфта', 'подделка',
    'дай норм', 'норм акк', 'нормальный акк', 'норм товар',
    'дай нормальный', 'дай другой', 'давай другой', 'замени',
    'замени акк', 'замените аккаунт', 'дайте другой',
    'не такой', 'не такая', 'другой надо', 'другой нужен',
    'не как в описании', 'не как на скрине', 'не как на скриншоте',
    'не соответствует описанию', 'описание не соответствует',
    'не то что обещали', 'не то что описано', 'не то что на фото',
    'в descripiton', 'не то что в описании',
    'обман', 'мошенничество', 'кинул', 'кинули', 'обманул', 'обманули',
    'надулал', 'надули', 'развод', 'развели', 'развод на деньги',
    'мошенник', 'кидала', 'скамер', 'скам', 'скаммер',
    'мошенница', 'обманщ', 'жулик', 'аферист',
    'проблема', 'проблем', 'не доволен', 'недоволен', 'не нравится',
    'не устраивает', 'не устраивает меня', 'не понрав',
    'что это', 'что за', 'это что', 'что за бред', 'что за хрень',
    'как это', 'зачем', 'почему так', 'почему не',
    'ужас', 'кошмар', 'отстой', 'отстоем', 'хрень', 'хрень полная',
    'мусор', 'бесполезный', 'бесполезно', 'никакой', 'никуда не годится',
    'не годится', 'не год', 'пустышка', 'пустой',
    // === Русский — аккаунт/данные не работают ===
    'аккаунт не работает', 'аккаунт заблокирован', 'аккаунт удалён',
    'аккаунт удален', 'аккаунт занят', 'аккаунт чужой', 'аккаунт не мой',
    'данные не подходят', 'пароль не подходит', 'логин не подходит',
    'не подходит пароль', 'не подходит логин', 'не подходят данные',
    'восстановил аккаунт', 'сменил пароль', 'поменял пароль',
    'аккаунт взломали', 'аккаунт украли', 'аккаунт вернули',
    'не могу войти', 'не могу зайти', 'не могу зайти в аккаунт',
    'не могу залогиниться', 'не могу войти в аккаунт',
    'почта не работает', 'почта заблокирована', 'почта не подошла',
    'код не приходит', 'код не пришёл', 'смс не приходит',
    'двухфакторка', '2fa', 'верификация не прошла',
    // === Русский — файлы/ключи ===
    'не могу скачать', 'файл не работает', 'файл повреждён',
    'файл поврежден', 'файл битый', 'файл сломан', 'файл пустой',
    'архив повреждён', 'архив поврежден', 'архив битый', 'архив не открывается',
    'не открывается', 'ключ не работает', 'ключ использован',
    'ключ активирован', 'ключ уже', 'ключ истёк', 'ключ истек',
    'промокод не работает', 'код не работает', 'код невалидный',
    'код истёк', 'код истек', 'код уже использован',
    // === Русский — жалобы / угрозы / арбитраж ===
    'жалоба', 'претензия', 'заявление', 'обращение',
    'буду жаловаться', 'подам жалобу', 'обжалование', 'обжалую',
    'поддержка', 'администрация', 'модератор', 'поддержку',
    'напишу в поддержку', 'уже написал в поддержку', 'обратился в поддержку',
    'обращусь в поддержку', 'обращусь к администрации',
    'обращусь к модераторам', 'жду ответа поддержки',
    'подам в суд', 'заявлю в полицию', 'заявлю в киберполицию',
    'открою спор', 'открою диспут', 'открою арбитраж',
    'открою диспут', 'открою дело', 'открою кейс',
    'спор', 'диспут', 'арбитраж', 'разбирательство',
    // === Русский — эмоции / недовольство (короткие) ===
    'плохо', 'отвратительно', 'ужасно', 'кошмарно', 'негодно',
    'не ок', 'не окей', 'не гуд', 'фейл', 'провал',
    'верни', 'отдай', 'дай назад', 'забери',
    // === English — cancellation/refund ===
    'cancel', 'cancellation', 'cancel order', 'cancel the order', 'cancel this',
    'cancel it', 'cancel please', 'cancel now', 'cancelled', 'canceling',
    'refund', 'refund please', 'give me my money back', 'return my money',
    'money back', 'requesting a refund', 'i want a refund', 'want refund',
    'refund me', 'refund my money', 'send money back', 'pay me back',
    'reimburse', 'reimbursement', 'chargeback', 'dispute charge',
    // === English — didn't receive ===
    'where is my', 'where is the', 'where account', 'where is account',
    'where\'s my', 'wheres my', 'where my', 'where are my',
    'didn\'t receive', 'did not receive', 'haven\'t received', 'not received',
    'no account', 'no login', 'no password', 'no key', 'no item', 'no link',
    'nothing received', 'got nothing', 'empty', 'no data',
    'missing', 'didn\'t get', 'did not get', 'never got', 'haven\'t got',
    'no credentials', 'no details', 'no access', 'no file', 'no download',
    'still waiting', 'waiting for', 'been waiting', 'how long',
    'when will i get', 'when do i get', 'when will you send',
    'give me the account', 'give me the item', 'give me the key',
    // === English — item complaints ===
    'not working', 'broken', 'not the right', 'wrong item',
    'wrong account', 'not as described', 'not as pictured',
    'does not match', 'doesn\'t match', 'doesnt match', 'not matching',
    'defective', 'damaged', 'corrupted', 'trash', 'garbage', 'shit', 'crap',
    'give me normal', 'normal account', 'normal item', 'fix this', 'fix it',
    'replace', 'replacement', 'give me another', 'give me different',
    'wrong region', 'wrong server', 'wrong level', 'wrong rank',
    'not what i ordered', 'not what was promised', 'not what described',
    'not the same', 'different item', 'different account',
    // === English — scam/fraud ===
    'scam', 'scammer', 'scamming', 'fraud', 'fraudulent', 'fake',
    'cheated', 'ripped off', 'ripoff', 'rip off', 'ripping off',
    'deceived', 'misleading', 'liar', 'thief', 'steal', 'stolen',
    'con', 'con artist', 'hustle', 'swindle',
    // === English — dissatisfaction ===
    'not satisfied', 'unhappy', 'disappointed', 'terrible',
    'awful', 'worst', 'horrible', 'useless', 'bad', 'bad item',
    'very bad', 'so bad', 'too bad', 'not good', 'not happy',
    'furious', 'angry', 'upset', 'frustrated', 'annoyed',
    'what is this', 'what the', 'wtf', 'wth', 'seriously',
    'are you kidding', 'this is wrong', 'this is bad',
    // === English — account/file issues ===
    'account blocked', 'account suspended', 'account deleted', 'account banned',
    'account recovered', 'account taken back', 'account stolen',
    'changed password', 'password changed', 'credentials don\'t work',
    'credentials dont work', 'password doesn\'t work', 'password doesnt work',
    'login doesn\'t work', 'login doesnt work', 'wrong password', 'wrong login',
    'can\'t login', 'can\'t log in', 'cant login', 'cant log in',
    'can\'t download', 'cant download', 'download failed',
    'file corrupted', 'archive corrupted', 'file damaged', 'file broken',
    'key used', 'key already', 'key expired', 'code expired',
    'code already used', 'code invalid', 'code not working',
    '2fa enabled', 'two factor', 'verification failed',
    // === English — complaints/threats ===
    'complaint', 'claim', 'dispute', 'will report', 'reporting you',
    'report you', 'reported you', 'contacting support', 'contact support',
    'already contacted support', 'opening a dispute', 'open a dispute',
    'opened a dispute', 'admin', 'moderator', 'support team',
    'legal action', 'sue', 'lawsuit', 'police', 'cyber police',
    // === Транслит / смесь ===
    'skam', 'skammer', 'obman', 'kinul', 'kinili',
    'ne rabotaet', 'ne tot', 'ne poluchil', 'ne prishel',
    'verni dengi', 'otmeni', 'otmena', 'vozvrat',
    'gde akk', 'gde acc', 'gde account', 'gde tovar',
    'brak', 'bred', 'dermo', 'govno', 'hlam',
    // === Эмодзи-индикаторы (если в чате) ===
    '😡', '🤬', '🤥', '👎', '💔', '⚠️', '❌'
  ];

  for (const msg of details.chatMessages) {
    const msgLower = msg.toLowerCase();
    for (const kw of complaintKeywords) {
      if (msgLower.includes(kw)) {
        problemSignals.push(`chat_complaint: "${kw}"`);
        break;
      }
    }
  }

  // Also check the order status text from the list page
  const statusKeywords = [
    'спор', 'dispute', 'возврат', 'refund', 'арбитраж', 'arbitration',
    'претензия', 'claim', 'жалоба', 'complaint'
  ];
  const statusLower = (order.status || '').toLowerCase();
  for (const kw of statusKeywords) {
    if (statusLower.includes(kw)) {
      problemSignals.push(`status: ${kw}`);
    }
  }

  // Store the signals on the order for reference
  order.problemSignals = problemSignals;

  // If ANY problem signal found → it's a problem order
  return problemSignals.length > 0;
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

  // В теле заявки указываем ТОЛЬКО номера заказов.
  // Описание товара, покупатель, дата и сумма поддержке не нужны —
  // по номеру заказа они всё найдут сами.
  const bodyHtml =
    `<p>Здравствуйте! Прошу подтвердить заказы, по которым прошло более 24 часов с момента оплаты.</p>` +
    `<p><br></p>` +
    `<p><strong>Заказы без проблем (покупатель просто забыл подтвердить):</strong></p>` +
    `<p>${clearList || 'нет'}</p>` +
    `<p><br></p>` +
    `<p><strong>Заказы с проблемами (прошло 24 часа, есть претензии/спор/возврат):</strong></p>` +
    `<p>${problemList}</p>`;

  return {
    nick,
    firstNum: firstClear || firstProblem,
    clearOrders: orders.clear.map(o => ({ num: o.id })),
    problemOrders: orders.problem.map(o => ({ num: o.id })),
    total: orders.clear.length + orders.problem.length,
    bodyHtml,
    previewText: `Заказы без проблем: ${clearList || 'нет'}\n\nЗаказы с проблемами: ${problemList}`
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
