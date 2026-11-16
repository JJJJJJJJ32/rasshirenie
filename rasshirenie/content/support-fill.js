// ===== FunPay Auto-Confirm Extension — Support Form Content Script =====
// Runs on: https://support.funpay.com/tickets/*
// Auto-fills and submits the support ticket form

const TICKET_TTL = 15 * 60 * 1000; // 15 minutes

// ---------- Entry point ----------
(async function() {
  // Check if we have a pending ticket payload
  const urlParams = new URLSearchParams(window.location.search);
  const ticketId = urlParams.get('fp-ar');

  if (!ticketId) return;

  // If we're on a ticket result page (success redirect to /tickets/<number>), notify background
  // Note: /tickets/new/1 is the form page, /tickets/<number> is the result page
  const pathMatch = window.location.pathname.match(/^\/tickets\/(\d+)$/);
  if (pathMatch) {
    // Already submitted — extract ticket number
    chrome.runtime.sendMessage({
      type: 'TICKET_SUBMITTED',
      success: true,
      ticketUrl: window.location.href,
      ticketNumber: pathMatch[1]
    });
    return;
  }

  // Wait for the payload to be available in storage
  let payload = null;
  let attempts = 0;
  while (attempts < 50) {
    const data = await chrome.storage.local.get('ticketPayload');
    payload = data.ticketPayload;
    if (payload && payload.id === ticketId) break;
    await sleep(100);
    attempts++;
  }

  if (!payload || payload.id !== ticketId) {
    console.error('[FP-AR] No pending ticket payload found for id:', ticketId);
    return;
  }

  // Check TTL
  if (Date.now() - payload.createdAt > TICKET_TTL) {
    console.error('[FP-AR] Ticket payload expired');
    chrome.runtime.sendMessage({
      type: 'TICKET_SUBMITTED',
      success: false,
      error: 'Время ожидания истекло. Попробуйте снова.'
    });
    return;
  }

  console.log('[FP-AR] Found pending ticket payload, filling form...');

  // Wait for the form to appear
  const form = await waitForElement('form[name="ticket"]', 15000);
  if (!form) {
    console.error('[FP-AR] Support form not found');
    chrome.runtime.sendMessage({
      type: 'TICKET_SUBMITTED',
      success: false,
      error: 'Форма техподдержки не найдена на странице.'
    });
    return;
  }

  try {
    await fillAndSubmitForm(form, payload);
  } catch (err) {
    console.error('[FP-AR] Error filling form:', err);
    chrome.runtime.sendMessage({
      type: 'TICKET_SUBMITTED',
      success: false,
      error: err.message || 'Ошибка при заполнении формы.'
    });
  }
})();

// ---------- Helpers ----------
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForElement(selector, timeout) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const el = document.querySelector(selector);
    if (el) return el;
    await sleep(200);
  }
  return null;
}

async function fillAndSubmitForm(form, payload) {
  // Field mapping based on FunPay support form structure:
  // ticket[fields][1] — seller nickname
  // ticket[fields][2] — order number
  // ticket[fields][3] — radio: role (1=buyer, 2=seller)
  // ticket[fields][5] — topic/reason dropdown (201 = "buyer forgot to confirm")
  // ticket[comment][body_html] — comment body
  // #ticket_submit — submit button

  // 1. Fill nickname
  const nickInput = document.querySelector('[name="ticket[fields][1]"]');
  if (nickInput) {
    setFieldValue(nickInput, payload.nick || '');
  }

  // 2. Fill first order number
  const orderInput = document.querySelector('[name="ticket[fields][2]"]');
  if (orderInput) {
    setFieldValue(orderInput, payload.firstNum || '');
  }

  // 3. Set role to "Seller" (value="2")
  const sellerRadio = document.querySelector('input[name="ticket[fields][3]"][value="2"]');
  if (sellerRadio) {
    sellerRadio.checked = true;
    sellerRadio.dispatchEvent(new Event('change', { bubbles: true }));
    sellerRadio.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // Wait for dynamic form updates
  await sleep(300);

  // 4. Set topic to "Buyer forgot to confirm" (value="201")
  const reasonSelect = document.querySelector('[name="ticket[fields][5]"]');
  if (reasonSelect) {
    reasonSelect.disabled = false;
    setFieldValue(reasonSelect, '201');
  }

  await sleep(200);

  // 5. Fill the comment body
  const commentTextarea = document.querySelector('[name="ticket[comment][body_html]"]');
  if (commentTextarea) {
    setFieldValue(commentTextarea, payload.bodyHtml || '');
  }

  // Also try to set the plain text version if available
  const plainTextarea = document.querySelector('[name="ticket[comment][body]"]');
  if (plainTextarea) {
    setFieldValue(plainTextarea, payload.previewText || '');
  }

  await sleep(500);

  // 6. Submit the form
  const submitButton = document.querySelector('#ticket_submit, button[name="ticket[submit]"], button[type="submit"]');

  // Update payload status
  const data = await chrome.storage.local.get('ticketPayload');
  if (data.ticketPayload) {
    data.ticketPayload.status = 'submitting';
    data.ticketPayload.submittedAt = Date.now();
    await chrome.storage.local.set({ ticketPayload: data.ticketPayload });
  }

  // Submit
  if (submitButton) {
    form.requestSubmit(submitButton);
  } else {
    form.submit();
  }

  // Wait for redirect to ticket page or error
  await waitForResult();
}

function setFieldValue(element, value) {
  element.value = value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

async function waitForResult() {
  const start = Date.now();
  const timeout = 30000; // 30 seconds

  while (Date.now() - start < timeout) {
    await sleep(500);

    // Check for success redirect (e.g., /tickets/12345)
    const pathMatch = window.location.pathname.match(/^\/tickets\/(\d+)$/);
    if (pathMatch) {
      chrome.runtime.sendMessage({
        type: 'TICKET_SUBMITTED',
        success: true,
        ticketUrl: window.location.href,
        ticketNumber: pathMatch[1]
      });
      return;
    }

    // Check for error messages
    const errorSelectors = [
      '.alert-danger',
      '.invalid-feedback',
      '.form-error-message',
      '.error',
      '.toast-body',
      '.alert-error'
    ];

    for (const selector of errorSelectors) {
      const errorEl = document.querySelector(selector);
      if (errorEl && errorEl.offsetParent !== null && errorEl.textContent.trim()) {
        // Wait a bit more to make sure it's a real error, not transient
        await sleep(500);
        const stillThere = document.querySelector(selector);
        if (stillThere && stillThere.textContent.trim()) {
          chrome.runtime.sendMessage({
            type: 'TICKET_SUBMITTED',
            success: false,
            error: stillThere.textContent.trim()
          });
          return;
        }
      }
    }
  }

  // Timeout — might still be processing
  chrome.runtime.sendMessage({
    type: 'TICKET_SUBMITTED',
    success: false,
    error: 'Время ожидания истекло. Проверьте статус заявки вручную.'
  });
}
